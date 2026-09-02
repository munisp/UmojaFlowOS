# Post-Exercise After-Action Report (AAR)

## TigerBeetle Split-Brain Tabletop Exercise

**Document status:** `DRAFT` / `FINAL`  
**Exercise ID:** `TB-TTX-YYYYMMDD-NNN`  
**Exercise date/time:** `YYYY-MM-DD HH:MM UTC`  
**Facilitator:** `[name / subject]`  
**Independent witness:** `[name / subject]`  
**Release SHA:** `[40-character Git SHA]`  
**Environment:** `tabletop / staging`  
**Related evidence:** `E-04`, `E-06`, `E-08`, `E-09`

> This report records a discussion exercise. It is not production incident evidence, a regulatory approval, or authorization to activate live customer payment processing.

## 1. Executive summary

**Exercise objective:** `[state the control objectives tested]`  
**Overall result:** `PASS / CONDITIONAL / FAIL`  
**Total score:** `[0–16] / 16`  
**Hard-stop invoked:** `YES / NO`  
**Primary conclusion:** `[one paragraph describing whether the team detected, contained, reconciled, recovered, communicated, and governed the simulated event safely]`

**Management decision:** `[continue / remediate and repeat / escalate to release gate / maintain NO-GO]`  
**Decision owner:** `[name / role / subject]`  
**Decision timestamp:** `[RFC 3339]`

## 2. Scope and assumptions

| Item | Recorded value |
|---|---|
| Systems in scope | TigerBeetle, payment engine, PostgreSQL projection, provider rails, Prometheus/Alertmanager, WORM evidence store, Keycloak/Vault/HSM where applicable. |
| Customer impact | `none — tabletop only` or `[authorized staging impact]` |
| Financial activity | `none — no live funds and no real provider replay]` |
| Test data | `[fictional/synthetic/authorized staging identifiers]` |
| Product boundary | `[approved product-boundary reference]` |
| RTO/RPO assumptions | `[approved values and source]` |
| Communications scope | `[internal / provider / customer / compliance / regulatory simulation]` |

## 3. Participants and independence

| Name/subject | Role | Organization | Exercise responsibility | Independent of execution? | Conflict/recusal recorded? |
|---|---|---|---|---|---|
|  | Incident Commander |  |  |  |  |
|  | Engineering |  |  |  |  |
|  | Payment Operations |  |  |  |  |
|  | Treasury/Ledger Witness |  |  |  |  |
|  | Security |  |  |  |  |
|  | Compliance/MLRO |  |  |  |  |
|  | Communications |  |  |  |  |
|  | Independent Witness |  |  |  |  |

## 4. Scenario and inject record

| Sequence | Planned inject | Actual time | Team response | Expected control | Met? | Evidence reference |
|---:|---|---|---|---|---|---|
| 1 | Consensus errors and elevated ledger latency |  |  | Verify telemetry, quorum, membership, recent changes; no retry. |  |  |
| 2 | Divergent node membership views |  |  | Declare severity, page roles, prepare settlement fence. |  |  |
| 3 | Timed-out payments with no provider confirmation |  |  | Hold UNKNOWN, suppress retry/fallback, protect leases. |  |  |
| 4 | PostgreSQL posting intent without matching ledger fact |  |  | Open discrepancy; use read-only reconciliation. |  |  |
| 5 | Provider requests replay |  |  | Refuse replay; request original status. |  |  |
| 6 | Proposed standby promotion |  |  | Reject until identity, quorum, fencing, ownership, schema, and consistency are proven. |  |  |
| 7 | Alert receiver delay |  |  | Treat visibility loss as unsafe; maintain suspension. |  |  |
| 8 | One commit, one non-submit, one unresolved operation |  |  | Record only proven outcomes; retain one UNKNOWN/held. |  |  |
| 9 | Network convergence and quorum recovery |  |  | Verify recovery gates before write enablement. |  |  |
| 10 | Bounded canary proposal |  |  | Require independent approval, reconciliation, and rollback readiness. |  |  |

## 5. Decision and action timeline

| Time UTC | Decision/action | Owner | Authority/reference | Result | Evidence path/digest |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

Record facts and decisions separately. Do not convert an assumption into a confirmed ledger outcome. For any simulated UNKNOWN operation, record the idempotency key, payload digest, provider request ID, ledger lookup result, and reconciliation decision.

## 6. Root-cause analysis tracking

Use a causal method such as five-whys, fault-tree analysis, or timeline analysis. Root cause must be supported by evidence or explicitly labeled as a hypothesis.

