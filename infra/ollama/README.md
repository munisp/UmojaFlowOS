# Private Ollama runtime

The document-intelligence service uses a private Ollama runtime for KYC and KYB
**evidence only**. It never produces a verification decision: every result is
recorded as evidence that requires human review.

## Activation sequence

1. Provision Ollama on a private host with enough memory for the visual-primary
   model. Do not expose it to public ingress.
2. Run `scripts/document-intelligence/verify_private_ollama.py`. It must exit zero.
   It checks the endpoint is loopback or private, that the runtime is not
   answering on a routable address, that each allowlisted model is present with
   its exact digest, that the visual model declares `vision`, and that the text
   fallback does not.
3. Populate `ollama.env.template` values through deployment secrets. Any
   non-loopback endpoint requires either mTLS client credentials or
   `OLLAMA_AUTH_TOKEN`; the adapter refuses to run without one.
4. Run `scripts/document-intelligence/validate_evidence_only_request.py` to confirm
   the schema-constrained, evidence-only response contract holds on that host.
5. Set `OLLAMA_ENABLED=true` only after steps 2 and 4 both pass.

## Boundaries

- The digest allowlist is hard-coded in the verifier. Changing a model is a
  reviewed code change, not a configuration edit.
- `deepseek-r1:8b` is a text-only fallback. The verifier fails if it ever reports
  a `vision` capability, because that would make the role mapping unsafe.
- If the runtime is unreachable, drifted, or unauthenticated, the workflow records
  `engine_unavailable` evidence with an `unavailable` disposition. That is a real
  recorded state, not an assumed pass.

See `docs/private-ollama-verification.md` for the recorded verification results
and the measured capacity constraint in the current sandbox.
