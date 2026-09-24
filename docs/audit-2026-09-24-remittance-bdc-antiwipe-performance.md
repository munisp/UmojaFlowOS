# UmojaFlowOS Deep Audit II — Remittances, BDC, Anti-Wipe, Performance, Toolchains

**Date:** 2026-09-24 · **Method:** static reading + live execution (22 remittance/BDC tests, 8 anti-wipe tests, 17 ML tests, 28 control-plane client tests — all green; bundle budget gate exercised fail-open→fix→fail-closed-pass; Go 1.25.4 / Rust 1.89.0 / TS 5.9.3 / Node 22.14.0 toolchains installed and exercised) · **Posture:** evidence-based, non-aspirational. This is a follow-up to `audit-2026-09-24-deep-audit-ml-stack-integrations-stakeholders.md`.

---

## 1. Remittances & BDC — the gap, exhaustively

### 1.1 Pre-fix state (verified)

`git grep -i "remittance\|bureau de change\|bdc\|imto"` across services/, database/, api/ → **zero domain code**. The platform's payment archetypes are strictly B2B (corridor intents, stablecoin on/off-ramp, settlement sagas). Retail remittance and Bureau-de-Change operations — two of the largest real Nigerian FX flows — had no data model, no state machine, no caps, no regulatory returns.

### 1.2 Unhandled scenarios identified (all now handled)

**Remittance / IMTO:**
1. Per-transaction cap ($10,000) — was nothing to violate; now hard-rejected (`PolicyViolation`).
2. Rolling sender 24h cap ($25,000) — review trigger, not silent pass.
3. Rolling beneficiary 30d cap ($100,000) — review trigger.
4. Cash-pickup channel tighter cap ($2,000) + mandatory beneficiary verification evidence hash — storage-level CHECK too.
5. Bank-credit without bank details / mobile-money without wallet — rejected, and enforced again by migration 0064 CHECK constraints (fail-closed at storage, not just the service).
6. Stale-rate execution — rate locks carry a 900s TTL; consuming an expired lock raises; the DB constraint makes consumed-after-expiry **impossible**, not just unlikely.
7. Structuring (multiple sub-cap sends aggregating over the cap) — signal implemented, tested.
8. Smurfing (many senders → one beneficiary) — signal implemented, tested.
9. ₦5m cash reporting threshold — signal for regulatory reporting preparation.
10. Mid-lifecycle abandonment — explicit state machine (`draft → screening → review_required → approved_for_payout_preparation → payout_evidence_recorded → completed_by_partner`, plus `refunded`/`cancelled`); invalid transitions raise `InvalidTransition`.
11. Review without rationale — `human_review_decision` requires non-trivial rationale; DB requires ≥20 chars; review rows are **immutable** (trigger).
12. Partner finality without payout evidence — ordering enforced by the state machine.
13. Refunds after partner finality — transition graph forbids; refund only from pre-finality states.
14. CBN IMTO daily return — generated with `prepared=True, submitted=False` (the platform prepares; a licensed human submits — boundary preserved).

**Bureau de Change:**
15. Off-board execution — ticket rates outside the published board are rejected (sell above board-sell, buy below board-buy).
16. Spread abuse — board spread ceiling 600bps vs CBN reference, enforced in service **and** by DB CHECK.
17. Band breach — buy/sell must stay within `band_bps` of the CBN reference rate, enforced in service and DB.
18. Stale boards — boards older than 240 minutes cannot back new tickets.
19. Weekly retail FX cap ($5,000/customer/week) — hard rejection.
20. No-ID transactions — 64-char sha256 ID evidence hash mandatory per ticket.
21. Counterfeit currency — `flag_counterfeit` forces `review_required`.
22. Vault shortfall — settlement evidence drives vault positions per operator/branch/currency; negative balance = recorded shortfall + alert (`negative_vault_alert`).
23. BDC daily return — prepared, never auto-submitted (boundary).

### 1.3 What was built

- **`services/remittance-bdc/`** (package `umojaflowos_remittance_bdc`): `domain.py` (state machines, caps in integer minor units — no floats for money), `remittance.py` (engine + AML signals + CBN IMTO return), `bdc.py` (rate boards, tickets, vault, CBN BDC return), `service.py` (FastAPI; every response carries `execution_authority: none`). **22/22 tests green.**
- **`database/postgresql/0064_remittance_bdc.sql`**: 6 tables (orders, rate locks, review decisions, rate boards, tickets, vault positions) with channel-evidence CHECKs, spread/band CHECKs, consumed-before-expiry CHECK, immutability triggers on evidence rows, and RLS tenant isolation on every table — the same house style as the settlement core.

