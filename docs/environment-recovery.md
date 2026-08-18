# Local Environment Recovery Record

This note records a sandbox reset that occurred during development, exactly what
was lost, and the verified procedure used to rebuild the local environment. It
exists so the environment can be reconstructed deterministically rather than
from memory.

## What was lost

The sandbox reset removed all locally installed services and any files outside
the checkpointed managed project:

| Component | State after reset |
| --- | --- |
| Managed project `/home/ubuntu/umojaflowos-platform` | Fully restored from checkpoint `f6eaf61f`; no source loss |
| Local PostgreSQL 16 service, database `umojaflowos_dev` | Removed entirely, including all 34 canonical tables |
| Local Ollama runtime and both 8B models | Removed entirely |
| Canonical monorepo `/home/ubuntu/UmojaFlowOS` git history | Removed; only recovery-service files remained |

No checkpointed application code was lost. The managed project is the
authoritative copy of the control plane.

## Recovery procedure (verified)

### 1. PostgreSQL

```
sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo -u postgres psql -c "CREATE ROLE ubuntu LOGIN;"
sudo -u postgres createdb -O postgres umojaflowos_dev
```

### 2. Schema

Replay every canonical migration in order, then validate invariants:

```
for f in database/postgresql/00*.sql; do
  sudo -u postgres psql -q -d umojaflowos_dev -v ON_ERROR_STOP=1 -f "$f"
done
sudo -u postgres psql -q -d umojaflowos_dev -f database/postgresql/validate_schema.sql
```

Expected result: 34 tables in `public`, and the schema validator reports the
selected-model provenance columns present on `document_analysis_jobs`.

### 3. Least-privilege grants

```
sudo -u postgres psql -q -d umojaflowos_dev -v app_role=ubuntu \
  -f database/postgresql/grants.sql
```

Expected result: 34 tables readable, 33 insertable, audit and evidence trails
append-only, no table deletable by the application role.

### 4. Canonical monorepo

The base migrations `0001`–`0009` exist only in the GitHub remote, so the
monorepo must be recovered by cloning rather than reconstructed by hand:

```
gh repo clone munisp/UmojaFlowOS /home/ubuntu/UmojaFlowOS
```

The control plane under `apps/control-plane` is then regenerated from the
managed project, which is authoritative. Copying individual files from the
managed project onto an older cloned tree produces a mismatched mirror, because
the remote's `routers.ts` and console expect an older `postgres.ts` surface.

### 5. Private Ollama runtime

```
sudo apt-get install -y zstd
curl -fsSL https://ollama.com/install.sh | sudo sh
sudo systemctl start ollama
ollama pull qwen3-vl:8b
ollama pull deepseek-r1:8b
```

Both digests must match the recorded allowlist exactly, and the listener must
remain bound to `127.0.0.1:11434`:

| Model | Role | Digest |
| --- | --- | --- |
| `qwen3-vl:8b` | visual primary | `901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28` |
| `deepseek-r1:8b` | text fallback | `6995872bfe4c521a67b32da386cd21d5c6e819b6e0d62f79f64ec83be99f5763` |

Both digests were re-verified against this allowlist after the rebuild.

## Verification after recovery

The full managed suite was re-run against the freshly rebuilt database and
runtime: **244 tests pass**. Before the Ollama models were restored, exactly two
tests failed, both selector-derived provenance regressions, and both failed
closed with `model inventory could not be read`. That is the intended behaviour
rather than a defect: an unreachable model runtime must block analysis-job
creation instead of allowing a job without provenance.

## Standing risk

Local PostgreSQL, the Ollama runtime, and any uncommitted monorepo state do not
survive a sandbox reset. The mitigations are that every schema change lives in a
numbered migration, the privilege model lives in `grants.sql`, model digests are
recorded in the inventory document, and the managed project is checkpointed
after each unit of work.
