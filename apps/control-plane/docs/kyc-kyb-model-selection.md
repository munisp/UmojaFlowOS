# KYC and KYB Local Model Selection Record

## Decision

The recommended local visual-analysis model is **`qwen3-vl:8b` through an isolated, private Ollama runtime**. It should be used only to create structured, review-required evidence for document coherence, image-quality signals, suspected presentation attacks, and KYB document consistency. It must never approve an identity, a business, a payment, or a regulatory filing.

`qwen3-vl:8b` is the appropriate initial production profile because the official Ollama library identifies it as image-capable and lists a 6.1 GB model footprint with a 256K context window. It is materially more capable than the small profiles while avoiding the 20–143 GB footprint of the 30B–235B profiles. A 30B or 32B profile may be evaluated later on a separately provisioned GPU host using real, consented evaluation data and measured review outcomes. [1]

The stack uses **PaddleOCR** as the deterministic OCR layer, **Docling** for multi-format structure extraction, and Qwen-VL only for bounded visual analysis and schema-constrained cross-checking. PaddleOCR provides structured JSON or Markdown conversion and supports a wide language set; Docling provides local document parsing, OCR, confidence-oriented document representations, and multi-format ingestion. [2] [3]

DeepSeek should not be the primary image-analysis engine unless a vision-capable tag is explicitly selected and verified. The Ollama catalogue currently distinguishes `deepseek-ocr` as a vision model while the common DeepSeek reasoning families are text-oriented. DeepSeek is therefore reserved for text-only evidence synthesis or secondary reasoning where its selected tag and capability have been verified. [4]

## Controls

| Control | Requirement |
|---|---|
| Deployment boundary | Ollama runs in an isolated private runtime; it is not placed in the 1 vCPU / 512 MB WebDev container. |
| Evidence-only result | Outputs use a strict JSON schema, include model tag and digest, and produce `review_required`, `unavailable`, or `insufficient_evidence` states. |
| Human decision | A compliance reviewer must make any KYC or KYB disposition. No model signal is an approval or adverse action. |
| Presentation attacks | Image and selfie analysis is classified as **presentation-attack risk evidence**, consistent with NIST's definition of PAD as automated determination of a presentation attack. It is not asserted to be definitive liveness proof. [5] |
| Inputs | The service processes S3-referenced files only after consent, file-type, size, malware, and authorization controls; it does not persist raw document bytes in PostgreSQL. |
| Failure posture | An unavailable model, unsupported image modality, malformed output, timeout, or low-confidence signal blocks automated progression and opens manual review. |

## Activation profile

1. Provision a private Ollama host with a Qwen3-VL 8B runtime and sufficient CPU/GPU, memory, storage, and network isolation.
2. Register its authenticated endpoint and allowed model digest through protected deployment configuration.
3. Run a consented, labelled evaluation suite covering Nigeria (NGN), Kenya (KES), and South Africa (ZAR) identity and business-document formats; retain measured false-positive and false-negative outcomes.
4. Activate only the review-required evidence route after compliance sign-off. Provider and government-registry verification remains separately gated.

## Local development verification

The local development runtime is bound to `127.0.0.1:11434` and must never be treated as production infrastructure. The verified local model is `qwen3-vl:8b`, with Ollama digest `901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28`. The runtime reports `vision` among its capabilities. The adapter must allowlist this exact digest and emit only review-required evidence. A production runtime requires a separately provisioned private host, access boundary, and model-verification step.

## References

[1]: https://ollama.com/library/qwen3-vl
[2]: https://github.com/PaddlePaddle/PaddleOCR
[3]: https://docling-project.github.io/docling/
[4]: https://ollama.com/search?q=deepseek
[5]: https://csrc.nist.gov/glossary/term/presentation_attack_detection