---

## 2. Stakeholders — re-stated (now ≈20 types)

Turn 1 documented **three tiers, ≈16 stakeholder types**. The remittance/BDC build adds four:

**Tier 1 — Operating roles (6, code-enforced):** `admin`, `compliance_officer`, `treasury_operator`, `auditor`, `provider_contact`, `cbn_liaison`. Unchanged.

**Tier 2 — Counterparty/entity stakeholders (11, was 9):** banking partners (5 archetypes), compliance vendors, enterprise customers, liquidity providers, payout PSPs, stablecoin issuers, operators-as-entities, auditor firms, generic counterparties — **plus IMTO/remittance partners** (licensed executors of payout; platform prepares and records evidence only) **and BDC operators** (with branches and vault positions as sub-entities).

**Tier 3 — End customers (3 sub-types, was 1):** retail/corporate KYC subjects — **plus remitters** (senders, CBN KYC tier 1–3 enforced) **and beneficiaries** (recipients; verification evidence mandatory for cash pickup). Both reuse the existing KYC-subject model and consent boundary; no new identity silo was created.

### Onboarding robustness for ALL stakeholders (updated verdicts)

| Stakeholder | Workflow | Robustness |
|---|---|---|
| Counterparties (incl. new IMTO partners, BDC operators) | 6-stage gated lifecycle, DB-enforced stage-gate matching, 2-approval pilot gate, recertification cycles, activity evidence | **Strong** — the strongest workflow in the codebase; new partner types inherit it via the generic counterparty path |
| Internal operators | Keycloak → linked KYC customer record → role grant; fail-safe pending-access queue on partial failure; MFA-claim enforcement | **Strong** |
| External roles (provider_contact, cbn_liaison) | Assignment-gated, whitelisted evidence categories, self-scoped visibility | **Strong but narrow** (correct — evidence exchange only) |
| Auditor firms | 4-phase engagement lifecycle, next-review-due tracking | **Solid** |
| Evidence counterparties (banks, vendors, LPs, PSPs, issuers) | Typed evidence recording with archetypes | **Moderate** — typed/audited but no gated lifecycle |
| End customers / remitters / beneficiaries | Operator-created KYC subjects; document intents → review; consent boundary tests; cash-pickup adds mandatory beneficiary verification evidence | **Moderate** — robust console-mediated; still no self-service funnel (known structural gap from turn 1) |

**Verdict:** the two structural gaps from turn 1 stand — (a) no end-customer self-service onboarding funnel, (b) no agent-network model (matters more now: cash-pickup agents exist as a channel requirement but not as an onboarded stakeholder type). Both are product-scope decisions, not defects; the state machines they would plug into exist.

---

## 3. Anti-wipe filesystem protection — implemented

**`scripts/infra/filesystem_anti_wipe.py`** (stdlib-only, four subcommands):

1. **Hash-chain manifest** (`build`): every protected file sha256-hashed; hashes chained in sorted order — deleting ANY file changes the chain root. Config: **`infra/anti-wipe/protected-paths.json`** (compliance evidence & audit logs: 7-year retention per CBN/NDPA practice; model registry & lakehouse: 1-year; schema migrations; regulatory assurance packs).
2. **Fail-closed verification** (`verify`): detects MISSING (deleted/wiped), MODIFIED (hash mismatch), TRUNCATED (append-only violation), UNRECORDED (new files in immutable classes). Exit 1 on any violation — CI/cron/systemd alert immediately. Append-only classes may legitimately grow (recorded prefix must be intact).
3. **OS-level enforcement** (`enforce`): `chattr +i` (immutable evidence) / `chattr +a` (append-only logs) where supported; portable chmod-read-only baseline everywhere; capability notes recorded, never raises.
4. **Self-protecting audit log** (`audit`): every build/verify appends a hash-chained JSONL event; tampering with history breaks the chain and is detected.

Deployment: **`infra/anti-wipe/systemd/`** (service + 15-min timer) and **`infra/kubernetes/anti-wipe-verification-cronjob.yaml`** (15-min CronJob, readOnly repo mount, non-root, drop ALL capabilities, `backoffLimit: 0` — fail fast, fail closed, 24 failed-job history because a failed verify IS the alert).

