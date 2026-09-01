#!/usr/bin/env python3
"""Deterministic model test; this does not contact Kubernetes or PostgreSQL."""
import argparse
import json
from pathlib import Path


def simulate(seconds: int = 900, arrival_rate: int = 100, burst_seconds: int = 120):
    replicas = 2
    queue = 0
    worker_rate_per_replica = 16  # two workers x eight completed jobs/sec
    target_per_replica = 50
    max_replicas = 8
    events = []
    max_queue = 0
    scale_events = 0
    for second in range(seconds):
        arrivals = arrival_rate if second < burst_seconds else 0
        queue += arrivals
        completed = min(queue, replicas * worker_rate_per_replica)
        queue -= completed
        max_queue = max(max_queue, queue)
        if second % 30 == 0:
            observed = queue
            desired = max(2, min(max_replicas, (observed + target_per_replica - 1) // target_per_replica))
            if desired > replicas and second >= 60:
                new_replicas = min(replicas + 2, desired, max_replicas)
                if new_replicas != replicas:
                    replicas = new_replicas
                    scale_events += 1
                    events.append({"second": second, "action": "scale_up", "replicas": replicas, "queue": queue, "desired": desired})
            elif desired < replicas and second >= 300:
                new_replicas = max(replicas - 1, desired, 2)
                if new_replicas != replicas:
                    replicas = new_replicas
                    scale_events += 1
                    events.append({"second": second, "action": "scale_down", "replicas": replicas, "queue": queue, "desired": desired})
    return {
        "mode": "deterministic_hpa_model",
        "seconds": seconds,
        "arrival_rate_during_burst_per_second": arrival_rate,
        "burst_seconds": burst_seconds,
        "worker_rate_per_replica_per_second": worker_rate_per_replica,
        "initial_replicas": 2,
        "max_replicas": max_replicas,
        "target_pending_per_replica": target_per_replica,
        "max_queue_depth": max_queue,
        "final_queue_depth": queue,
        "final_replicas": replicas,
        "scale_events": scale_events,
        "events": events,
        "live_cluster_evidence": False,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("artifacts/staging/fabric-attestation/hpa-scaling-simulation.json"))
    args = parser.parse_args()
    result = simulate()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
