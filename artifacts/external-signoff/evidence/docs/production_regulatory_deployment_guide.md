# UmojaFlowOS Production and CBN Sandbox Cohort 2 Deployment Guide

**Status:** Engineering implementation guide; regulatory submission remains conditional on authorized evidence and independent approvals.
**Scope:** Restricted staging and controlled-live pilot preparation for the CBN Sandbox Cohort 2 VASP Track.
**Repository:** `munisp/UmojaFlowOS`
**Owner:** Newwave Technologies

## 1. Decision boundary

UmojaFlowOS can be classified as **Technical GO for local and synthetic staging validation** only after the repository checks in this guide pass. It must remain **Regulatory NO-GO** until Newwave’s authorized officers, Nigerian counsel, compliance leadership, and the relevant CBN process have supplied and approved the real legal, governance, financial, operational, and security evidence. Synthetic records, generated identities, local MinIO objects, test provider responses, and dry-run Kubernetes admission results are not regulatory evidence.

> A successful build, passing test suite, or healthy local container stack demonstrates implementation behavior; it does not demonstrate CBN admission, licensing, provider authorization, customer-money safeguarding, or permission to move value.

The production posture is fail-closed. Provider timeouts become `UNKNOWN` and enter durable reconciliation; the system must not retry blindly, settle twice, authorize a secondary rail without the coordinator’s payload binding, or enable value movement by changing one configuration flag. The secure deployment defaults Mojaloop execution to disabled and expects signing material through managed secret references or mounted files rather than raw private keys in environment variables.

## 2. Readiness gates

The release owner should record one evidence bundle per gate. Every artifact must have a SHA-256 digest, creation timestamp, producing commit SHA, environment identifier, operator identity, and an immutable storage location. A gate is **PASS** only when its evidence is independently reviewable and the negative test is included where applicable.

| Gate | Required decision | Technical evidence | Regulatory/operational evidence | Blocking condition |
|---|---|---|---|---|
| G0 | Scope freeze | Signed product-boundary document and release SHA | Counsel-approved description of activities, jurisdictions, assets, and exclusions | Any unapproved custody, exchange, settlement, or customer-money claim |
| G1 | Build integrity | Reproducible build logs, SBOM, image digests, provenance attestation | Release owner and independent reviewer sign-off | Floating image tags or unverifiable artifact provenance |
| G2 | Identity and access | Keycloak realm export, role tests, revocation test, MFA policy evidence | Named accountable officers and segregation-of-duties register | Shared subjects, duplicate approvers, or unrevoked privileged access |
| G3 | Secrets and cryptography | Secret-volume permissions, mTLS canary, signer retry tests, key-rotation record | Key ceremony, HSM or managed signer control record, quorum and recovery evidence | Private key in source, logs, image, or ordinary environment variable |
| G4 | Payment rails | Yellow Card, Mojaloop, and Nigerian bank/PSP contract tests; idempotency and timeout cases | Executed-provider authorization, settlement and safeguarding arrangements | Provider execution enabled without written authorization and tested perimeter |
| G5 | Ledger integrity | PostgreSQL/TigerBeetle reconciliation with zero discrepancy; rollback evidence | Funds-flow, reconciliation ownership, exception approval, customer remediation procedure | Any unexplained discrepancy or unresolved `UNKNOWN` state |
| G6 | AML/CFT/CPF | Screening, monitoring, case-management, STR/SAR simulation, sanctions and PF test records | Enterprise risk assessment, MLRO appointment, policies, training, escalation contacts | No approved risk appetite or no evidence of alert disposition |
| G7 | Resilience | Chaos results for provider partition, signer outage, DB pool exhaustion, and failover | BCP/DR approval, RTO/RPO, communication tree, exercise CAP tracker | Recovery depends on manual database edits or unbounded retries |
| G8 | Observability | Prometheus rule validation, live `/metrics` scrape, Alertmanager route test, dashboard snapshot | Named on-call rota, incident severity matrix, CBN notification procedure | Critical alerts cannot reach an owned receiver |
| G9 | Evidence integrity | Strict schemas, manifest digest verification, WORM/Object Lock test, independent E-09 review | Four distinct approval roles with dual control and recusal checks | Mutable evidence, missing sidecars, or same subject in two approval roles |
| G10 | Pilot authorization | Restricted namespace, allow-list, transaction caps, kill switch, canary record | Written CBN authorization and customer/partner disclosures | Treating staging or a dry run as permission to operate |

