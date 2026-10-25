#!/usr/bin/env bash
# Fails if files contain internal data that must never reach the public repo:
# internal addresses (10.10.x.x), the internal domain, or large binaries.
# Usage: scripts/check-public.sh --staged     (pre-commit: checks the staged files)
#        scripts/check-public.sh <dir>        (checks a whole tree, e.g. the public export)
set -euo pipefail
PATTERN='10\.10\.[0-9]{1,3}\.[0-9]{1,3}|fe4ar\.de'
MAX_KB=${MAX_KB:-1024}
fail=0

if [[ "${1:-}" == "--staged" ]]; then
  mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR)
  read_file() { git show ":$1"; }
else
  dir=${1:?usage: check-public.sh --staged | <dir>}
  cd "$dir"
  mapfile -t files < <(find . -type f -not -path "./.git/*" -printf "%P\n")
  read_file() { cat -- "$1"; }
fi

for f in "${files[@]}"; do
  [[ "$f" == scripts/check-public.sh ]] && continue  # holds the patterns itself
  size_kb=$(( $(read_file "$f" | wc -c) / 1024 ))
  if (( size_kb > MAX_KB )); then
    echo "BLOCKED: $f is ${size_kb} KB (limit ${MAX_KB} KB); large files belong into Findus, not git" >&2; fail=1
  fi
  if hits=$(read_file "$f" | grep -nEI "$PATTERN" | head -3) && [[ -n "$hits" ]]; then
    echo "BLOCKED: internal data in $f:" >&2; echo "$hits" | sed "s/^/    /" >&2; fail=1
  fi
done
if (( fail )); then
  echo "Use example data instead (example.lan, 192.0.2.x / 198.51.100.x per RFC 5737). Bypass only if you are sure: git commit --no-verify" >&2
fi
exit $fail
