"""Model registry and versioning.

Two backed modes:
  * MLflow tracking server, when MLFLOW_TRACKING_URI is set (this fixes the
    platform gap "MLflow code exists but no tracking server" by providing the
    client integration AND a runnable server command in infra/mlflow/).
  * Durable local registry (JSON + content-addressed weights) that always
    works, used by CI and as an offline fallback.

Every registration records weights sha256, metrics, provenance and stage
(none -> staging -> production), enabling A/B champion/challenger selection.
"""
from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from .schemas import TrainedArtifact, utcnow

STAGES = ["none", "staging", "production"]


@dataclass
class RegisteredModel:
    name: str
    version: str
    stage: str
    artifact: TrainedArtifact
    weights_path: Path


class ModelRegistry:
    def __init__(self, root: Path | str, mlflow_tracking_uri: str | None = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_path = self.root / "registry.json"
        self.mlflow_uri = mlflow_tracking_uri

    # ------------------------------------------------------------ local store
    def _load(self) -> dict:
        if self.index_path.exists():
            return json.loads(self.index_path.read_text())
        return {"models": {}}

    def _save(self, data: dict) -> None:
        self.index_path.write_text(json.dumps(data, indent=2, sort_keys=True))

    def register(self, artifact: TrainedArtifact, weights_path: Path | str, stage: str = "staging") -> RegisteredModel:
        assert stage in STAGES
        weights_path = Path(weights_path)
        model_dir = self.root / artifact.model_name / artifact.version
        model_dir.mkdir(parents=True, exist_ok=True)
        dest = model_dir / weights_path.name
        if weights_path.resolve() != dest.resolve():
            shutil.copy2(weights_path, dest)
        (model_dir / f"{artifact.model_name}-{artifact.version}.json").write_text(artifact.to_json())

        data = self._load()
        entry = {
            "name": artifact.model_name,
            "version": artifact.version,
            "stage": stage,
            "weights_sha256": artifact.weights_sha256,
            "metrics": artifact.metrics,
            "registered_at": utcnow().isoformat(),
        }
        versions = data["models"].setdefault(artifact.model_name, {})
        versions[artifact.version] = entry
        self._save(data)

        self._mlflow_log(artifact, dest)
        return RegisteredModel(artifact.model_name, artifact.version, stage, artifact, dest)

    def promote(self, name: str, version: str, stage: str) -> None:
        assert stage in STAGES
        data = self._load()
        versions = data["models"].get(name, {})
        if version not in versions:
            raise KeyError(f"{name}:{version} is not registered")
        if stage == "production":
            for v in versions.values():
                if v["stage"] == "production":
                    v["stage"] = "staging"  # single champion per model family
        versions[version]["stage"] = stage
        versions[version]["promoted_at"] = utcnow().isoformat()
        self._save(data)

    def get(self, name: str, version: str | None = None, stage: str | None = None) -> RegisteredModel:
        data = self._load()
        versions = data["models"].get(name, {})
        if not versions:
            raise KeyError(f"model family {name} has no registered versions")
        chosen = None
        if version:
            chosen = versions.get(version)
        elif stage:
            candidates = [v for v in versions.values() if v["stage"] == stage]
            if candidates:
                chosen = sorted(candidates, key=lambda v: v["registered_at"])[-1]
        else:
            chosen = sorted(versions.values(), key=lambda v: v["registered_at"])[-1]
        if chosen is None:
            raise KeyError(f"no version of {name} matches version={version} stage={stage}")
        model_dir = self.root / name / chosen["version"]
        artifact = TrainedArtifact.from_json((model_dir / f"{name}-{chosen['version']}.json").read_text())
        weights = model_dir / f"{name}-{chosen['version']}.pt"
        return RegisteredModel(name, chosen["version"], chosen["stage"], artifact, weights)

    def list_versions(self, name: str) -> list[dict]:
        return sorted(self._load()["models"].get(name, {}).values(), key=lambda v: v["registered_at"])

    # ------------------------------------------------------------------ mlflow
    def _mlflow_log(self, artifact: TrainedArtifact, weights_path: Path) -> None:
        if not self.mlflow_uri:
            return
        try:
            import mlflow  # optional dependency
            mlflow.set_tracking_uri(self.mlflow_uri)
            mlflow.set_experiment(f"umojaflowos-{artifact.model_name}")
            with mlflow.start_run(run_name=f"{artifact.model_name}-{artifact.version}"):
                mlflow.log_params({
                    "version": artifact.version, "seed": artifact.seed,
                    "n_train": artifact.n_train, "epochs_run": artifact.epochs_run,
                })
                mlflow.log_metrics(artifact.metrics)
                mlflow.log_artifact(str(weights_path))
                mlflow.set_tag("data_provenance", artifact.data_provenance)
                mlflow.set_tag("advisory_only", "true")
        except Exception as exc:  # tracking server unreachable -> local registry remains authoritative
            import logging
            logging.getLogger(__name__).warning("MLflow logging skipped: %s", exc)
