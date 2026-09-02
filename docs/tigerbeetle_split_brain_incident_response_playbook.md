# TigerBeetle Split-Brain Incident Response Playbook

**Service:** UmojaFlowOS ledger and payment execution  
**Incident:** Suspected TigerBeetle split brain, divergent cluster views, or loss of authoritative consensus  
**Use:** Production-hours response; adapt command examples to the approved deployment tooling  
**Default decision:** **NO-GO / settlement suspended until authoritative state is proven**

> A timeout, quorum alarm, divergent node view, or conflicting ledger response is not evidence that a transfer failed. Treat every unresolved operation as potentially committed until a trusted read-only query and reconciliation process proves otherwise.

## 1. Purpose and safety boundaries

This playbook protects customer funds, ledger integrity, auditability, and controlled recovery when different TigerBeetle nodes may hold or report inconsistent views. It is intentionally fail-closed. Responders must not blindly retry an uncertain transfer, manually edit ledger facts, delete audit records, promote an unverified node, or switch to another payment rail merely because the primary rail timed out.

The playbook assumes that the payment engine maintains an idempotency key and payload SHA-256 binding for every execution, that ledger posting facts and payment decisions are retained append-only, and that the router can suspend new settlement while permitting approved read-only status and reconciliation operations.

## 2. Roles and authority

| Role | Responsibility during incident | Authority boundary |
|---|---|---|
| Incident Commander | Declares severity, coordinates response, approves containment and communications. | Cannot approve ledger resumption alone. |
| Ledger/Treasury Lead | Determines authoritative ledger state, validates account bindings, and signs reconciliation. | Cannot alter ledger facts or approve own reconciliation without an independent witness. |
| Payment Operations Lead | Fences payment workers, disables unsafe routes, manages leases, and coordinates recovery. | Cannot release UNKNOWN transactions without ledger and compliance approval. |
| Security Lead | Reviews cluster identity, network partition, credentials, mTLS, HSM/signing, access, and evidence integrity. | Controls forensic access and evidence preservation. |
| Compliance/MLRO Lead | Assesses customer, AML, sanctions, reporting, and consumer impact. | Approves compliance resumption conditions and disclosures. |
| Communications Lead | Sends internal, provider, executive, and regulator notifications using approved templates. | Does not speculate on settlement finality. |
| Independent Witness | Reviews timeline, reconciliation, recovery evidence, and final decision. | Must be separate from the executor of the recovery action. |

## 3. Severity and declaration criteria

Declare a **SEV-1 financial-integrity incident** immediately if two or more nodes report conflicting cluster membership or transfer outcomes, quorum is lost while writes are possible, a transfer may have committed but the client received UNKNOWN, PostgreSQL and TigerBeetle facts disagree, or a failover could submit a duplicate financial command.

Declare a **SEV-2 service-continuity incident** when the cluster is unavailable but there is no evidence of divergent state, all writes are already fenced, and read-only status and reconciliation remain reliable. Escalate to SEV-1 if any evidence of divergence, duplicate settlement, unauthorized promotion, or unexplained discrepancy appears.

## 4. Detection signals

| Signal | Interpretation | Immediate implication |
|---|---|---|
| Quorum/consensus alarm | The cluster may not have a single authoritative write view. | Suspend settlement. |
| Node membership disagreement | Possible network partition or split brain. | Fence affected nodes and prevent promotion. |
| Transfer timeout with UNKNOWN result | Commit status is unresolved. | Reconcile by idempotency key; do not retry. |
| Conflicting transfer facts | Possible divergent view, replay, or data-integrity problem. | Stop all settlement and open financial-integrity incident. |
| Sudden duplicate-idempotency or payload-hash conflicts | Repeated command or wrong request binding. | Quarantine affected operations and preserve evidence. |
| PostgreSQL/TigerBeetle reconciliation mismatch | Application and ledger state are not aligned. | No release or resumption until independently reconciled. |
| Provider result conflicts with ledger result | External and internal finality differ. | Hold the payment and notify Compliance/Treasury. |

