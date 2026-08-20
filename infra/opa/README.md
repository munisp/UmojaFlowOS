# OPA Gateway Policy

`umojaflowos_gateway.rego` is evaluated by APISIX only after OIDC signature, issuer, and audience validation. It denies requests by default, permits authenticated platform roles to perform read methods, and permits only named operational roles to reach write methods. It does not replace the TypeScript procedure-level PostgreSQL role checks, which remain the final authority for every business action.

OPA must run on a private network with mutually authenticated transport to APISIX. APISIX must treat an unreachable OPA service as a denial; do not enable gateway degradation for the policy plugin.
