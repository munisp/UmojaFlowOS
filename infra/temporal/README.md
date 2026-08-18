# Temporal worker boundary

The Go payment-engine contains deterministic workflow logic and validates a non-empty namespace, task queue, address, and TLS requirement before a later Temporal worker can be enabled. The workflow still does not invoke external payment providers; provider activities require separate policy and credential gates.

Provision the Temporal namespace, certificate authority, worker certificate, and task queue through managed deployment configuration. Do not use an unauthenticated development server as a production workflow endpoint.
