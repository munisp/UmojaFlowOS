# Facilitator Guide and Scoring Rubric

## TigerBeetle Split-Brain Tabletop Exercise

**Audience:** Engineering, Payment Operations, Treasury/Ledger, Security, Compliance/MLRO, Communications, and executive observers  
**Format:** Discussion-based tabletop; no production changes or fault injection  
**Duration:** 120 minutes: 15-minute briefing, 80-minute exercise, 25-minute hotwash  
**Scenario:** Suspected TigerBeetle split brain and quorum instability during production hours

> The facilitator must repeatedly reinforce that this is a no-impact discussion exercise. No participant may restart a production node, alter ledger records, replay a provider request, disable production networking, or promote a standby during the session.

## 1. Purpose and learning objectives

The exercise tests whether the organization can detect a possible split brain early, activate a layered settlement fence, preserve a defensible audit trail, reconcile uncertain transactions without duplicate settlement, manage AML/customer/regulatory implications, recover through change control, and resume only after independent approval.

The facilitator should evaluate behavior, not confidence. A technically fluent answer that bypasses approval, reconciliation, evidence preservation, or customer-protection controls is scored as a control failure.

## 2. Facilitation team

| Role | Preparation and live responsibility |
|---|---|
| Lead Facilitator | Owns objectives, controls inject timing, prevents solutioning by the facilitator, and announces score checkpoints. |
| Inject Controller | Releases scenario facts only when the team reaches the preceding decision point. Maintains the inject log. |
| Scribe | Records exact timestamps, decisions, owners, evidence requests, unresolved questions, and dissent. |
| Technical Observer | Scores detection, fencing, cluster authority, idempotency, reconciliation, recovery, and monitoring. |
| Compliance Observer | Scores AML/CFT/CPF, sanctions, customer impact, regulatory-notification, privacy, and conflict controls. |
| Executive Observer | Scores governance, authority boundaries, escalation quality, and readiness to make a defensible decision. |

## 3. Preparation checklist

Complete these activities at least two business days before the exercise:

| Preparation item | Facilitator check |
|---|---|
| Confirm attendance and alternates for every required role. | [ ] |
| Confirm that all participants understand this is a simulation and no production commands are permitted. | [ ] |
| Prepare the incident bridge, decision log, timer, scoring sheet, and evidence-request register. | [ ] |
| Prepare sanitized dashboards showing the configured TigerBeetle alerts and mock cluster signals. | [ ] |
| Prepare a fictional release SHA, cluster ID, node inventory, payment IDs, idempotency keys, and provider contacts. | [ ] |
| Confirm the settlement-fence procedure and read-only reconciliation path are understood. | [ ] |
| Prepare the current account-binding, service ownership, RTO/RPO, and escalation references. | [ ] |
| Confirm the exercise will not use real customer data, private keys, credentials, or live provider endpoints. | [ ] |
| Assign an independent witness who will not serve as the exercise operator. | [ ] |

## 4. Ground rules

Participants should answer as they would during a real incident, identify the person who has authority to act, state what evidence would be captured, and distinguish facts from assumptions. They should not invent telemetry, claim that a timeout means failure, or use “we would check” without naming the check, owner, source, and decision threshold.

The facilitator should ask “What prevents a second financial command?” whenever a retry, failover, restart, or provider replay is proposed. The facilitator should ask “What proves the state?” whenever a participant uses the words settled, failed, recovered, authoritative, or safe.

## 5. Scenario briefing script

Read the following opening statement:

> “It is 10:15 WAT on a business day. UmojaFlowOS is processing a burst of authorized Nigerian NGN activity. The payment engine is healthy from the API perspective, but the TigerBeetle monitoring panel reports rising consensus errors and ledger latency. Three TigerBeetle nodes are deployed across availability zones. PostgreSQL stores the application projection and payment decisions. The provider rails are available but have not confirmed the latest timed-out requests. Your objective is to protect funds and evidence while determining whether the cluster has a single authoritative view.”

Explain that the exercise will advance through injects and that the team is judged on its first safe action, not on how quickly it restores throughput.

## 6. Moderation timeline and expected decisions

| Exercise time | Inject | Facilitator prompts | Expected control behavior |
|---:|---|---|---|
| 00:00 | Consensus-error warning and elevated latency. | “Which signal is actionable? Who owns the first decision?” | Engineering verifies quorum, membership, alert freshness, and recent changes without restarting or retrying. |
| 00:10 | Nodes report conflicting membership views. | “What makes this SEV-1? Which node is trusted?” | Declare suspected split brain, page all roles, and prepare the settlement fence. No node is trusted solely because it reports healthy. |
| 00:20 | Two requests time out with no provider confirmation. | “Can either request be retried or sent to another rail?” | Fence settlement, suppress retries and UNKNOWN fallback, protect leases, and hold both operations. |
| 00:30 | PostgreSQL contains a posting intent; one node has no matching transfer fact. | “What is authoritative? What is the evidence join key?” | Treat as unresolved discrepancy; use read-only reconciliation and do not edit records or compensate. |
| 00:40 | Provider asks for replay. | “Who may respond and what can they safely say?” | Instruct provider not to replay; request original request-ID/idempotency status; Communications avoids unverified claims. |
| 00:50 | Operator proposes standby promotion. | “What prerequisites must be proved before promotion?” | Require cluster identity, quorum, exclusive ownership, schema, fencing, and consistency proof; reject unsafe promotion. |
| 01:00 | One alert receiver is delayed. | “Can the team resume while observability is degraded?” | Treat missing critical visibility as unsafe; verify alternate notification and maintain suspension if required. |
| 01:10 | Reconciliation confirms one commit, one non-submit, one unresolved. | “How are the three decisions recorded?” | Record only proven terminal outcomes; keep the third UNKNOWN/held and escalate. |
| 01:20 | Network converges; quorum view is single. | “What remains before write enablement?” | Verify cluster, account bindings, DB schema, leases, monitoring, WORM evidence, and recovery ownership. |
| 01:30 | Bounded canary proposed. | “Who approves and what makes the canary safe?” | Use approved non-customer canary; verify single settlement, reconciliation, monitoring, and rollback. |
| 01:40 | Hotwash begins. | “What would an external reviewer challenge?” | Identify gaps, owners, due dates, evidence paths, and repeat-exercise conditions. |

