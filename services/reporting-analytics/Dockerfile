# syntax=docker/dockerfile:1

# No [build-system]/setup.py in pyproject.toml - the repo's own Makefile
# runs this service unpackaged, via PYTHONPATH=services/reporting-analytics/src
# (see `python-check`), not `pip install .`. Mirror that here rather than
# inventing a packaging setup this repo doesn't use.
FROM python:3.11-slim-bookworm

WORKDIR /app

RUN pip install --no-cache-dir \
    "fastapi>=0.110" \
    "uvicorn>=0.27" \
    "redis>=5.0" \
    "boto3>=1.34"

COPY src ./src

ENV PYTHONPATH=/app/src \
    PORT=8084
EXPOSE 8084

RUN addgroup --system app && adduser --system --ingroup app app
USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/healthz', timeout=3)" || exit 1

CMD ["sh", "-c", "exec uvicorn umojaflowos_reporting.service:app --host 0.0.0.0 --port ${PORT}"]
