# Findus

**English** · [Deutsch](#deutsch)

Findus is a self-hosted internal wiki and documentation hub for small IT teams: a folder tree with wiki pages,
files with version history, Office documents in the browser (OnlyOffice), diagrams (draw.io) and a network map with
live status. Everything runs on your own server; nothing calls external services.

> **Status:** private preview. Try the [demo](#demo) (static, fictional data, no backend).

![Overview](docs/screenshots/uebersicht.png)

## Features
- Folder tree with areas, folders, pages and files; drag & drop, drafts and publishing
- Page editor (TipTap) with tables, code blocks, images and embedded draw.io diagrams; full version history with diff and restore
- Files with versions; Office files open and save in OnlyOffice, `.drawio` files in a self-hosted draw.io
- Network tab: rack and topology maps with live reachability, links to manuals and diagrams
- Full-text search (PostgreSQL, German stemming) over pages and documents
- Permissions per group with inheritance, public read-only areas, audit log
- Export of pages and folders as PDF or Markdown
- Dashboard of internal services with online status; light and dark theme per user
- Backup and restore scripts, isolated test stack

## Quickstart
Requirements: a Linux server with Docker and the Compose plugin, 3 GB RAM or more (OnlyOffice needs about 750 MB), 10 GB disk.
If Docker is missing: `curl -fsSL https://get.docker.com | sudo sh`, then `sudo usermod -aG docker $USER` and log in again
(otherwise every command needs `sudo`).

    cp .env.example .env            # set WIKI_HOST (name or IP of the server), fill the secrets: openssl rand -hex 32
    docker compose up -d --build    # first start: 5–10 minutes (frontend build, images of about 3 GB)
    scripts/createsuperuser.sh      # create the admin account (asks for the password)

Unattended, e.g. in a setup script: `DJANGO_SUPERUSER_PASSWORD=… scripts/createsuperuser.sh admin you@example.org`.
Check with `docker compose ps` (all five services up) and `curl -k https://<WIKI_HOST>/api/health`.

Open `https://<WIKI_HOST>`. Caddy signs the certificate with its own CA, so browsers warn on the first visit.
Either accept it once, or trust the CA on your clients: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`
and import `root.crt` into the operating system or browser certificate store. For a public name, put a reverse proxy
with a normal certificate in front and list its name in `WIKI_ALIASES` / its address in `TRUSTED_PROXIES`.

After the first login the overview shows a short "first steps" hint: create dashboard categories and shortcuts per user,
set up teams under Administration → Teams. The optional `backend/services.example.json` is read once when the database is
created (copy it to `backend/services.json` before the first start) and becomes the global shortcuts.

Daily backup and trash purge: `scripts/install-timers.sh` (installs systemd timers for the current user and path).
Everything else, in German: [docs/BETRIEB.md](docs/BETRIEB.md).

Tests: `docker compose run --rm -v "$PWD/backend":/app web pytest -q`.
Operations (backup, restore, permissions, in German): [docs/BETRIEB.md](docs/BETRIEB.md).

## Demo
`scripts/build-demo.sh` builds the frontend with a mocked API and fictional data into `demo-dist/`
(for GitHub Pages, see `.github/workflows/demo.yml`). Nothing in the demo is real.

## License
AGPL-3.0 (draft, see [LICENSE](LICENSE)). Fonts: Inter, SIL Open Font License.

---

## Deutsch
Findus ist ein selbst gehostetes internes Wiki und Dokumentationssystem für kleine IT-Teams: Ordnerbaum mit
Wiki-Seiten, Dateien mit Versionen, Office-Dokumente im Browser (OnlyOffice), Schaubilder (draw.io) und eine
Netzwerkkarte mit Live-Status. Alles läuft auf dem eigenen Server, ohne externe Dienste.

**Schnellstart:** `.env.example` nach `.env` kopieren und Secrets setzen, `docker compose up -d --build`,
`scripts/createsuperuser.sh` (ohne Rückfrage: `DJANGO_SUPERUSER_PASSWORD=… scripts/createsuperuser.sh <name>`). Der erste Start dauert
5–10 Minuten, das Zertifikat stammt von Caddys eigener CA (Vertrauen: siehe Quickstart oben). Timer für Backup und Papierkorb:
`scripts/install-timers.sh`. Betrieb, Backup und Rechte: [docs/BETRIEB.md](docs/BETRIEB.md).
Eine statische Demo mit erfundenen Daten baut `scripts/build-demo.sh`.
