FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSLo /usr/local/bin/kubectl https://dl.k8s.io/release/v1.31.4/bin/linux/amd64/kubectl && \
    chmod 0555 /usr/local/bin/kubectl && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 locust && \
    useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin locust

WORKDIR /app
COPY simulators/retention_gateway/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY simulators/retention_gateway /app/simulators/retention_gateway
COPY scripts/infra/prepare_retention_worker_lock_loadtest.py /app/scripts/infra/prepare_retention_worker_lock_loadtest.py
COPY scripts/infra/summarize_retention_worker_locust.py /app/scripts/infra/summarize_retention_worker_locust.py
COPY tests/load /app/tests/load
COPY tests/chaos_mesh /app/tests/chaos_mesh
COPY infra/retention-gateway/locust-regression/run_profile.sh /app/run_profile.sh
COPY infra/retention-gateway/chaos-mesh/run_weekly_pool_saturation.sh /app/run_weekly_pool_saturation.sh
COPY scripts/infra/report_retention_pool_saturation_chaos.py /app/scripts/infra/report_retention_pool_saturation_chaos.py

RUN chmod 0555 /app/run_profile.sh /app/run_weekly_pool_saturation.sh && \
    mkdir -p /work /tmp/locust && chown -R 10001:10001 /app /work /tmp/locust

USER 10001:10001
WORKDIR /app
CMD ["/app/run_profile.sh"]
