# syntax=docker/dockerfile:1

# paddleocr/docling pull in opencv-python + torch transitively - by far the
# heaviest of the 6 services (large image, long build). No [build-system] in
# pyproject.toml here either (same as reporting-analytics) - the repo runs
# this unpackaged via PYTHONPATH, not `pip install .`; mirrored below.
FROM python:3.11-slim-bookworm

WORKDIR /app

# libgl1/libglib2.0-0/libsm6/libxext6/libxrender1: opencv-python's runtime
# .so deps, missing from slim by default (ImportError: libGL.so.1 etc.).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
  && rm -rf /var/lib/apt/lists/*

# docling/paddleocr pull in torch transitively. Left to resolve normally,
# pip grabs PyPI's default CUDA-enabled torch wheel - several GB of NVIDIA
# driver libraries (nvidia_cublas, nvidia_nccl, triton, ...) that a CPU-only
# cluster node will never load, ballooning both the download and the image
# for no benefit. --extra-index-url points pip at PyTorch's CPU-only wheel
# index first; pip still falls back to PyPI for every package that index
# doesn't host.
RUN pip install --no-cache-dir \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    "fastapi>=0.110" \
    "uvicorn>=0.27" \
    "httpx>=0.27" \
    "pydantic>=2.7" \
    "pillow>=10.0" \
    "paddleocr>=3.0" \
    "docling>=2.0" \
    "python-multipart>=0.0.20"

COPY src ./src

ENV PYTHONPATH=/app/src \
    PORT=8085
EXPOSE 8085

RUN addgroup --system app && adduser --system --ingroup app --home /home/app app \
  && mkdir -p /home/app/.paddlex /home/app/.cache && chown -R app:app /home/app
ENV HOME=/home/app
USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/healthz', timeout=3)" || exit 1

CMD ["sh", "-c", "exec uvicorn umojaflowos_document_intelligence.service:app --host 0.0.0.0 --port ${PORT}"]
