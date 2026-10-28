#!/bin/sh
# Findus backup: database dump, media files and .env into ~/findus-backups/<date>/, keeps the newest 14.
# Usage: scripts/backup.sh            (run from anywhere; the timer runs it daily at 02:30)
# Env:   BACKUP_DIR (default ~/findus-backups), KEEP (default 14), COMPOSE_PROJECT (default: the project of this checkout, i.e. its folder name)
set -eu

cd "$(dirname "$0")/.."
BACKUP_DIR=${BACKUP_DIR:-$HOME/findus-backups}
KEEP=${KEEP:-14}
dc() { docker compose ${COMPOSE_PROJECT:+-p "$COMPOSE_PROJECT"} "$@"; }

name=$(date +%Y-%m-%d_%H%M)
umask 077
mkdir -p "$BACKUP_DIR"
# Written to a hidden temp dir and renamed at the end, so a half-written backup never counts as a backup.
tmp="$BACKUP_DIR/.incomplete-$name"
rm -rf "$tmp"
mkdir "$tmp"
trap 'rm -rf "$tmp"' EXIT

dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$tmp/db.dump"
dc exec -T web tar -C /data/media -czf - . > "$tmp/media.tar.gz"
cp .env "$tmp/env"
{
    echo "created=$(date -Iseconds)"
    echo "host=$(hostname)"
    echo "commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    echo "migrations=$(dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select name from django_migrations where app='"'core'"' order by id desc limit 1"')"
} > "$tmp/manifest"
(cd "$tmp" && sha256sum db.dump media.tar.gz env manifest > SHA256SUMS)

# A dump that pg_restore cannot list is not a backup.
dc exec -T db pg_restore --list < "$tmp/db.dump" > /dev/null
tar -tzf "$tmp/media.tar.gz" > /dev/null

mv "$tmp" "$BACKUP_DIR/$name"
trap - EXIT

# Prune: complete backups only, newest first, keep $KEEP.
ls -1d "$BACKUP_DIR"/20??-??-??_???? 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -rf "$old"
done
echo "backup ok: $BACKUP_DIR/$name ($(du -sh "$BACKUP_DIR/$name" | cut -f1))"
