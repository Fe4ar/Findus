# Contributing

Thanks for helping! A few rules keep Findus small and safe:

1. **No real data.** Use example data only: `example.lan`, `example.org`, addresses from `192.0.2.0/24`,
   `198.51.100.0/24`, `203.0.113.0/24` (RFC 5737). Never commit `.env`, uploads, backups, database dumps or documents.
   Enable the check once per clone: `git config core.hooksPath .githooks` (runs `scripts/check-public.sh`).
2. **Small changes.** One topic per pull request; keep the existing structure and style.
3. **Tests.** Backend changes come with a test in `backend/core/tests.py`:
   `docker compose run --rm -v "$PWD/backend":/app web pytest -q`. The frontend must build: `cd frontend && npm ci && npm run build`.
4. **No external calls at runtime.** Fonts, scripts and editors are self-hosted; do not add CDNs or trackers.
5. **Dependencies** only when there is no reasonable way without.

By contributing you agree that your contribution is licensed under the project license (see `LICENSE`).

## Versions and releases
- [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`. Before 1.0, a new feature set raises MINOR (0.2.0),
  fixes raise PATCH (0.2.1); breaking changes to data or configuration are named in the release notes.
- Every release is a tag `vX.Y.Z`; `frontend/package.json` carries the same version.
- `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com) (Added / Changed / Fixed), newest first.
- Pushing a tag runs `.github/workflows/release.yml`, which creates the GitHub release from that CHANGELOG section.