## 3. Toolchain and repository bootstrap

The repository pins the target versions in `.tool-versions`, `rust-toolchain.toml`, and `.nvmrc`. The bootstrap script installs repository-local binaries under `.toolchain/bin` and reports missing host prerequisites without putting credentials into the shell history.

```bash
cd /path/to/UmojaFlowOS-repo
chmod +x scripts/infra/bootstrap_toolchains.sh
scripts/infra/bootstrap_toolchains.sh
export PATH="$PWD/.toolchain/bin:$PATH"
```

The host still needs Docker Engine with Compose v2, Git, Python 3.11+, a C compiler and development headers for CGO/libpq, and a running Kubernetes client context when live admission checks are required. The CI dependency file remains the source of truth for Python test dependencies; `pnpm-lock.yaml` remains the source of truth for the control-plane dependency graph.

Verify the installed toolchains before building:

```bash
go version
rustc --version
cargo --version
node --version
pnpm --version
python3 --version
kubectl version --client
helm version
promtool --version
amtool --version
k6 version
act --version
```

The script is intentionally not a production secret manager. Production credentials must be injected by the organization’s approved Keycloak/Vault or equivalent open-source secret-management process, mounted with least privilege, and rotated using two-person approval.

## 4. Local staging, with no value movement

Local staging is disposable and uses synthetic Nigerian scenarios. Follow the existing runbook in `infra/local-staging/DEPLOYMENT.md` and keep all exposed ports loopback-only.

```bash
cd /path/to/UmojaFlowOS-repo
cp infra/local-staging/.env.example infra/local-staging/.env
chmod 600 infra/local-staging/.env
$EDITOR infra/local-staging/.env

docker compose --env-file infra/local-staging/.env \
  -f infra/local-staging/compose.yaml config >/tmp/umoja-compose.yaml

docker compose --env-file infra/local-staging/.env \
  -f infra/local-staging/compose.yaml up --build -d

docker compose --env-file infra/local-staging/.env \
  -f infra/local-staging/compose.yaml ps
```

Run health and schema checks, seed only synthetic data, and preserve the generated manifest as a test artifact:

```bash
scripts/infra/verify_local_staging_seed.py
python3 scripts/infra/seed_nigeria_scenario.py \
  --database-url "$DATABASE_URL" \
  --environment local-staging \
  --rows-per-table 3 \
  --apply \
  --manifest artifacts/local-staging-seed-manifest.json
make check
```

The local stack is not evidence for E-01 through E-09. It is a developer confidence check and a rehearsal for evidence collection.

## 5. Kubernetes staging deployment

Use a dedicated cluster and namespace. Do not point the staging manifest at production endpoints. Replace the release image with an immutable digest during the release process; do not deploy `:latest` or a mutable branch tag.

```bash
kubectl config current-context
kubectl create namespace umoja-payment --dry-run=client -o yaml | kubectl apply -f -
kubectl -n umoja-payment get secret mojaloop-signer-mtls mojaloop-signer-key-reference
kubectl -n umoja-payment get configmap mojaloop-signer-config
```

Before applying, run the automated gate:

```bash
scripts/infra/verify_staging_admission_and_metrics.sh \
  --namespace umoja-payment \
  --manifest infra/kubernetes/payment-engine-mojaloop-secure.yaml \
  --require-live
```

The gate performs server-side admission validation, confirms restricted security controls, waits for the deployment rollout, and scrapes `/metrics` through a Kubernetes port-forward. A local manifest grep or client-side dry run is not a substitute for `--server-side --dry-run=server`. A result obtained without a reachable API server must be recorded as “not executed,” never as PASS.

For an actual staged release, render and inspect all overlays, then apply through the reviewed release workflow:

```bash
kubectl diff --server-side -n umoja-payment -f infra/kubernetes/payment-engine-mojaloop-secure.yaml
kubectl apply --server-side -n umoja-payment -f infra/kubernetes/payment-engine-mojaloop-secure.yaml
kubectl -n umoja-payment rollout status deployment/payment-engine --timeout=180s
kubectl -n umoja-payment get pods -o wide
kubectl -n umoja-payment describe deployment/payment-engine
```

