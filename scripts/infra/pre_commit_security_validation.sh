#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

fail() {
  printf 'pre-commit security validation: FAILED: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_command git
require_command gitleaks
require_command opa
require_command conftest
require_command python3

staged_files="$(git diff --cached --name-only --diff-filter=ACMR)"
if [[ -z "$staged_files" ]]; then
  printf '%s\n' 'pre-commit security validation: no staged files'
  exit 0
fi

printf '%s\n' 'pre-commit security validation: scanning staged content with Gitleaks'
gitleaks protect \
  --staged \
  --redact \
  --config "$ROOT_DIR/.gitleaks.toml" \
  --no-banner

printf '%s\n' 'pre-commit security validation: checking Rego formatting and compilation'
opa fmt --fail "$ROOT_DIR/infra/opa"
opa check "$ROOT_DIR/infra/opa"
opa test "$ROOT_DIR/infra/opa" -v

mapfile -t policy_files < <(find "$ROOT_DIR/infra/opa" -maxdepth 1 -type f -name '*.rego' -print | sort)
if [[ "${#policy_files[@]}" -eq 0 ]]; then
  fail 'no Rego policy files found'
fi

printf '%s\n' 'pre-commit security validation: running Conftest against explicit Rego inputs'
conftest verify --policy "$ROOT_DIR/infra/opa" "${policy_files[@]}"

printf '%s\n' 'pre-commit security validation: compiling changed Python files'
while IFS= read -r file; do
  case "$file" in
    *.py) python3 -m py_compile "$ROOT_DIR/$file" ;;
  esac
done <<< "$staged_files"

printf '%s\n' 'pre-commit security validation: PASSED'
