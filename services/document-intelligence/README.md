# UmojaFlowOS Document Intelligence

This FastAPI service processes consented KYC and KYB documents with PaddleOCR, Docling, and an optional private Ollama Qwen-VL endpoint. It stores no document bytes in PostgreSQL. Its outputs are review-required evidence only.

## Deployment boundary

Deploy this service on a private runtime with sufficient model resources, isolated object storage access, and a private Ollama endpoint. Do not deploy it in the WebDev 1 vCPU / 512 MB container. Set `OLLAMA_BASE_URL` and pin `OLLAMA_VISION_MODEL=qwen3-vl:8b` plus the verified model digest in deployment configuration.

## API contract

`POST /v1/analyse` accepts a binary upload and an `x-umojaflowos-analysis-request` JSON header. The declared document hash, MIME type, consent reference, and case/document class are validated before analysis. A missing engine or VLM yields review-required unavailable evidence rather than approval or rejection.

