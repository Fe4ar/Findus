#!/bin/sh
# Creates an admin account interactively; the password is typed by you and never stored in the repo.
cd "$(dirname "$0")/.." && exec docker compose exec web python manage.py createsuperuser