The cluster must enforce a restricted Pod Security Admission profile, NetworkPolicies, image-signature/provenance policy, resource requests and limits, audit logging, and namespace-level separation. Admission must reject privileged containers, root execution, writable root filesystems, host networking, host PID/IPC, unapproved capabilities, and unapproved registries.

## 6. Secret, identity, and signer controls

Keycloak is the identity boundary for the open-source, cloud-agnostic platform. Use separate realms or clients for human operations, service-to-service calls, CI evidence publishing, and provider callbacks. Every privileged role must have a unique enterprise subject; four release approvers must be distinct and must not be the release author or the same person serving two incompatible control roles.

The production secret procedure is:

1. Generate or import the secret into the approved Vault/HSM/signer boundary; never place private key bytes in Git, a Dockerfile, a ConfigMap, a normal environment variable, an issue, a trace, or a log.
2. Record the key reference, algorithm, intended audience, owner, expiry, and approval quorum in the key ceremony record.
3. Mount only the required certificate, key, and CA files into the payment-engine pod with read-only permissions. Validate ownership and mode at startup.
4. Execute a read-only signer canary and a negative authorization test with the replacement credential.
5. Roll the deployment while retaining the old verified credential until the canary and health checks pass.
6. Revoke the old credential, record the revocation result, and verify that the old credential cannot sign or authenticate.

A failed canary leaves execution disabled or on the last verified credential; it must not silently fall back to an untrusted signer. Alert labels must contain metric names and safe identifiers only, never key references if they are sensitive, tokens, certificate contents, ILP conditions, or provider payloads.

## 7. Payment rails and failover

The provider-neutral boundary is the `multirail.Rail` contract and its equivalent Go, Rust, Python, and TypeScript implementations. Each adapter must preserve the same rules: canonical instruction binding, idempotency key binding, payload SHA-256 binding, bounded context-aware retries, and no secondary submission after an unresolved primary `UNKNOWN` unless the reconciliation policy explicitly establishes that the primary did not submit.

A controlled pilot should begin with execution disabled, read-only provider status lookup, and a transaction allow-list. The following tests are mandatory before execution is enabled:

| Test | Expected result |
|---|---|
| Primary returns success | Exactly one durable execution record and one ledger posting |
| Primary returns deterministic rejection | No fallback submission; rejection is recorded |
| Primary times out | Durable `UNKNOWN`; no blind retry; reconciliation lease created |
| Status lookup confirms not found under an authorized provider contract | Only then may the reviewed failover policy permit the secondary rail |
| Status lookup returns 404/5xx ambiguously | Remain fail-closed; no secondary submission |
| Concurrent duplicate requests | One single-flight execution; all waiters observe the same decision |
| Payload differs for the same idempotency key | Reject with a conflict; never reuse the previous result |
| Lease expires while worker is active | Stale worker cannot commit a terminal decision |

Yellow Card, Mojaloop, and a Nigerian bank/PSP are separate commercial and regulatory relationships. Adapter completeness does not constitute authorization to provide payment, remittance, custody, exchange, or settlement services.

## 8. Reconciliation and financial controls

Every payment instruction must have a durable idempotency record, a provider correlation identifier where available, and a reconciliation state that can be audited without changing history. The `UNKNOWN` queue is processed by leased workers with atomic claim and immutable terminal decision records. A discrepancy, missing provider status, signer uncertainty, or TigerBeetle/PostgreSQL mismatch is a stop condition.

The staging financial-control run should produce:

```bash
# Use the repository's staging connection and explicitly named release SHA.
python3 scripts/infra/verify_production_release_evidence.py \
  --evidence-root assurance/evidence/staging \
  --release-sha "$RELEASE_SHA" \
  --manifest assurance/evidence/staging/release_evidence_manifest.json
```

The exact script flags should be confirmed with `--help` for the checked-out commit. No operator should edit ledger rows, reconciliation terminal decisions, or evidence manifests by hand to make a test pass.

## 9. Observability and alert response

Prometheus must scrape the payment-engine `/metrics` endpoint over an authenticated and network-policy-approved path. Prometheus rule files are validated with `promtool`; Alertmanager routing is validated with `amtool` and a non-production receiver. Grafana is a visualization layer, not the source of truth for alert state.

```bash
promtool check rules infra/monitoring/mojaloop-signer-alerts.yml
amtool check-config infra/monitoring/alertmanager.yml
scripts/infra/verify_staging_admission_and_metrics.sh --require-live
```