## 5. First 15 minutes: contain and preserve

### T+0 to T+5 — declare and freeze

1. The first responder declares the incident in the approved incident system with severity, detection time, affected region/cluster, and the last known healthy release SHA.
2. The Incident Commander pages the Ledger/Treasury Lead, Payment Operations Lead, Security Lead, Compliance/MLRO Lead, and Independent Witness.
3. Payment Operations immediately activates the **settlement fence**: stop new payment submissions, disable automatic retries, disable cross-rail fallback for UNKNOWN operations, and prevent new worker leases from claiming affected work.
4. Keep read-only status lookup, metrics, logs, and reconciliation available if they do not issue financial commands. If their safety cannot be proven, suspend them too.
5. Do not restart, promote, repair, or remove a TigerBeetle node until cluster and evidence metadata are captured.

### T+5 to T+15 — capture volatile evidence

Capture, without exposing credentials:

| Evidence | Required fields |
|---|---|
| Cluster state | Cluster ID, node IDs, versions, membership, quorum/consensus state, leader/primary view if applicable. |
| Network state | Partition boundaries, routing/security-policy changes, packet-loss/latency window, affected zones. |
| Payment state | In-flight IDs, idempotency keys, payload hashes, leases, worker IDs, provider request IDs, UNKNOWN decisions. |
| Ledger state | Read-only transfer facts, account balances where permitted, timestamps, client errors, and node-specific responses. |
| Database state | PostgreSQL payment rows, posting intents, reconciliation rows, transaction/lease records, migration/schema version. |
| Operational state | Prometheus alerts, Alertmanager event IDs, deployment/image digest, recent changes, operator actions. |
| Access state | Actor identity, command audit records, break-glass use, certificate/key identifiers; never private key material. |

Hash each captured artifact, write it to the approved immutable evidence store, and record the object path, SHA-256, actor, timestamp, and retention policy. Do not overwrite the original logs when creating redacted copies.

## 6. Containment procedure

The Payment Operations Lead verifies that the fence is active at every execution layer: API admission, payment router, worker queue, multirail coordinator, provider adapter, signer/HSM boundary, and ledger client. The team must verify that a previously leased UNKNOWN operation cannot be claimed by a second worker and that a standby replica cannot become write-active without an approved lease and fencing token.

If the fence cannot be confirmed, isolate the payment-engine deployment from the provider and ledger network using the approved network policy or service-level emergency switch. This is preferable to leaving an uncertain write path active. Keep the evidence and status endpoints available only if their access is read-only and audited.

The Incident Commander records a customer-impact statement using facts only: affected time window, products/corridors, whether submissions were suspended, number of operations in UNKNOWN or held state, and whether any duplicate or unexplained settlement has been confirmed. Do not describe an operation as failed until reconciliation proves non-submission or a terminal failed state.

## 7. Investigation and split-brain confirmation

The Security Lead determines whether the event is a network partition, process failure, configuration drift, certificate/authentication failure, operator error, or actual divergent cluster state. Compare node membership and health reports, network paths, deployment versions, time synchronization, access logs, and recent changes. Preserve before/after evidence; do not run destructive cleanup while the incident is active.

The Ledger/Treasury Lead uses only approved read-only queries and APIs to compare the last trusted ledger checkpoint with each affected node’s reported facts. The team must establish a single authoritative cluster view before any write or promotion. A node that is stale, isolated, or unable to prove current membership is treated as untrusted and remains fenced.

For every in-flight or UNKNOWN payment, join the same logical identity across payment order, provider request, idempotency record, payload hash, posting intent, TigerBeetle transfer fact, and reconciliation record. The following outcomes are permitted:

