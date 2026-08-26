# Adversarial Verification — Defect Inventory

**Revision reviewed:** `71b14909ec2cc9e373158120aab2c03953bb89fa`
**Method:** A second pass re-read the live consumers and searched for alternate guards, upstream error swallowing, and duplicated paths. It did not rely on the finding descriptions or comments as proof.

| Finding | Independent check | Result |
|---|---|---|
| F3-01 | Searched all executable control-plane/service/simulator consumers of `screeningState` / `screening_state`; re-read payment-order draft path. | **PROVEN.** The payment workflow selects `screening_state` at `apps/control-plane/server/paymentWorkflow.ts:269-272`, then only checks record existence and customer ownership at `:274-278`. No executable `clear` guard exists before rate-lock consumption at `:338-346`. |
| F9-01 | Re-read endpoint normalizer and health-probe network sink; searched for hostname/IP restriction. | **PROVEN.** `apps/control-plane/server/postgres.ts:1040-1049` enforces only absolute HTTPS/no userinfo. `apps/control-plane/server/providerHealthCheck.ts:66-75` calls that URL with the resolved credential in `Authorization`. No private/loopback/link-local guard exists. |
| F9-02 | Re-read alert model, path construction, and artifact writes; searched for resolve/relative-to containment. | **PROVEN.** `simulators/retention_gateway/incident_response_service.py:18-34` accepts unrestricted `fingerprint`; `:147-164` concatenates it to `evidence_root` and writes files. No normalization or containment check exists. |
| F10-01 | Searched simulator and all tests for fallback secret; re-read HMAC comparison sink. | **PROVEN.** `simulators/production_dependencies/app.py:20` selects `ci-simulator-secret` absent configuration, and `:146-148` accepts signatures with it. No higher-level runtime guard exists. |
| F13-01 | Re-read threshold arithmetic and database numeric definitions. | **PROVEN.** PostgreSQL stores reconciliation/buffer quantities as `NUMERIC`, while `apps/control-plane/server/operationalAlerts.ts:207-219` performs threshold comparisons through JavaScript `Number`. |
| F16-01 | Tested tracked-file existence and package script target. | **PROVEN.** `database/postgresql/0001_baseline.sql` is absent; `apps/control-plane/package.json:15` invokes it. |
| F16-02 | Compared migration filenames and same-name helper file content. | **PROVEN.** Root has 42 numbered migrations; `apps/control-plane/database/postgresql` has 6. Same-name `grants.sql` differs. No executable migration runner makes root canonical through a ledger. |
| F16-03 | Re-read process bind fallback and all fixed `control-plane:3000` deployment consumers. | **PROVEN.** In the port-collision branch, `apps/control-plane/server/_core/index.ts:29-35,70-78` binds another port while Caddy and Compose retain `control-plane:3000` (`infra/caddy/Caddyfile:35,45,68`; `infra/security-stack/compose.yaml:18,373-388`). This is a deterministic outage path, not merely a theory. |

## Bypass and cosmetic-fix checks

No alternate payment draft implementation was found outside `paymentWorkflow.ts`; no alternate provider activation probe bypassing `normaliseProviderEndpoint` was found; no alternate incident evidence-root path existed; and no second migration command was found. The remediation must nevertheless add regression tests for these negative searches where practical.

## Remediation authorization

The discovery inventory and independent verification are complete. The next phase may implement the seven confirmed local source/configuration remediations. External evidence, actual public-DNS ownership, real provider behavior, and staging deployment remain outside local proof and must remain fail-closed.
