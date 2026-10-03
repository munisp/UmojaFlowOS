# Frontend ↔ Backend alignment audit — UI/UX, PWA, mobile (2026-10-04)

Scope: every tRPC router/procedure must have a reachable UI surface; every UI
call must resolve to a real server procedure; PWA and native-mobile surfaces
accounted for. Method: static extraction of all 11 sub-routers and 279
procedures from `apps/control-plane/server/routers.ts`, cross-referenced
against every `trpc.<router>.<proc>` / `utils.<router>.<proc>` reference in
the 159 client source files.

## Result

| Metric | Before this wave | After |
|---|---|---|
| Server procedures | 279 | 279 |
| Procedures with a client surface | 182 | **279 (100%)** |
| Client calls without a server procedure | 1 | 0 (see note 3) |
| Sub-routers without any UI | 9 (stakeholder, administratorKyc, tradeControl, enterpriseGovernance, controlAssurance, executionRehearsal, ledgerReconciliation, livePipelines, contracts) | **0** |
| Console modules routed in App.tsx | 12 | 12 (Router coverage lives under Operations) |

## Closure mechanism

1. **`RouterCoverageWorkspace.tsx`** (new) — a data-driven coverage console
   listing all 97 procedures that previously had no UI, grouped by router,
   each rendered as an honest thin shell: on-demand queries with an optional
   JSON input, mutations submitting a JSON payload, verbatim server errors,
   role gating that mirrors (never replaces) server-side RBAC. Input hints are
   the actual zod field names extracted from `routers.ts`.
2. **`OperationsCoverageWorkspace.tsx`** — now tabbed: *Operational coverage*
   (existing panels) and *Router coverage* (the new workspace). Reachable via
   the existing Operations module for admin, compliance, treasury, and auditor
   roles (the union of roles any of the 97 procedures permits).
3. **`ai.chat` false positive resolved**: the only client-side reference is a
   doc comment in `AIChatBox.tsx` and a demo markdown string in
   `ComponentShowcase.tsx` (a scaffold page that is not routed in `App.tsx`).
   No live call exists; no `ai` router is implied anywhere reachable. The
   scaffold page remains unrouted by design (documented here so the next audit
   does not re-flag it).

## PWA

The client had **no** PWA support (no manifest, no service worker, no
installability meta). Added:

- `public/manifest.webmanifest` — standalone display, theme color, SVG icons
  (any + maskable), module shortcuts (payments, compliance).
- `public/sw.js` — deliberately narrow service worker: cache-first only for
  the static shell (`/assets`, icons, manifest); `/api` and `/trpc` traffic is
  **never cached** (compliance/payment records must always be live);
  offline navigations get an explicit "control plane unreachable" notice
  rather than stale data.
- `index.html` — manifest link, theme-color, description, apple-touch meta.
- `main.tsx` — production-only service-worker registration whose failure can
  never break the console.

## Native mobile

There is **no native mobile application in this repository** (no
`apps/mobile`, no Capacitor/React Native/Flutter project). The mobile story is
the responsive console plus the lazy-chunk bundle budget
(`perf/slo.yaml → mobile.bundle`, Lighthouse CI) and now PWA installability.
Creating a native shell would be new scope, not an alignment fix; it is
recorded here as an explicit, honest gap rather than silently omitted.

## Reverse direction (backend without frontend)

Closed in the same wave: the 97 procedures listed above were exactly the
backend-without-frontend set. Backend services in Go/Rust/Python are covered
by the `contracts` router panels (parse/assess/validate/reconcile + service
configuration), which now have UI for the first time.

## Verification

- Both new/edited components pass TypeScript syntax transpile (TS 5.9.3).
- Static re-sweep after the change: 279/279 procedures have a client
  reference; 0 client calls resolve to a nonexistent procedure.
- Files hash-verified on the remote branch after push (see PR #45).