**8/8 tests green** (`scripts/infra/test_filesystem_anti_wipe.py`): clean pass, deletion, modification, truncation, append-growth tolerance, unrecorded-file, chain-root sensitivity, audit-log tamper evidence, enforce write-bit stripping.

---

## 4. Performance tuning — implemented (incl. mobile)

**SLOs first:** **`perf/slo.yaml`** defines p50/p99/p999 millisecond budgets for all 10 services, all 11 integrations, and mobile (Web Vitals on Nigerian 3G/4G + bundle budgets). Error-budget policy with fast/slow burn alerts; CI gate: k6 smoke must hold p99 at 50 RPS before merge.

| Layer | Change | File |
|---|---|---|
| PostgreSQL | 9 hot-path indexes: open-saga sweeps, unleased outbox poll (SKIP LOCKED workers stop scanning leased rows), lease-expiry recovery, inbox saga FK, audit timelines, intent queue, attestation queue, health dashboards, CBN daily-return scans | `database/postgresql/0065_performance_hot_path_indexes.sql` |
| PostgreSQL | Engine tuning: shared_buffers 8GB, work_mem 64MB, JIT off (ms OLTP), random_page_cost 1.1 (NVMe), autovacuum tuned for churn-heavy outbox/inbox, pg_stat_statements | `infra/postgres/umojaflowos-tuning.conf` |
| Connection pooling | PgBouncer transaction mode: warm min_pool (cold connects cost 5–15ms), query_wait_timeout 5s (fail fast — a queued query is a missed SLO), prepared statements enabled | `infra/postgres/pgbouncer.ini` |
| Load gates | k6: payment-engine authorize (p99<50ms gate), remittance API mixed flow (p99<80ms gate) | `perf/k6/payment_engine_smoke.js`, `perf/k6/remittance_api.js` |
| **Mobile** | Route-level code splitting (console + enrollment lazy; landing stays eager = first paint); vendor chunk splitting (react/query cached separately); es2020 target; CSS code split | `apps/control-plane/vite.config.ts`, `client/src/App.tsx` |
| **Mobile** | Bundle budget gate, fail-closed: initial ≤170KB gzip, route chunks ≤90KB, total ≤600KB | `apps/control-plane/scripts/check-bundle-budget.mjs` |
| **Mobile** | Lighthouse CI: LCP ≤4s / TBT ≤600ms / CLS ≤0.25 on 4× CPU-throttled mobile preset | `apps/control-plane/lighthouserc.json` |
| Edge | Hashed assets `Cache-Control: immutable, 1y` (repeat mobile visits pay zero JS network cost); HTML shell `no-cache` | `infra/caddy/Caddyfile` |

Budget highlights (p99): payment-engine authorize 50ms, risk screening 40ms, TigerBeetle transfer 5ms, Redis GET 2ms, ML fraud scoring on CPU 50ms, GNN 2-hop 120ms, mobile synchronous API 300ms.

**Fail-closed proof (the gate caught a real violation, and it was fixed):** the first budgeted build **failed the gate** — `Home-*.js` was **833KB minified / 185.9KB gzip** against the 90KB route budget (≈30 eagerly imported workspace/dashboard components). Fixes shipped:

| Fix | Evidence |
|---|---|
| 14 heavy workspaces/dashboards converted to on-demand chunks via a `withChunk()` lazy+Suspense wrapper that **preserves component identifiers** (source-level role/boundary tests keep matching) | `client/src/pages/Home.tsx` |
| **recharts removed entirely** — the trend charts are hand-rolled SVG (null-gap line breaks, hover tooltip, thinned axes — identical evidence semantics, including "a gap is not zero") | `client/src/components/ServiceTrendCharts.tsx`; chunk **107.4KB → 2.9KB gzip** |
| Orphan `client/src/components/ui/chart.tsx` (recharts wrapper, zero importers) deleted; recharts no longer imported anywhere — the chunk evidence below reflects the build output. The `recharts` **declaration** is retained in `package.json`/`pnpm-lock.yaml` deliberately: CI runs `pnpm install --frozen-lockfile`, and lockfile surgery must be regenerated in a full pnpm dev environment (`pnpm install` with pnpm 10.4.1), not hand-edited. Unused declared dependencies cost zero bundle bytes (verified: unimported code is tree-shaken out of every chunk). | documented follow-up |