| Outcome | Safe disposition |
|---|---|
| Authoritative ledger confirms one committed transfer and application lacks the terminal decision | Record/reconcile the existing commitment; never submit a second transfer. |
| Authoritative ledger proves no transfer and provider also proves non-submission | Mark terminal failure only through the approved state transition, then permit a new authorized attempt if policy allows. |
| Ledger and provider disagree | Keep held/UNKNOWN, suspend affected corridor, escalate to Treasury and Compliance. |
| No authoritative ledger view | Keep held/UNKNOWN; do not retry or promote a node. |
| Duplicate or conflicting transfer facts | Treat as SEV-1; preserve evidence, stop settlement, and begin financial-integrity investigation. |

## 8. Rollback and recovery decision matrix

| Condition | Rollback action | Resumption blocked until |
|---|---|---|
| Quorum lost but no divergence confirmed | Keep settlement fenced; restore quorum using approved infrastructure runbook. | Cluster identity, quorum, membership, and health are independently verified. |
| Network partition isolates node(s) | Fence isolated node(s); repair network; do not promote stale nodes. | Membership converges and read-only consistency checks pass. |
| Primary process crashed during transfer | Keep lease fenced; reconcile by idempotency key. | One authoritative terminal outcome is recorded. |
| PostgreSQL/TigerBeetle mismatch | Stop settlement and open discrepancy record. | Zero unexplained differences and dual-person reconciliation approval. |
| DR promotion needed | Promote only the approved target after schema, data, ownership, and ledger checks. | Exclusive write ownership and post-promotion reconciliation are proven. |
| Provider status unavailable | Keep operation UNKNOWN; do not switch rail. | Non-submission or commitment is proven by trusted evidence. |
| WORM or evidence store unavailable | Stop release/resumption decision requiring evidence. | Immutable retention and digest verification are restored. |
| RTO/RPO exceeded | Keep service suspended and open CAP. | Recovery risk is assessed and authorized; data integrity is reconciled. |

A rollback is a return to the last trusted **operating mode**, not deletion of transactions or rewriting audit history. If the last trusted mode is “settlement suspended,” remain suspended until the recovery gate passes.

## 9. Controlled restoration and failover

Only the Incident Commander may authorize the recovery procedure after the Security Lead confirms the suspected partition is contained. Operations must use the approved deployment runbook to restore network membership or promote the designated recovery cluster. The recovery target must have a known image digest, approved configuration, current migration state, correct role separation, valid certificates, and no uncontrolled write path.

Before enabling writes, Operations performs a dry-run/read-only validation of cluster identity, quorum, node membership, account bindings, schema version, queue state, lease state, and monitoring. The Ledger/Treasury Lead performs reconciliation from the last trusted checkpoint through the incident window. The Compliance/MLRO Lead reviews affected customer and AML cases. The Independent Witness verifies that the evidence is complete and that recovery did not create a second settlement path.

The first write enablement should use a bounded canary with an approved non-customer test identity and zero-value or otherwise authorized test transaction, subject to the applicable staging/production policy. The canary must prove request identity, single settlement, ledger posting, database reconciliation, alert visibility, and rollback. If any result is UNKNOWN, the canary remains held and production writes stay disabled.

## 10. Customer, provider, executive, and regulator communications

The Communications Lead issues an initial internal notice immediately after containment. It should state that payment settlement is temporarily suspended because ledger consistency is under investigation, identify the affected window and channels, and avoid claims about failed or successful transfers until reconciliation is complete.

Provider communications should request preservation of provider-side request, response, webhook, and status records for the incident window. Ask for authoritative status by request ID and idempotency key; do not ask a provider to resend or replay an uncertain financial instruction.

Customer communications, if required, must be approved by Compliance and Legal. They should explain the service impact, expected next update, support route, and any confirmed customer-specific outcome. They must not disclose internal credentials, infrastructure details, or unverified settlement claims.

Regulatory notification is governed by the applicable incident and Sandbox obligations. Compliance determines whether notification thresholds are met, records the decision and rationale, and retains any submission receipt or the reason a draft was held. The platform must never fabricate a filing receipt.