| RCA ID | Observed failure | Immediate cause | Contributing factors | Control failure | Root-cause hypothesis | Evidence supporting/refuting | Confidence | Owner | Due date |
|---|---|---|---|---|---|---|---|---|---|
| RCA-001 |  |  |  |  |  |  | `low/medium/high` |  |  |
| RCA-002 |  |  |  |  |  |  | `low/medium/high` |  |  |

### Five-whys record

**Problem statement:** `[specific observable problem]`  

| Why | Answer | Evidence reference |
|---:|---|---|
| 1 |  |  |
| 2 |  |  |
| 3 |  |  |
| 4 |  |  |
| 5 |  |  |

**Root cause classification:** `technical / process / people / vendor / governance / unknown`  
**Residual uncertainty:** `[what remains unproven]`

## 7. Control effectiveness and score

| Domain | Score 0–2 | Evidence observed | Gap | Owner |
|---|---:|---|---|---|
| Detection and severity |  |  |  |  |
| Settlement containment |  |  |  |  |
| Cluster authority |  |  |  |  |
| Financial reconciliation |  |  |  |  |
| Recovery and rollback |  |  |  |  |
| Compliance and customer impact |  |  |  |  |
| Communications and governance |  |  |  |  |
| Evidence and auditability |  |  |  |  |
| **Total** | **/16** |  |  |  |

**Automatic failure check:** blind retry, manual ledger edit, audit-evidence deletion, unsafe promotion, UNKNOWN cross-rail fallback, resumption without reconciliation, or treating timeout as failure.  
**Hard-stop triggered:** `YES / NO`  
**Reason:** `[reference specific decision/timestamp]`

## 8. Evidence and audit-trail assessment

| Evidence class | Present? | Integrity verified? | Immutable retention? | Independent review? | Gap/CAP reference |
|---|---|---|---|---|---|
| Alert and dashboard records |  |  |  |  |  |
| Cluster/node state |  |  |  |  |  |
| Fence and lease records |  |  |  |  |  |
| Payment/provider correlation |  |  |  |  |  |
| Ledger/DB reconciliation |  |  |  |  |  |
| Communications |  |  |  |  |  |
| Recovery and rollback |  |  |  |  |  |
| WORM/object-lock metadata |  |  |  |  |  |

## 9. Corrective Action Plan (CAP)

| CAP ID | Finding/RCA | Corrective action | Preventive action | Priority | Owner | Resources | Dependency | Success criterion | Evidence required | Target date | Expiry | Status | Approver |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CAP-001 |  |  |  | `P0/P1/P2` |  |  |  |  |  |  |  | `open` |  |

CAP actions must be specific, testable, and linked to a release gate. “Monitor more closely” is not sufficient without a metric, threshold, alert route, owner, and test. Any compensating control must have an expiry/retest date and an approving authority.

## 10. Evidence-to-CAP mapping

| Evidence gate | Required closure | Supporting CAP IDs | Evidence path | Independent reviewer | Status |
|---|---|---|---|---|---|
| E-04 | TigerBeetle quorum, account binding, idempotency, recovery, and reconciliation proof |  |  |  |  |
| E-06 | Controlled failure, health gate, rollback, and post-rollback reconciliation |  |  |  |  |
| E-08 | Failover, restore, RTO/RPO, WORM, alerting, and recovery evidence |  |  |  |  |
| E-09 | Independent security review, immutable manifest, digest and signature verification |  |  |  |  |

## 11. Re-test and closure criteria

The exercise must be repeated when a hard-stop is triggered, when the score is below 10/16, when a P0 CAP remains open, when a new root cause changes the control design, or when a material external dependency was unavailable during the exercise. CAP closure requires the action to be implemented, tested, evidenced, independently reviewed, and linked to the release SHA or approved exercise version.

**Re-test required:** `YES / NO`  
**Planned re-test date:** `[date]`  
**Re-test scope:** `[injects/domains]`  
**Closure authority:** `[role/subject]`

## 12. Approval and attestation

| Role | Name/subject | Attestation scope | Signature/evidence reference | Timestamp |
|---|---|---|---|---|
| Incident Commander |  | Accuracy of timeline and decisions |  |  |
| Security Owner |  | Security and evidence integrity |  |  |
| Compliance Owner/MLRO |  | Compliance and customer impact |  |  |
| Operations Owner |  | Recovery and operational readiness |  |  |
| Independent Witness |  | Independent review and closure recommendation |  |  |

**Final disposition:** `closed / conditional / failed / repeat required`  
**Regulatory status:** `unchanged — tabletop does not by itself change NO-GO/GO status`  
**Final reviewer comments:** `[text]`

## References

[1]: https://tigerbeetle.com/docs/reference/ "TigerBeetle reference documentation"  
[2]: https://sre.google/sre-book/managing-incidents/ "Google SRE incident management guidance"
