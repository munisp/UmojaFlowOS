# Permify authorization boundary

This schema is deny-by-default: a subject gains no permission until its relationship tuple is written by an approved identity-provisioning process. The Go payment-engine `authorization` package must treat an unavailable Permify decision as a denial.

The schema authorizes control-plane actions only. It does not authorize a payment provider call, a TigerBeetle transfer, sanctions screening, regulatory submission, or access to a KYC/KYB source document. Those controls remain separately enforced and activation-gated.
