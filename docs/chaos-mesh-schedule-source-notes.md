# Chaos Mesh Schedule Source Notes

The weekly staging pool-saturation Schedule is based on the official Chaos Mesh 2.8.4 scheduling documentation:

- Source: https://chaos-mesh.org/docs/define-scheduling-rules/
- Source: https://chaos-mesh.org/docs/run-a-chaos-experiment/

Key implementation constraints applied in `schedule-worker-postgres-pool-saturation-weekly.yaml`:

1. Chaos Mesh uses a `Schedule` custom resource for recurring experiments.
2. `schedule` accepts a cron expression interpreted by the Chaos controller manager timezone.
3. `historyLimit` retains experiment history, including in-progress tasks, up to the configured limit.
4. `concurrencyPolicy: Forbid` prevents overlapping scheduled experiments.
5. `startingDeadlineSeconds` bounds catch-up behavior for missed schedules.
6. A bounded `duration` is required so the injected network fault restores automatically.
7. The schedule can be paused with the `experiment.chaos-mesh.org/pause=true` annotation; removal resumes it.

The weekly configuration is staging-only, uses Sunday 03:00 controller-local time, and should only be enabled after the controller timezone has been confirmed as UTC or the cron expression has been adjusted for the cluster’s controller timezone.