## 11. Safe-resumption gate

Settlement may resume only when every condition below is satisfied and recorded:

| Gate | Required proof | Approver |
|---|---|---|
| Cluster authority | One verified cluster identity, quorum, membership, and trusted write view. | Ledger/Treasury + Security |
| Fencing | Affected nodes/workers cannot write or claim work outside the approved path. | Operations + Security |
| Financial reconciliation | All in-flight/UNKNOWN operations have authoritative outcomes or remain safely held; zero unexplained discrepancies. | Ledger/Treasury + Independent Witness |
| Idempotency | No duplicate terminal settlement; payload and idempotency bindings match. | Payment Operations |
| DR integrity | Recovery target passes schema, ownership, backup/restore, and post-recovery checks. | Operations |
| Monitoring | Prometheus targets, critical alerts, Alertmanager routes, and operator acknowledgement work. | Operations + Security |
| Compliance impact | AML/KYC/sanctions/customer-impact review is complete; required cases and notifications are recorded. | Compliance/MLRO |
| Change control | Recovery changes, image/config digests, and rollback plan are approved and recorded. | Incident Commander + Release Manager |
| Evidence | All artifacts are hashed, retained immutably, and linked to the incident and release SHA. | Security + Independent Witness |

Resume in stages: read-only first, then a bounded canary, then a limited corridor or transaction class, and only then the approved operating limit. Monitor reconciliation and alerts continuously during the observation window. Any new UNKNOWN, divergence, duplicate, alert-delivery failure, or unexplained discrepancy reactivates the settlement fence.

## 12. Post-incident review and audit package

Within one business day, the Incident Commander freezes the timeline and evidence index. Within five business days, the team completes a blameless review covering trigger, time to detect, time to fence, time to authoritative state, time to recover, RTO/RPO, customer and provider impact, reconciliation, control effectiveness, and corrective actions.

The external audit package must include the incident ID, release SHA, cluster and node attestations, network fault evidence, payment/ledger/database correlation table, all UNKNOWN decisions, reconciliation results, deployment and rollback records, alert receipts, communications decisions, WORM metadata, SHA-256 manifest, and independent review. Private keys, credentials, raw customer identity documents, and unnecessary personal data must not be included.

Corrective actions should address both technical and governance causes. Examples include stronger quorum/membership alerting, automated fencing, explicit lease ownership, provider status lookup, reconciliation dashboards, DR restore drills, runbook updates, access-control review, operator training, and a regression test for the exact failure mode.

## 13. Compact incident checklist

| Phase | Complete |
|---|---|
| Declare SEV-1/SEV-2 and assign required roles | [ ] |
| Activate settlement fence and disable unsafe retries/fallback | [ ] |
| Preserve cluster, network, payment, ledger, DB, alert, and access evidence | [ ] |
| Confirm no unauthorized promotion or second worker claim | [ ] |
| Establish authoritative ledger view using read-only controls | [ ] |
| Reconcile every UNKNOWN/in-flight operation | [ ] |
| Record discrepancies and customer/AML/provider impact | [ ] |
| Repair or recover only through approved change control | [ ] |
| Validate quorum, ownership, schema, monitoring, and WORM evidence | [ ] |
| Run bounded canary and confirm single settlement | [ ] |
| Obtain independent Treasury, Security, Compliance, Operations, and Incident Commander approval | [ ] |
| Resume in stages and monitor the observation window | [ ] |
| Freeze audit package and open corrective actions | [ ] |

## References

[1]: https://tigerbeetle.com/docs/reference/ "TigerBeetle reference documentation"  
[2]: https://www.postgresql.org/docs/current/transaction-iso.html "PostgreSQL transaction isolation documentation"  
[3]: https://sre.google/sre-book/managing-incidents/ "Google SRE incident management guidance"
