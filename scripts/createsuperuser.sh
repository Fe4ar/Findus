#!/bin/sh
# Creates an admin account. Interactive by default: you type the password, it is never stored in the repo.
# Unattended (scripts, CI): DJANGO_SUPERUSER_PASSWORD=... scripts/createsuperuser.sh <username> [email]
cd "$(dirname "$0")/.." || exit 1
if [ -n "${DJANGO_SUPERUSER_PASSWORD:-}" ]; then
    [ -n "${1:-}" ] || { echo "usage: DJANGO_SUPERUSER_PASSWORD=... $0 <username> [email]" >&2; exit 2; }
    exec docker compose exec -T -e DJANGO_SUPERUSER_PASSWORD web python manage.py createsuperuser \
        --noinput --username "$1" --email "${2:-$1@example.invalid}"
fi
exec docker compose exec web python manage.py createsuperuser
