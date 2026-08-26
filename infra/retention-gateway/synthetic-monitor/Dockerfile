FROM python:3.12-slim

RUN groupadd --gid 10001 monitor \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /app monitor

WORKDIR /app
COPY simulators/retention_gateway/synthetic_circuit_monitor.py /app/synthetic_circuit_monitor.py

RUN pip install --no-cache-dir --disable-pip-version-check \
      prometheus-client==0.21.1 \
      requests==2.32.3 \
    && chown -R monitor:monitor /app

USER 10001:10001
EXPOSE 9468
ENTRYPOINT ["python", "/app/synthetic_circuit_monitor.py"]
