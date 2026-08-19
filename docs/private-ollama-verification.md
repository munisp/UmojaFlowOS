# Private Ollama runtime verification

This records the pre-activation verification performed against the local Ollama
runtime, and the one check that could not be completed in this environment.

## Verified controls

The verifier at `scripts/document-intelligence/verify_private_ollama.py` runs the
checks below and exits non-zero on any failure, so activation stays blocked until
all of them pass. It was executed successfully against the live runtime.

| Control | Result |
| --- | --- |
| Endpoint is loopback or private (no public ingress) | Pass — `http://127.0.0.1:11434` resolves to `127.0.0.1` |
| Listener is not reachable on the host's routable address | Pass — `ss` shows `LISTEN 127.0.0.1:11434` only, and a probe to the routable address returns no response |
| `qwen3-vl:8b` present with allowlisted digest | Pass — `901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28` |
| `deepseek-r1:8b` present with allowlisted digest | Pass — `6995872bfe4c521a67b32da386cd21d5c6e819b6e0d62f79f64ec83be99f5763` |
| Visual-primary model declares the `vision` capability | Pass — `['completion', 'vision', 'tools', 'thinking']` |
| Text-fallback model does **not** declare `vision` | Pass — `['tools', 'thinking', 'completion']` |

## Authentication control

The local runtime is loopback-only, so the access control is host isolation: the
listener is bound to `127.0.0.1` and a probe to the host's routable address gets
no response, meaning no network caller can reach it and there is no network
credential to verify.

Because that reasoning holds *only* for loopback, the adapter now enforces it
explicitly. Any endpoint that is not `localhost`, `127.0.0.1`, or `::1` crosses a
network boundary and is refused unless it presents an authentication control:

| Endpoint | Requirement |
| --- | --- |
| Loopback | Host isolation; no network credential required |
| Any other private or internal host | mTLS client credentials **or** `OLLAMA_AUTH_TOKEN`, plus `OLLAMA_TLS_CA_FILE` for certificate verification |
| Public host | Refused outright |

Six regressions in
`services/document-intelligence/tests/test_ollama_authentication.py` prove this
fails closed: a non-loopback endpoint with no credential is refused, a blank or
whitespace-only token does not count as configured, half-configured mTLS (a
certificate without its key) is refused, and both mTLS and a bearer credential are
accepted when complete. When a token is configured the adapter sends it as an
`Authorization: Bearer` header.

All of these values are read from the environment so they arrive through
deployment secrets. None is committed to the repository.

The digest allowlist is hard-coded in the verifier rather than read from the
runtime or supplied through the environment. A digest the runtime reports about
itself proves nothing, and an environment-supplied value could be changed
silently, so replacing a model is a reviewed code change.

Eight Python regressions in
`services/document-intelligence/tests/test_verify_private_ollama.py` prove the
verifier actually rejects drift: a public endpoint, an unsupported scheme, a
changed digest, a missing model, a visual model that stops declaring vision, and
a text model that starts declaring vision are each refused.

## The check that could not be completed here

A single live evidence-only inference request against `qwen3-vl:8b` could **not**
be completed in this sandbox. The runtime accepted the request and then
terminated the inference process:

```
HTTP 500 {"error":"llama-server process has terminated: signal: terminated"}
```

This is a capacity limit, not a configuration fault. The measured figures are:

| Measurement | Value |
| --- | --- |
| Sandbox total memory | 3 GB |
| Sandbox available memory at request time | ~2 GB |
| Largest model weight blob on disk | 5.8 GB |
| Combined model store | 11 GB |

An 8-billion-parameter vision model cannot be resident in roughly 2 GB of
available memory, so the process is terminated as it loads. No amount of prompt
or schema tuning changes this.

To confirm this is a capacity ceiling rather than a fault specific to the vision
model, the smaller text-only `deepseek-r1:8b` was issued a trivial eight-token
request. It failed identically:

```
{"error":"llama-server process has terminated: signal: terminated"}
```

Both models are 8B-class, so neither fits. The constraint is the host, not the
model choice or the request shape.

### Where the ceiling actually is

"Both 8B models fail" establishes that 8B is too large, but not that the
environment can run inference at all, and the difference matters: if inference
were broken for some other reason, the capacity explanation would be wrong. A
graduated probe was therefore run, pulling progressively larger models and
issuing the same trivial request to each.

| Model | On-disk size | Result |
| --- | --- | --- |
| `qwen2.5:0.5b` | 397 MB | Loaded and answered |
| `qwen2.5:1.5b` | 986 MB | Loaded and answered |
| `qwen2.5:3b` | 1.9 GB | `signal: killed` during load |
| `qwen2.5vl:3b` | 3.2 GB | `signal: terminated` during load |
| `deepseek-r1:8b` | 5.2 GB | `signal: terminated` during load |
| `qwen3-vl:8b` | 6.1 GB | `signal: terminated` during load |

Inference works in this sandbox. The ceiling sits between roughly 1 GB and
1.9 GB of model weights, against 3.9 GB total memory. That is far below any
vision model suitable for document evidence: the smallest generally available
Qwen vision model is 3B at 3.2 GB, which is already above the ceiling. The
blocked item is therefore a genuine host-capacity limit with a measured
boundary, not an untested assumption, and it cannot be worked around by
selecting a smaller vision model.

The probe models were removed afterwards, so the runtime inventory again
contains exactly the two allowlisted models and the digest verification is
unaffected.

`scripts/document-intelligence/validate_evidence_only_request.py` is the
executable validation for this step. It builds a synthetic, locally generated
image — deliberately not a KYC or KYB document — issues a schema-constrained
request, and asserts that the response parses, that the disposition stays inside
the evidence-only enum, and that no approval-shaped field appears. It should be
run on a host with sufficient memory to complete this check.

## What this means for activation

The endpoint, network boundary, authentication posture, capability declarations,
and digest allowlist are verified. The inference path itself remains
activation-gated on two conditions, both unmet here:

1. A host with enough memory to hold the visual-primary model.
2. Authorised KYC or KYB imagery, which the platform does not hold.

Until both are satisfied, the workflow records `engine_unavailable` evidence with
an `unavailable` disposition, which is a real recorded state rather than an
assumed pass. No verification decision is produced in that state.
