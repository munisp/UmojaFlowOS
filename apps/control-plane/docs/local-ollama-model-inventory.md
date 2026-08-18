# Local Ollama Model Inventory

The development runtime is loopback-only at `127.0.0.1:11434`. It is not production infrastructure and is not authorised for KYC/KYB document inference.

| Role | Model | Full digest | Capability boundary |
|---|---|---|---|
| Primary visual evidence | `qwen3-vl:8b` | `901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28` | Qwen3-VL image-capable family; review-required evidence only after authorised imagery and protected activation controls are available. |
| Secondary text-only fallback | `deepseek-r1:8b` | `6995872bfe4c521a67b32da386cd21d5c6e819b6e0d62f79f64ec83be99f5763` | No vision metadata; it must not receive image inputs or replace the primary visual-evidence model. |

Both model digests come from the local Ollama tags metadata API. The adapter requires exact allowlists, a private endpoint, and strict schema validation. Neither model may make approval, rejection, adverse-action, payment, or regulator-submission decisions.

Runtime selection is fail closed: `qwen3-vl:8b` is the sole image-modality `visual_primary`; `deepseek-r1:8b` is the sole text-modality `text_fallback`. A missing or malformed exact digest blocks any evidence request.
