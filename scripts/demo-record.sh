#!/usr/bin/env bash
# Regenerates frontend/src/demo-data.json for the static demo: a throwaway database (own network, no ports),
# fictional content from scripts/demo-data.py, recorded API answers. Nothing touches a running Findus.
set -euo pipefail
cd "$(dirname "$0")/.."
P=findus-demo-record
cleanup() { docker rm -f "$P-db" >/dev/null 2>&1 || true; docker network rm "$P" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker build -q -t "$P-web" backend >/dev/null
docker network create "$P" >/dev/null
docker run -d --name "$P-db" --network "$P" -e POSTGRES_DB=wiki -e POSTGRES_USER=wiki -e POSTGRES_PASSWORD=demo postgres:16 >/dev/null
until docker exec "$P-db" pg_isready -U wiki -d wiki -q; do sleep 1; done
docker run --rm -i --network "$P" -e POSTGRES_HOST="$P-db" -e POSTGRES_PASSWORD=demo -e DJANGO_SECRET_KEY=demo-only \
  -e MEDIA_ROOT=/tmp/media "$P-web" sh -c 'python manage.py migrate -v0 && python manage.py shell' < scripts/demo-data.py \
  | sed -n 's/^DEMO-JSON //p' > frontend/src/demo-data.json.tmp
[[ -s frontend/src/demo-data.json.tmp ]] || { echo "recording failed" >&2; exit 1; }
mv frontend/src/demo-data.json.tmp frontend/src/demo-data.json
echo "frontend/src/demo-data.json: $(wc -c < frontend/src/demo-data.json) bytes"
