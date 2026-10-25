#!/bin/sh
# Restores a backup made by scripts/backup.sh into a compose stack.
# Usage: scripts/restore.sh <backup dir>              -> isolated test stack (docker-compose.test.yml, https://<WIKI_HOST>:9443)
#        scripts/restore.sh <backup dir> --live       -> LIVE stack; overwrites the live database and media
# .env is never overwritten. After losing VM 104 entirely: copy <backup dir>/env to .env first, then restore with --live.
set -eu

src=${1:?usage: scripts/restore.sh <backup dir> [--live]}
src=$(cd "$src" && pwd)
cd "$(dirname "$0")/.."
if [ "${2:-}" = "--live" ]; then
    printf 'Overwrite the LIVE Findus database and files with %s? Type "live": ' "$src"
    read -r answer
    [ "$answer" = "live" ] || { echo "aborted"; exit 1; }
    dc() { docker compose "$@"; }
    services="web caddy onlyoffice drawio"
else
    dc() { docker compose -f docker-compose.test.yml "$@"; }
    services="web caddy"
fi

(cd "$src" && sha256sum -c --quiet SHA256SUMS)
cat "$src/manifest"

dc up -d --wait db
dc stop web
dc exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' < "$src/db.dump"
dc run --rm --no-deps -T --entrypoint sh web -c 'find /data/media -mindepth 1 -delete && tar -C /data/media -xzf -' < "$src/media.tar.gz"
# web runs pending migrations on start, so an older backup is brought up to the current code.
dc up -d --build $services
echo "restore ok from $src"
