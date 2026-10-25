#!/usr/bin/env bash
# Builds the static demo (fictional data from frontend/src/demo-data.json, no backend) into demo-dist/.
# Serve it at the root of a host (paths are absolute), e.g. GitHub Pages with a custom domain.
# Uses local npm if present, otherwise Docker (node:22-slim, like caddy/Dockerfile).
set -euo pipefail
cd "$(dirname "$0")/.."
build="npm ci --no-audit --no-fund && VITE_DEMO=1 npm run build -- --outDir ../demo-dist --emptyOutDir"
if command -v npm >/dev/null; then (cd frontend && sh -c "$build")
else docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/src -w /src/frontend node:22-slim sh -c "$build"; fi
cp demo-dist/index.html demo-dist/404.html  # deep links like /n/<id> on static hosts
echo "demo-dist/ ready"