Post-fix gate output: **Home 48.5KB gzip** (budget 90KB), initial JS **126.1KB** (budget 170KB), total **271.8KB** (budget 600KB) — `node scripts/check-bundle-budget.mjs` → **"bundle budgets ok", exit 0**. Vite production build: **4.39s**. The gate exits 1 on violation (verified directly — an earlier report of exit 0 was a shell pipe artifact, `| tail` masks `$?`).

---

## 5. Compiler toolchains — installed and exercised (verified versions)

| Toolchain | Version (verified) | Proof |
|---|---|---|
| Go | **1.25.4** linux/amd64 (user toolchain dir; module mirror configured) | **`go build ./...` on services/payment-engine → OK**; `go test ./internal/domain/` → ok |
| Rust | **1.89.0** stable (rustup; the pre-provisioned `stable` shim was broken — "rustc component not applicable" — and 1.89.0 was selected explicitly) | **`cargo check --locked` on services/ledger-gateway → Finished (1m15s)**; **`cargo check --locked` on services/risk-compliance-core → Finished (3m36s)** |
| TypeScript | **5.9.3** (project-pinned, devDependency) + 7.0.2 available globally | `tsc --noEmit -p tsconfig.json` on apps/control-plane → **exit 0, zero errors** |
| Node | **22.14.0** required for client tests | See runtime finding below |

**Runtime finding (real, fixed):** the repo's `jsdom@^30` → `undici@8` chain calls `worker_threads.markAsUncloneable`, which **does not exist on Node 20** — every jsdom-based `.test.tsx` suite fails at environment setup on Node 20 (`TypeError: webidl.util.markAsUncloneable is not a function`), reproducible on untouched files (`PublicLanding.test.tsx`). Client tests must run on **Node ≥ 22**; under Node 22.14.0 the full client suite passes (**28/28**). CI should pin `node-version: 22`.

(Sandbox note: proxy.golang.org unreachable from this environment; builds use the goproxy.cn mirror with sum.golang.google.cn checksum DB — recorded here so CI can replicate.)

---

## 6. Orphan code & out-of-scope findings — closed

| Finding | Verdict | Action |
|---|---|---|
| `infra/lakehouse/` (README + env template) not wired to the turn-1 ML lakehouse | **Real orphan — closed** | `MLLakehouse.from_env()` reads `UMOJA_LAKEHOUSE_ROOT`; template extended; fail-closed when `UMOJA_LAKEHOUSE_ENABLED=false`; test added |
| `infra/dapr/` components/subscriptions with no apply path | **Real orphan — closed** | `scripts/infra/apply_dapr_components.sh` (fail-closed if CRDs missing) |
| `infra/geolibre/` (README + env template, zero references) | **Intentional, not orphan** | Documented-disabled boundary pending approved tile source; no action correct |
| `infra/providers/yellowcard-hmac.env.template` | Wired | Referenced by the Caddy webhook route |
| `client/src/components/ui/chart.tsx` recharts wrapper with zero importers | **Real orphan — closed** | File deleted after the SVG chart rewrite; the now-unused `recharts` dependency declaration is retained only because CI enforces `--frozen-lockfile` (lockfile regeneration documented as follow-up) |
| TODO/FIXME/NotImplementedError sweep across services/apps | **Zero hits** | Nothing to close |

---

## 7. Test & verification summary

| Suite | Result |
|---|---|
| services/remittance-bdc | **22/22 green** |
| scripts/infra anti-wipe | **8/8 green** |
| services/ml-intelligence (incl. new from_env test) | **17/17 green** |
| control-plane client tests (Node 22.14.0, incl. rewritten SVG charts) | **28/28 green (7 files)** |
| control-plane `tsc --noEmit` (TS 5.9.3) | **exit 0, zero errors** |
| control-plane `vite build` + bundle budget gate | **4.39s build; budgets ok, exit 0** (was failing: Home 185.9KB gz → 48.5KB gz) |
| payment-engine `go build ./...` + `go test ./internal/domain/` (Go 1.25.4) | **OK** |
| ledger-gateway `cargo check --locked` (Rust 1.89.0) | **Finished — compiles clean** |
| risk-compliance-core `cargo check --locked` (Rust 1.89.0) | **Finished — compiles clean** |
