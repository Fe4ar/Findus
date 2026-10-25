# Betrieb (Backup, Restore)

## Backup und Restore
- `scripts/backup.sh`: Datenbank (`pg_dump -Fc`), Dateien (Volume `media`) und `.env` nach `~/findus-backups/<Datum_Uhrzeit>/`,
  mit `SHA256SUMS` und `manifest` (Commit, letzte Migration). Die neuesten 14 Stände bleiben, ältere werden gelöscht.
  Halbfertige Sicherungen liegen nur als `.incomplete-*` und zählen nicht.
- Zeitplan: systemd-Timer täglich 02:30 (`scripts/systemd/`). Einrichten:
  `sudo cp scripts/systemd/findus-backup.* /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now findus-backup.timer`.
  Prüfen: `systemctl list-timers findus-backup.timer`, Log: `journalctl -u findus-backup`.
- Kopie auf ein zweites System (NAS o. Ä.) einrichten: die Ordner unter `~/findus-backups/` regelmäßig wegkopieren.
- `scripts/restore.sh <Ordner>`: spielt einen Stand in den **isolierten Test-Stack** ein (`docker-compose.test.yml`,
  Projekt `findus-test`, eigene Volumes, https://<WIKI_HOST>:9443). Danach Test-Stack prüfen und mit
  `docker compose -f docker-compose.test.yml down -v` wieder entfernen.
- Ernstfall: `scripts/restore.sh <Ordner> --live` überschreibt die Live-Datenbank und -Dateien (fragt nach).
  Ist der Server komplett weg: Repo klonen, `<Ordner>/env` nach `.env` kopieren, `docker compose up -d --build`, dann restore mit `--live`.
- `.env` enthält Secrets: Backup-Ordner sind nur für den Besitzer lesbar (umask 077).
