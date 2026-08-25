FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app/src

WORKDIR /app
RUN pip install --no-cache-dir "fastapi>=0.110" "uvicorn>=0.27" "redis>=5.0" "boto3>=1.34"
COPY src ./src

RUN useradd --system --create-home --uid 10001 umoja
USER 10001:10001
EXPOSE 8083
ENTRYPOINT ["python", "-m", "uvicorn", "umojaflowos_reporting.service:app", "--host", "0.0.0.0", "--port", "8083"]