Minimum operational signals include request volume, success/rejection/unknown counts, failover attempts, reconciliation backlog and age, signer attempts and exhaustion, database pool saturation and lock wait, ledger reconciliation discrepancies, authentication failures, and alert delivery failures. Minimum-volume guards must remain enabled to prevent noise from idle systems, but they must not suppress a critical security or integrity alert.

When a critical signer, database, rail, or reconciliation alert fires, contain first: disable execution, preserve evidence, identify the first failing component, and prevent additional value movement. Then perform read-only status queries, reconcile provider and ledger state, and communicate through the approved incident tree. Resume only after the incident owner, compliance owner, and release authority approve the documented recovery criteria.

## 10. Evidence and submission package

The release evidence package should include E-01 through E-09 artifacts, the exact release SHA, machine-readable manifests, schema-validation output, artifact digests, WORM/Object Lock retention proof, incident and rollback records, independent code-review records, and four distinct approval payloads. A sidecar may hold large logs or screenshots, but the strict manifest must contain the digest and a stable reference to the sidecar.

Before submission, Legal and Compliance must replace every synthetic officer, company fact, ownership record, financial statement, contract, policy attestation, and incident record with an authorized source document. The dossier validator should reject placeholder values and duplicate subjects. Counsel must verify beneficial ownership, control, shareholding, conflicts, recusal, licensing perimeter, consumer protection, data protection, AML/CFT/CPF, and outsourcing positions.

The final package should be reviewed in this order:

1. Product boundary and legal-perimeter review.
2. Corporate, UBO, officer, and conflict/recusal review.
3. AML/CFT/CPF and sanctions-risk review by the MLRO/compliance function.
4. Security, resilience, incident response, and data-retention review.
5. Financial safeguarding, reconciliation, provider, and operational review.
6. Independent E-09 evidence and code review.
7. Board resolution and four-role production release approvals.
8. Formal submission or controlled-live activation only after written authorization.

## 11. Rollback and emergency stop

The emergency stop must be tested, role-restricted, auditable, and independent of the provider being stopped. It must disable new execution, preserve reconciliation processing, keep read-only status lookup available where safe, and prevent deletion or mutation of evidence. Rollback is not complete until the deployment digest is known, the previous verified version is healthy, all in-flight requests are accounted for, PostgreSQL and TigerBeetle reconcile, and an incident record has been sealed in immutable storage.

A rollback drill must capture command transcripts, Kubernetes events, deployment and image digests, metrics snapshots, provider status responses, reconciliation outcomes, approver identities, and the post-exercise corrective-action tracker. The drill must include a negative test proving that an unauthorized operator cannot re-enable execution.

## 12. Release checklist

| Area | Pass condition | Owner |
|---|---|---|
| Source | Clean tree, reviewed commit, no unresolved security findings | Engineering |
| Build | Pinned toolchains, reproducible image digests, SBOM and provenance | Release engineering |
| Secrets | Managed references, mounted files, rotation and revocation proof | Security |
| Rails | Contract tests, fail-closed unknown handling, provider authorizations | Payments/compliance |
| Ledger | Zero unexplained discrepancy and signed reconciliation report | Finance/operations |
| AML | Risk assessment, monitoring thresholds, case handling, MLRO approval | MLRO |
| Resilience | DR and chaos exercises with accepted CAPs | SRE |
| Monitoring | Live scrape, rules, routes, dashboard, on-call acknowledgement | SRE |
| Evidence | Strict manifest, SHA-256 bindings, WORM retention, independent review | Assurance |
| Regulation | Real authorized records, counsel opinion, Board resolution, CBN authorization | Legal/Board |

## References

[1]: https://sandbox.cbn.gov.ng/ "Central Bank of Nigeria Regulatory Sandbox"

[2]: https://kubernetes.io/docs/tasks/configure-pod-container/security-context/ "Kubernetes Security Context"

[3]: https://kubernetes.io/docs/concepts/security/pod-security-standards/ "Kubernetes Pod Security Standards"

[4]: https://prometheus.io/docs/prometheus/latest/command-line/promtool/ "Prometheus promtool documentation"

[5]: https://prometheus.io/docs/alerting/latest/ "Alertmanager and amtool documentation"

[6]: https://www.keycloak.org/documentation "Keycloak documentation"

[7]: https://slsa.dev/spec/v1.0/ "SLSA provenance specification"
