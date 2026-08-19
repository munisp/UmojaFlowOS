# Provider credential activation, service observability, and submission feedback

This document records three additions to the console and the services behind
it: an administrator interface for supplying provider credentials, a status
dashboard reporting the health of the Go, Rust, and Python services, and a
consistent submission-feedback convention across every console form. Each
section states what was built, the property it is intended to hold, and the
evidence that the property actually holds.

## Provider credential configuration

The interface asks for the **name of a deployment secret**, never the secret
itself. This is the central design decision and the rest follows from it. A
credential typed into a browser field would travel through the page, a request
body, and very likely a log line before reaching storage; naming a secret that
the deployment already holds avoids all three. `assertIsSecretReferenceNotSecret`
refuses values shaped like credentials — provider key prefixes, bearer tokens,
JWTs, long hex strings, and PEM headers — so a pasted key is rejected at the
boundary rather than stored.

The endpoint is validated separately: it must be an absolute `https` URL and
must not embed credentials in its userinfo component, which is the other common
way a secret ends up in a stored string.

| Property | Enforcement | Evidence |
| --- | --- | --- |
| A credential value cannot be stored | `assertIsSecretReferenceNotSecret` rejects five credential shapes | `integrationCredentialActivation.integration.test.ts` |
| The schema holds no credential column | Only `secret_reference` exists on `integration_connections` | `providerActivationGate.test.ts`, asserted against the live schema |
| No credential-entry field is offered | The form exposes a secret *name* field only | `IntegrationCredentialControls.test.tsx` |
| Configuration alone activates nothing | Configuring moves the row to `credential_pending` | `integrationCredentialActivation.integration.test.ts` |
| Only administrators may configure | `adminProcedure` on all three mutations | `integrationCredentialRbac.test.ts` |

## Verified activation

An integration becomes `active` **only** when a real request to the provider
returned a 2xx. The check is performed server-side by `providerHealthCheck.ts`
against the configured endpoint using the named deployment secret. Every other
outcome — a rejected credential, a server error, a redirect, an unreachable
host, a timeout — is recorded as an explicit failure with the observed status
and detail, and the integration stays inactive.

Two subtleties are worth stating, because both would otherwise produce a system
that looks activated without being so:

> A redirect is treated as a failure, not a success. A 302 to a login page is a
> common response to an unauthenticated request, and following it would let an
> unauthenticated redirect masquerade as a healthy provider.

> Re-crediting a live integration is refused until it is suspended. Silently
> re-pointing an active integration would change which provider it talks to with
> no visible state change, and the previous passing health check would appear to
> vouch for a credential it never tested. Suspension clears the recorded result.

## Service health and metrics

Each service exposes `/metrics` alongside `/healthz`. The counters are
**observed**, not declared: the Go engine increments as it validates orders, the
Rust services increment inside their route handlers, and the Python service
counts through middleware so a route cannot serve traffic without being counted.
Implementing this surfaced a real defect in the ledger gateway, where the
imbalance counter was declared but never incremented, so it would have reported
zero rejected postings indefinitely.

The control plane collects status through the existing service bridge, so an
unconfigured service is reported as **disabled** rather than as broken — a
distinction the dashboard preserves visually, because the operator response to
the two is entirely different. A counter the service did not report is omitted
rather than shown as zero; an invented zero would read as "nothing is
happening", which is a claim the platform has no basis to make.

A failure to *collect* status is likewise distinguished from a service failure:
if the operator lacks permission or the collection itself errors, the panel says
so explicitly rather than implying the services are unhealthy.

## Submission feedback

All twelve console forms now report submission state through one shared
component. The convention it encodes:

- **In flight** is announced politely (`aria-live="polite"`), so a submission
  starting does not interrupt a screen-reader user mid-sentence.
- **A slow request** escalates to an explicit "do not resubmit" only after two
  seconds. A shorter threshold would fire on nearly every submission and stop
  carrying information; the warning matters because the dangerous behaviour is
  an operator resubmitting a payment-adjacent action they believe failed.
- **A refusal** is shown in place, assertively, with the server's own message
  kept verbatim and paired with a statement that nothing was recorded. Refusals
  in this platform are operational information — a consumed rate lock, a missing
  authorised channel reference — and paraphrasing them destroys their value.
- **A retry** clears the previous refusal, so an error is never displayed
  alongside a request that is currently in flight.

`submitFeedbackCoverage.test.ts` asserts structurally that every form renders
the feedback element, accepts an error, and is supplied one from its own
mutation in the console. Verified by removing the element from one form, which
fails the guard.