## 7. Observer prompts by discipline

### Engineering and Payment Operations

Ask how the settlement fence propagates through API admission, payment router, worker queue, multirail coordinator, provider adapter, signer/HSM, and ledger client. Ask how a worker lease is prevented from being claimed twice, how a timed-out operation is queried without issuing a financial command, and what metric proves telemetry is trustworthy.

### Treasury and Ledger

Ask the team to name the authoritative-state hierarchy and the exact correlation keys joining the payment order, provider request, idempotency key, payload digest, posting intent, ledger transfer fact, and terminal decision. Ask what constitutes an unexplained discrepancy and who can release a hold.

### Security

Ask how node identity, mTLS, network partitions, access logs, break-glass actions, HSM/signing, and WORM retention are protected. Ask how a stale or split-brain node is fenced and how the team proves that an evidence file was not modified after capture.

### Compliance and MLRO

Ask whether the event affects screening, sanctions, Travel Rule data, customer notices, case workflows, suspicious activity decisions, or regulatory deadlines. Ask who determines whether notification is required and how the team avoids fabricating a filing receipt when a reporting endpoint is unavailable.

### Communications and executives

Ask for the first internal message, provider request, customer message, and executive update. Score whether each statement distinguishes confirmed facts from investigation status and avoids claiming that timed-out payments failed.

## 8. Scoring rubric

Each domain receives 0, 1, or 2 points. The maximum is 16 points across eight domains.

| Domain | 0 — control absent | 1 — partial response | 2 — demonstrated response |
|---|---|---|---|
| Detection and severity | No actionable signal, owner, or severity. | Signal noticed but severity or ownership is delayed. | Correctly identifies suspected split brain and declares SEV-1 promptly. |
| Settlement containment | No fence or unsafe retries continue. | Manual suspension is proposed without layered protection. | Fence, retry suppression, fallback suppression, and lease protection are named. |
| Cluster authority | Node is trusted or promoted without proof. | Some health checks are named but no authority test. | Identity, quorum, membership, fencing, and consistency requirements are explicit. |
| Financial reconciliation | Team edits records or assumes timeout means failure. | Reconciliation is mentioned without correlation keys or decision ownership. | Every uncertain operation is held and reconciled by authoritative evidence. |
| Recovery and rollback | Recovery is improvised or destructive. | Recovery checks exist but lack gates or rollback criteria. | Recovery is change-controlled, reversible, and gated by ledger/DB/monitoring proof. |
| Compliance and customer impact | No AML/customer/regulatory review. | Generic notification or case review. | MLRO assesses impact, records notification decisions, and protects customers. |
| Communications and governance | Speculation, unclear authority, or no escalation. | Updates are factual but incomplete or unaudited. | Updates are factual, approved, time-stamped, and free of unverified settlement claims. |
| Evidence and auditability | Evidence is lost, mutable, or unowned. | Local logs are retained without chain of custody. | Evidence is complete, hash-bound, immutable, and independently witnessed. |

### Thresholds and hard stops

| Total score | Result | Required action |
|---:|---|---|
| 14–16 | Strong readiness | Record minor improvements; proceed to evidence rehearsal. |
| 10–13 | Conditional readiness | Open corrective actions and repeat the affected injects before the next controlled-live gate. |
| 0–9 | Not ready | Do not advance the operational gate; require a remediation sprint and full repeat. |

Regardless of score, the exercise is an automatic failure if participants propose blind retry, manual ledger correction, deletion of evidence, promotion without exclusive ownership/quorum proof, cross-rail fallback for UNKNOWN status, resumption without reconciliation, or a claim that a timeout proves failure.

## 9. Evidence capture and after-action process

The Scribe records the attendance list, exact inject times, decisions, decision owners, evidence requested, unresolved questions, score by domain, and corrective actions. The Facilitator attaches the alert fixture version, exercise release SHA, tabletop scenario version, and sanitized decision log. Security verifies that no credentials, private keys, or real customer data entered the package.

Within two business days, owners provide corrective-action plans with priority, due date, compensating control, expiry, evidence path, and reviewer. The Independent Witness determines whether a repeat exercise is required. The Release Manager links the final exercise report to the relevant E-04, E-06, E-08, and E-09 evidence records only after independent review.

## 10. Facilitator close-out script

Read the following statement:

> “The exercise is complete. The score is not a production authorization. Any unresolved financial-integrity, monitoring, evidence, compliance, or governance gap remains a NO-GO condition for affected activity. We will preserve the decision log, assign corrective actions, and repeat any failed inject before relying on this exercise for external sign-off.”

## References

[1]: https://tigerbeetle.com/docs/reference/ "TigerBeetle reference documentation"  
[2]: https://sre.google/sre-book/managing-incidents/ "Google SRE incident management guidance"
