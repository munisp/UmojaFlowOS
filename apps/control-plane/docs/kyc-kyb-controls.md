# KYC and KYB Document-Intelligence Control Requirements

## Purpose and decision boundary

This capability creates evidence for a compliance reviewer. It does not make an identity approval, business approval, payment-execution, regulatory-submission, or adverse decision. Every analysis record must end in a human-reviewable state.

| Area | Required control | Prohibited behaviour |
|---|---|---|
| Consent | Record the data subject or authorised business representative, the purpose, timestamp, document categories, and consent version before analysis. | Processing uploaded KYC or KYB documents without an associated consent record. |
| Storage | Store encrypted document bytes in approved object storage only. Keep immutable storage key, hash, MIME type, size, and source metadata in PostgreSQL. | Storing document bytes, facial images, or raw biometric templates in PostgreSQL. |
| OCR and parsing | Preserve engine name, version, source hash, extraction timestamp, confidence, and source page or region provenance. | Treating OCR text as a verified identity attribute without review. |
| Visual analysis | Use bounded input dimensions, strict JSON output, model tag, digest, prompt policy version, timeout, and unavailable state. | Allowing a visual model to return unbounded free text or silently retrying with a different model. |
| Presentation-attack risk | Record signals such as image-quality anomalies, document-screen recapture indicators, inconsistency flags, and insufficient-evidence state. | Claiming definitive liveness or automatically rejecting a person or business from a model score. |
| Reviewer decision | Require a compliance officer to select `approved`, `rejected`, `needs_information`, or `escalated`, with a rationale. | Automatically advancing a customer or business to an approved KYC or KYB state. |
| Access | Restrict document and evidence access to the assigned compliance case, with immutable activity evidence. | Broad operator access, client-side model calls, or public object URLs. |
| Retention | Enforce a policy-defined retention deadline and legal-hold state; deletion is a controlled workflow. | Indefinite retention or automatic deletion while legal hold applies. |

## KYC evidence classes

The service supports identity document, proof of address, source of funds, selfie or capture evidence, beneficial ownership information, and other authorised records. An identity-document or selfie analysis may yield a presentation-attack-risk evidence record, but it cannot yield an identity decision.

## KYB evidence classes

The service supports registration certificate, constitutional documents, director and beneficial-owner records, proof of business address, operating licence, bank evidence, and source-of-funds documentation. It may compare document consistency across a KYB packet, but authoritative registry checks remain a separately activated integration.

## Failure policy

An unavailable OCR engine, parser, local VLM, unsupported document type, invalid JSON response, file-integrity mismatch, or time limit result must create an `unavailable` or `insufficient_evidence` analysis result and route the record to a compliance reviewer. It must not be treated as a negative identity or business result.

## Sources

PaddleOCR supports structured document conversion and multilingual OCR. [1](https://github.com/PaddlePaddle/PaddleOCR) Docling supports local, multi-format document parsing and OCR with structured representations. [2](https://docling-project.github.io/docling/) NIST defines presentation-attack detection as an automated determination of a presentation attack, including liveness-related methods. [3](https://csrc.nist.gov/glossary/term/presentation_attack_detection)
