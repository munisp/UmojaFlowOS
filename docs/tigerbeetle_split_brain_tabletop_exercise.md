# TigerBeetle Split-Brain Tabletop Exercise

**Exercise type:** Facilitated tabletop; no production fault injection
**Participants:** Engineering, Payment Operations, Treasury/Ledger, Security, Compliance/MLRO, Communications, and executive observer
**Duration:** 90 minutes plus 30 minutes hotwash
**Scenario:** Production-hours suspected TigerBeetle split brain during a burst of Nigerian NGN payment activity
**Objective:** Demonstrate that the organization can detect, fence, reconcile, communicate, recover, and resume safely without duplicate settlement or loss of audit evidence.

> This is a discussion exercise. Do not run destructive commands, restart production nodes, disable production networks, or replay financial requests during the tabletop.

## Exercise objectives

| Objective | Demonstration required |
|---|---|
| Detect early | Engineering identifies quorum loss, divergent node views, or consensus errors from dashboards and alerts. |
| Contain safely | Operations activates the settlement fence, disables unsafe retries/fallback, and prevents new leases. |
| Preserve evidence | Security and Operations identify logs, metrics, request IDs, idempotency keys, ledger facts, and database records that must be frozen. |
| Reconcile | Treasury/Ledger and Engineering describe how each UNKNOWN operation is resolved without blind retry. |
| Manage compliance impact | Compliance determines AML/customer/regulatory impact and records notification decisions. |
| Recover and resume | The team applies quorum, ownership, schema, reconciliation, monitoring, and canary gates before resumption. |

## Roles

The facilitator acts as the event inject controller. The Incident Commander owns decisions. Engineering owns the payment engine, coordinator, leases, and observability. Treasury/Ledger owns authoritative state and reconciliation. Security owns access, network, mTLS/HSM, and evidence integrity. Compliance/MLRO owns customer, AML/CFT/CPF, sanctions, and regulatory implications. Communications owns factual stakeholder updates. The Scribe records decisions and timestamps. An executive observer evaluates whether authority boundaries are respected.

## Starting conditions

The approved release is deployed to production with a three-node TigerBeetle cluster, PostgreSQL projection, Redis, payment engine replicas, Yellow Card and Nigerian/Mojaloop rail adapters, Prometheus, Alertmanager, and WORM evidence storage. The settlement fence and read-only reconciliation path are available. The team has approved RTO/RPO, incident contacts, emergency change authority, and a current account-binding manifest.

## Timeline and injects

| Time | Inject | Expected team decisions and actions | Evidence to capture |
|---:|---|---|---|
| 00:00 | Facilitator announces elevated ledger latency and a warning alert for consensus errors. | Engineering checks cluster health, node membership, quorum, latency, recent changes, and alert freshness. No restart or retry yet. | Alert IDs, dashboard snapshot, cluster status, release SHA, recent-change list. |
| 00:10 | One node reports healthy while another reports a different membership view. | Declare SEV-1 suspected split brain; page required roles; activate incident bridge; prepare settlement fence. | Conflicting views, node IDs, timestamps, incident ID, role acknowledgements. |
| 00:20 | Two payment requests time out; providers have not yet confirmed status. | Fence settlement, disable automatic retry and UNKNOWN fallback, prevent new leases, retain both operations as UNKNOWN/held. | Request IDs, idempotency keys, payload hashes, leases, provider traces. |
| 00:30 | PostgreSQL shows one posting intent; one node’s read-only response shows no matching transfer fact. | Treat as unresolved discrepancy; do not edit rows or issue compensation; isolate affected ledger view and begin authoritative reconciliation. | SQL/read-only outputs, transfer facts, projection rows, discrepancy record. |
| 00:40 | A provider asks whether it should replay a timed-out request. | Communications and Compliance instruct provider not to replay; request status by original request ID and idempotency key. | Provider correspondence, decision authority, exact wording. |
| 00:50 | A standby operator proposes promoting the apparently healthy node. | Security and Operations require cluster identity, quorum, fencing, ownership, schema, and consistency proof before promotion. Reject unsafe promotion. | Promotion decision, fencing status, access audit, approval matrix. |
| 01:00 | Alert volume rises; Alertmanager delivery to one receiver is delayed. | Treat observability loss as an operational risk; verify alternate receiver and maintain suspension if required visibility is unavailable. | Alert delivery logs, receiver acknowledgement, monitoring decision. |
| 01:10 | Read-only reconciliation confirms one transfer committed and one did not; a third remains unknown. | Record terminal outcomes for the first two only through approved state transitions. Keep the third held; escalate to Ledger/Treasury and Compliance. | Reconciliation report, terminal decision records, reviewer identity. |
| 01:20 | Network is repaired and the cluster reports a single quorum view. | Verify node membership, cluster identity, account bindings, DB schema, lease state, and WORM evidence before enabling any write. | Recovery checks, hashes, schema/grants, cluster attestation. |
| 01:30 | A bounded canary is proposed. | Require non-customer approved canary, single settlement, monitoring visibility, reconciliation, and rollback readiness. Resume only within approved limits. | Canary request/response, ledger fact, DB projection, alerts, approvals. |
| 01:40 | Facilitator reveals the exercise outcome and opens hotwash. | Identify gaps, owners, due dates, and whether the safe-resumption gate was met. | Decision log, CAP items, evidence index, exercise report. |

