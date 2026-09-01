#!/usr/bin/env python3
from pathlib import Path
import yaml

root = Path(__file__).parents[2]
docs = [d for d in yaml.safe_load_all((root / "infra/kubernetes/fabric-attestation-object-storage-bindings.yaml").read_text()) if d]
if {(d["kind"], d["metadata"]["name"]) for d in docs} != {("ConfigMap", "umoja-evidence-object-storage"), ("ExternalSecret", "umoja-evidence-object-storage-credentials")}:
    raise SystemExit("unexpected object-storage binding resources")
config = next(d for d in docs if d["kind"] == "ConfigMap")
for key in ("UMOJA_OBJECT_STORAGE_ENDPOINT", "UMOJA_OBJECT_STORAGE_BUCKET", "UMOJA_OBJECT_STORAGE_REGION", "UMOJA_OBJECT_STORAGE_USE_SSL"):
    if not config["data"].get(key):
        raise SystemExit(f"missing non-secret storage setting {key}")
secret = next(d for d in docs if d["kind"] == "ExternalSecret")
if secret["spec"]["secretStoreRef"] != {"name": "umoja-vault", "kind": "ClusterSecretStore"}:
    raise SystemExit("object-storage credentials must come from the approved Vault-backed store")
keys = {item["secretKey"] for item in secret["spec"]["data"]}
if keys != {"UMOJA_OBJECT_STORAGE_ACCESS_KEY_ID", "UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY"}:
    raise SystemExit("incomplete object-storage secret bindings")
print("PASS object_storage_config=true vault_secret_binding=true")
