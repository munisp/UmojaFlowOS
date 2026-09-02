#!/usr/bin/env python3
"""Deterministic HPA model with per-job latency timestamps.

This models queue scheduling only; it does not contact Kubernetes, PostgreSQL, or Fabric.
"""
import argparse
import json
from collections import deque
from pathlib import Path


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered) - 1) * p
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    fraction = rank - low
    return ordered[low] + (ordered[high] - ordered[low]) * fraction


def stats(values):
    buckets = [0, 1, 2, 5, 10, 20, 30, 45, 60, 90, 120]
    histogram = {}
    for upper in buckets:
        histogram[f"le_{upper}s"] = sum(1 for value in values if value <= upper)
    histogram["le_inf"] = len(values)
    return {
        "count": len(values),
        "min_seconds": min(values) if values else None,
        "p50_seconds": percentile(values, 0.50),
        "p95_seconds": percentile(values, 0.95),
        "p99_seconds": percentile(values, 0.99),
        "max_seconds": max(values) if values else None,
        "mean_seconds": sum(values) / len(values) if values else None,
        "histogram_cumulative_counts": histogram,
    }


def simulate(seconds=900, arrival_rate=100, burst_seconds=120):
    replicas = 2
    queue = deque()
    completed_jobs = []
    scale_events = []
    max_queue = 0
    worker_rate_per_replica = 16
    target_per_replica = 50
    max_replicas = 8
    next_job_id = 1

    for second in range(seconds):
        arrivals = arrival_rate if second < burst_seconds else 0
        for _ in range(arrivals):
            queue.append({"id": next_job_id, "enqueued_at": float(second), "first_claimed_at": None})
            next_job_id += 1

        # A completion slot represents one second of worker service. Jobs admitted at
        # second t complete at t+1, preserving non-zero queue and processing latency.
        capacity = replicas * worker_rate_per_replica
        for _ in range(min(len(queue), capacity)):
            job = queue.popleft()
            job["first_claimed_at"] = float(second)
            job["completed_at"] = float(second + 1)
            job["queue_wait_seconds"] = job["first_claimed_at"] - job["enqueued_at"]
            job["processing_seconds"] = job["completed_at"] - job["first_claimed_at"]
            job["end_to_end_seconds"] = job["completed_at"] - job["enqueued_at"]
            completed_jobs.append(job)

        max_queue = max(max_queue, len(queue))

        # Prometheus Adapter samples every 30 seconds. Scale-down is intentionally
        # faithful to the Helm HPA: five-minute stabilization and one pod per 120s.
        if second % 30 == 0:
            observed = len(queue)
            desired = max(2, min(max_replicas, (observed + target_per_replica - 1) // target_per_replica))
            if desired > replicas and second >= 60:
                new_replicas = min(replicas + 2, desired, max_replicas)
                if new_replicas != replicas:
                    replicas = new_replicas
                    scale_events.append({"second": second, "action": "scale_up", "replicas": replicas, "queue": observed, "desired": desired})
            elif desired < replicas and second >= 300 and (not scale_events or second - scale_events[-1]["second"] >= 120):
                new_replicas = max(replicas - 1, desired, 2)
                if new_replicas != replicas:
                    replicas = new_replicas
                    scale_events.append({"second": second, "action": "scale_down", "replicas": replicas, "queue": observed, "desired": desired})

    queue_wait = [job["queue_wait_seconds"] for job in completed_jobs]
    processing = [job["processing_seconds"] for job in completed_jobs]
    end_to_end = [job["end_to_end_seconds"] for job in completed_jobs]
    return {
        "mode": "deterministic_hpa_model_with_job_timestamps",
        "seconds": seconds,
        "arrival_rate_during_burst_per_second": arrival_rate,
        "burst_seconds": burst_seconds,
        "worker_rate_per_replica_per_second": worker_rate_per_replica,
        "initial_replicas": 2,
        "max_replicas": max_replicas,
        "target_pending_per_replica": target_per_replica,
        "max_queue_depth": max_queue,
        "final_queue_depth": len(queue),
        "final_replicas": replicas,
        "scale_events": len(scale_events),
        "events": scale_events,
        "completed_jobs": len(completed_jobs),
        "uncompleted_jobs": len(queue),
        "latency_seconds": {
            "queue_wait": stats(queue_wait),
            "processing": stats(processing),
            "end_to_end": stats(end_to_end),
        },
        "live_cluster_evidence": False,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("artifacts/staging/fabric-attestation/hpa-scaling-latency.json"))
    args = parser.parse_args()
    result = simulate()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
