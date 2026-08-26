FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY simulators/retention_gateway/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY simulators /app/simulators

RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin worker
USER 10001:10001
EXPOSE 8080

CMD ["python", "-m", "simulators.retention_gateway.worker_service"]
