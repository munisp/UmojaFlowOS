# UmojaFlowOS role authority matrix

This document records the approved authority model for the four operator roles.
It is the reference the console gate, the tRPC procedure gates, and the
regressions are all aligned to. Where an entry says **no**, the corresponding
action must be absent from the interface rather than merely disabled.

## Resolved question: administrator delegation

The open question was whether an administrator retains delegated access to
treasury and compliance controls, or whether those domains are exclusive to
their specialist roles. The resolution is **delegated access, with two
exclusions**.

The reasoning is operational rather than theoretical. A platform administrator
is the only role that can restore service when a specialist is unavailable, and
withholding all treasury and compliance authority would make routine recovery
impossible without creating a second privileged account, which is worse for
auditability. Delegation is therefore permitted, but it is bounded by two rules
that protect the controls whose whole value comes from separation:

1. **No self-approval.** An administrator who proposes a treasury
   recommendation cannot approve or reject it. This is enforced in the database
   helper, not only in the interface, so the boundary holds regardless of entry
   point.
2. **No auditor escalation.** The auditor role is read-only in every domain and
   is never granted a write path, because an auditor's evidentiary value depends
   on having no ability to alter the record they attest to.

Every administrator action is written to the immutable activity ledger with the
acting subject and role, so delegated use is attributable after the fact.

## Authority by domain

| Domain and action | Administrator | Compliance officer | Treasury operator | Auditor |
| --- | --- | --- | --- | --- |
| Read all ledgers and evidence | Yes | Yes | Yes | Yes |
| Register counterparty | Yes | Yes | No | No |
| Transition licence authorisation | Yes | No | No | No |
| Onboard customer, create beneficiary | Yes | Yes | No | No |
| Capture verification consent | Yes | Yes | No | No |
| Create KYC/KYB analysis job | Yes | Yes | No | No |
| Record reviewer decision on evidence | Yes | Yes | No | No |
| Review KYC document state | Yes | Yes | No | No |
| Create or transition compliance case | Yes | Yes | No | No |
| File and transition SAR/STR | No | Yes | No | No |
| Invoke multi-language contract parsers | Yes | Yes | No | No |
| Draft payment order, add payment leg | Yes | No | Yes | No |
| Transition payment order or leg (internal states) | Yes | No | Yes | No |
| Record market observation | Yes | No | Yes | No |
| Create or cancel rate lock, evaluate expiry | Yes | No | Yes | No |
| Record reconciled liquidity position | Yes | No | Yes | No |
| Propose treasury rebalancing recommendation | Yes | No | Yes | No |
| Decide a treasury recommendation | Yes, if not the proposer | No | Yes, if not the proposer | No |
| Draft regulatory report | Yes | Yes | No | No |
| Transition regulatory report lifecycle | Yes | Yes | No | No |
| Configure integration connection | Yes | Yes | No | No |
| Set corridor policy, alert policy, deadline | Yes | Yes | No | No |
| Escalate counterparty risk | Yes | No | No | No |

Two entries deserve emphasis. **SAR/STR filing is compliance-only, including
for administrators**, because a suspicious-activity report is a personal
regulatory attestation by a compliance officer and delegation would misstate who
formed the suspicion. **Counterparty risk escalation is administrator-only**,
because escalation changes the platform's own risk posture toward a
counterparty rather than assessing a customer.

## Where this matrix is enforced

The matrix is not advisory. It appears in three enforcement layers, and the
regressions assert all three agree:

| Layer | Mechanism |
| --- | --- |
| Interface visibility | `client/src/lib/consoleActionVisibility.ts` drives every module action row through one shared component |
| Transport | Role-specific tRPC procedure gates in `server/routers.ts` |
| Data | Helper-level guards in `server/postgres.ts` and `server/paymentWorkflow.ts`, plus least-privilege database grants |

An interface gate alone is never treated as sufficient, since it protects only
the rendered surface and not the procedure behind it.
