#!/usr/bin/env bash
set -euo pipefail

# This runner changes the host firewall. It must run only on an approved
# TigerBeetle staging replica during a scheduled chaos window.
: "${TIGERBEETLE_CHAOS_APPROVED:?set TIGERBEETLE_CHAOS_APPROVED=STAGING_ONLY_APPROVED}"
[[ "$TIGERBEETLE_CHAOS_APPROVED" == "STAGING_ONLY_APPROVED" ]] || { echo "invalid chaos approval" >&2; exit 2; }
: "${TIGERBEETLE_CHAOS_TARGETS:?set comma-separated staging peer host:port targets}"
: "${TIGERBEETLE_CHAOS_ALLOWED_CIDRS:?set comma-separated approved private staging CIDRs}"
: "${TIGERBEETLE_CHAOS_CONFIRM_HOST:?set exact approved staging hostname}"

if [[ "$(hostname -f 2>/dev/null || hostname)" != "$TIGERBEETLE_CHAOS_CONFIRM_HOST" ]]; then
  echo "host is not the approved staging replica" >&2
  exit 2
fi
[[ "${TIGERBEETLE_CHAOS_PRODUCTION:-false}" != "true" ]] || { echo "production chaos is forbidden" >&2; exit 2; }
command -v iptables >/dev/null || { echo "iptables is required" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "run as root on the approved staging replica" >&2; exit 2; }

duration=${TIGERBEETLE_CHAOS_DURATION_SECONDS:-30}
[[ "$duration" =~ ^[1-9][0-9]{0,2}$ && "$duration" -le 300 ]] || { echo "duration must be 1..300 seconds" >&2; exit 2; }

contains_ip() {
  local ip=$1 cidr
  python3 - "$ip" "${TIGERBEETLE_CHAOS_ALLOWED_CIDRS}" <<'PY'
import ipaddress
import sys
ip = ipaddress.ip_address(sys.argv[1])
for raw in sys.argv[2].split(','):
    try:
        if ip in ipaddress.ip_network(raw.strip(), strict=False):
            raise SystemExit(0)
    except ValueError:
        pass
raise SystemExit(1)
PY
}

output_rules=()
input_rules=()
cleanup() {
  set +e
  for rule in "${output_rules[@]}"; do iptables -D OUTPUT $rule >/dev/null 2>&1 || true; done
  for rule in "${input_rules[@]}"; do iptables -D INPUT $rule >/dev/null 2>&1 || true; done
}
trap cleanup EXIT INT TERM

IFS=',' read -r -a targets <<< "$TIGERBEETLE_CHAOS_TARGETS"
for target in "${targets[@]}"; do
  target=${target//[[:space:]]/}
  [[ "$target" =~ ^([0-9]{1,3}(\.[0-9]{1,3}){3}):([0-9]{1,5})$ ]] || { echo "target must be IP:port: $target" >&2; exit 2; }
  ip=${BASH_REMATCH[1]}; port=${BASH_REMATCH[3]}
  (( port >= 1 && port <= 65535 )) || { echo "invalid port" >&2; exit 2; }
  contains_ip "$ip" || { echo "target outside approved CIDRs: $ip" >&2; exit 2; }
  rule="-d $ip -p tcp --dport $port -j REJECT --reject-with tcp-reset"
  iptables -I OUTPUT $rule
  iptables -I INPUT -s "$ip" -p tcp --sport "$port" -j REJECT --reject-with tcp-reset
  output_rules+=("$rule")
  input_rules+=("-s $ip -p tcp --sport $port -j REJECT --reject-with tcp-reset")
done

printf 'chaos_state=partition_injected duration_seconds=%s targets=%s\n' "$duration" "$TIGERBEETLE_CHAOS_TARGETS"
sleep "$duration"
printf '%s\n' 'chaos_state=partition_expired_cleanup=starting'
