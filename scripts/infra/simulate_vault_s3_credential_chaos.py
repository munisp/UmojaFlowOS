#!/usr/bin/env python3
"""Deterministic credential-chaos simulation; it does not contact Vault or S3."""
import argparse
import json
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Job:
    job_id: int
    state: str = "pending"
    submissions: int = 0
    reads: int = 0
    reason: str = ""


def run(workers: int = 8, jobs: int = 96):
    queue = [Job(i) for i in range(jobs)]
    events = []
    secret_version = 1
    storage_credentials_valid = True
    successful_reads = 0
    blocked_reads = 0
    completed = 0
    unknown = 0
    for tick in range(20):
        if tick == 2:
            secret_version = 2
            events.append({"tick": tick, "event": "vault_rotation_succeeded", "version": secret_version})
        if tick == 4:
            storage_credentials_valid = False
            events.append({"tick": tick, "event": "s3_credentials_expired", "version": secret_version})
        if tick == 7:
            secret_version = 3
            storage_credentials_valid = True
            events.append({"tick": tick, "event": "vault_compensating_rotation_and_s3_revalidation_succeeded", "version": secret_version})
        active = [job for job in queue if job.state in {"pending", "unknown"}][:workers]
        for job in active:
            if job.state == "unknown":
                job.reads += 1
                if storage_credentials_valid:
                    job.state = "complete"
                    completed += 1
                    successful_reads += 1
                else:
                    job.reason = "s3_credentials_expired"
                    blocked_reads += 1
                continue
            job.reads += 1
            if not storage_credentials_valid:
                job.state = "unknown"
                job.reason = "s3_credentials_expired"
                unknown += 1
                blocked_reads += 1
                events.append({"tick": tick, "event": "job_held_unknown", "job_id": job.job_id, "reason": job.reason, "blind_retry": False})
                continue
            job.submissions += 1
            job.state = "complete"
            completed += 1
            successful_reads += 1
    if any(job.submissions > 1 for job in queue):
        raise AssertionError("duplicate submission occurred")
    if any(job.state == "unknown" for job in queue):
        raise AssertionError("recovered run left UNKNOWN jobs unresolved")
    if completed != jobs:
        raise AssertionError(f"not all jobs recovered: {completed}/{jobs}")
    if blocked_reads == 0 or unknown == 0:
        raise AssertionError("expired credential failure did not produce UNKNOWN work")
    result = {
        "mode": "deterministic_vault_s3_credential_chaos",
        "workers": workers,
        "jobs": jobs,
        "vault_rotations": 2,
        "expired_credential_window_ticks": [4, 6],
        "successful_evidence_reads": successful_reads,
        "blocked_evidence_reads": blocked_reads,
        "jobs_held_unknown": unknown,
        "completed_jobs": completed,
        "duplicate_submissions": sum(max(0, job.submissions - 1) for job in queue),
        "blind_retries": 0,
        "final_secret_version": secret_version,
        "events": events,
        "fail_closed": True,
        "live_external_services": False,
    }
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("artifacts/staging/fabric-attestation/vault-s3-credential-chaos.json"))
    args = parser.parse_args()
    result = run()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
