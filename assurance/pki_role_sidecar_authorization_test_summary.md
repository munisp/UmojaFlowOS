# PKI Role-Sidecar Authorization Test Summary

## Scope

This report summarizes the local unit and coverage verification for `scripts/infra/verify_role_sidecar_authorization.py`. The tests were executed independently of Kind and Kubernetes.

## Final unit-test result

The complete pytest suite passed:

```text
62 passed in 2.49s
pytest_exit_code=0
coverage_report_exit_code=0
coverage_html_exit_code=0
```

The test inventory covers four-role subject and key authorization, expiration and validity windows, explicit and signed CRL revocation, malformed PEM/DER CRL inputs, OCSP GOOD/REVOKED/UNKNOWN/stale responses, responder identity, delegated responder CRL handling, multi-intermediate paths, path depth and cycle handling, pinned trust-anchor configuration, SHA-256 fingerprint checks, public-key dispatch, and CLI/fail-closed behavior.

## Coverage result

The final coverage report is:

| Metric | Result |
|---|---:|
| Statements | 401 |
| Missed statements | 43 |
| Statement execution ratio | 89.3% |
| Combined Coverage.py `Cover` value | 87% |
| Branch outcomes measured | 166 |
| Partial branches | 23 |
| HTML report | `artifacts/pki-role-authorization-coverage/htmlcov-final/index.html` |

Coverage.py's terminal `Cover` column combines statement and branch information. It should not be interpreted as a standalone statement percentage. The raw statement ratio is 358/401, or approximately 89.3%.

## Remaining statement ranges

```text
74, 154-156, 166, 195, 199-201, 211,
232-233, 239, 246-247, 275-277, 291->264,
297-299, 312, 313->exit, 327, 345-346, 348,
435, 438-443, 448, 453, 468, 473, 475,
518, 522-526, 563
```

The remaining gaps are concentrated in alternate responder-key-hash identity handling, additional CA/path-length failures, pinned-anchor edge conditions, selected delegated OCSP response branches, stale/serial OCSP paths, and CLI entry/error combinations. The implementation should not be marked fully covered until those reachable security branches are either tested or deliberately removed with documented justification.

## Kind/Istio sandbox requirements

The sandbox has Docker Engine installed and available through `sudo`, but the ordinary user cannot access `/var/run/docker.sock`. The installed Docker daemon is otherwise reachable through sudo. Kind cluster creation fails because the host kernel does not expose the iptables `raw` table required by Docker bridge networking:

```text
failed to set up container networking
iptables ... can't initialize iptables table `raw`
Table does not exist
```

The environment also does not provide a usable user-level systemd session for rootless Docker. The current sandbox therefore cannot produce live Kind/Istio evidence.

## Supported alternatives

### Authorized staging Kubernetes cluster

Run the harness against an approved cluster with Istio already installed, or adapt the harness to use a configured kube-context. This is the preferred route for regulatory evidence because it exercises real Kubernetes, Istio, traffic shifting, and rollback controls.

### External Linux VM or CI runner

Use a Linux VM or self-hosted CI runner with Docker-in-Docker or a privileged Docker daemon, functional bridge networking, cgroup v2, and `iptables`/`nftables` support. Install the pinned repository tools, then run:

```bash
export PATH="$PWD/.tools/bin:$PATH"
scripts/infra/run_kind_canary_promotion_integration.sh
```

### Rootless runtime on a supported host

Rootless Docker or Podman can be used only if the host supports user namespaces, slirp4netns/pasta, cgroup delegation, and the required Kubernetes networking behavior. This sandbox has not demonstrated those capabilities.

### Mock command harness

The existing mock approach can validate shell rollback sequencing and JSON Patch construction, but it cannot be used as live production or regulatory evidence because it does not prove Kubernetes scheduling, Istio routing, Envoy behavior, or network continuity.

## Conclusion

The PKI verifier's unit suite is green and independently reproducible. The raw statement execution ratio is approximately 89.3%, while the combined Coverage.py value is 87%; neither supports a greater-than-90% coverage claim. The Kind/Istio harness remains blocked by sandbox kernel networking capabilities, not by Docker installation or the corrected harness syntax.