## Discussion questions

Engineering must identify which metric proves quorum, which metric indicates divergent membership views, how the cluster identity is verified, how worker leases are fenced, and which endpoint is strictly read-only. Treasury/Ledger must explain the authoritative-state hierarchy and the exact join keys used to reconcile payment, provider, PostgreSQL, and TigerBeetle facts. Compliance must identify when a screening, sanctions, customer, or regulatory-reporting impact is triggered and who approves notifications. Security must explain how access, mTLS, HSM, network policy, and WORM evidence are preserved. Operations must state the RTO/RPO, promotion prerequisites, and rollback steps. Communications must demonstrate that no unverified settlement claim is made.

## Success criteria

The exercise passes when the team declares the correct severity, fences settlement without delay, prevents duplicate retry/fallback, preserves evidence, identifies the authoritative reconciliation process, refuses unsafe promotion, handles provider replay safely, records customer and compliance impact, restores only through change control, verifies monitoring and WORM evidence, and describes staged resumption with independent approval.

The exercise fails if any participant proposes blind retry, manual ledger correction, deletion of audit evidence, promotion without exclusive ownership/quorum proof, cross-rail fallback for UNKNOWN status, resumption without reconciliation, or a claim that a timeout equals a failed payment.

## Scoring rubric

| Domain | 0 — absent | 1 — partial | 2 — demonstrated |
|---|---|---|---|
| Detection and declaration | No owner or severity. | Alert seen but delayed or unclear. | Correct SEV-1 decision and bridge within target. |
| Settlement containment | No fence. | Manual suspension only. | Layered fence, retry suppression, and lease protection. |
| Reconciliation | No authoritative method. | General intent without join keys. | Operation-by-operation authoritative decision and witness. |
| Recovery control | Unsafe promotion proposed. | Some checks identified. | Full ownership/quorum/schema/ledger/monitoring gate. |
| Compliance and communications | No impact assessment. | Generic notification. | Factual impact, MLRO review, and notification decision trail. |
| Evidence and auditability | Logs lost or mutable. | Logs retained locally. | Hash-bound, immutable package with roles and timestamps. |

A score below 10/12 requires a corrective-action plan and repeat exercise before the next controlled-live gate. Any financial-integrity hard stop is a failure regardless of score.

## Required outputs

The Scribe must produce the attendance list, decision timeline, inject responses, alert and communication references, reconciliation decision table, recovery-gate checklist, scoring sheet, open-gap register, and corrective-action plan. The final report must be linked to the exercise release SHA and stored in approved immutable evidence storage.

## References

[1]: https://tigerbeetle.com/docs/reference/ "TigerBeetle reference documentation"
[2]: https://sre.google/sre-book/managing-incidents/ "Google SRE incident management guidance"
