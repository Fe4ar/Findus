# Betrieb (Backup, Restore, Rechte)

## Backup und Restore
- `scripts/backup.sh`: Datenbank (`pg_dump -Fc`), Dateien (Volume `media`) und `.env` nach `~/findus-backups/<Datum_Uhrzeit>/`,
  mit `SHA256SUMS` und `manifest` (Commit, letzte Migration). Die neuesten 14 Stände bleiben, ältere werden gelöscht.
  Halbfertige Sicherungen liegen nur als `.incomplete-*` und zählen nicht.
- Zeitplan: systemd-Timer täglich 02:30 (`scripts/systemd/`). Einrichten:
  `scripts/install-timers.sh` (setzt Benutzer und Pfad des Checkouts ein, aktiviert Backup- und Papierkorb-Timer; anderer Benutzer: `SERVICE_USER=name`).
  Prüfen: `systemctl list-timers findus-backup.timer`, Log: `journalctl -u findus-backup`.
- Kopie auf ein zweites System (NAS o. Ä.) einrichten: die Ordner unter `~/findus-backups/` regelmäßig wegkopieren.
- `scripts/restore.sh <Ordner>`: spielt einen Stand in den **isolierten Test-Stack** ein (`docker-compose.test.yml`,
  Projekt `findus-test`, eigene Volumes, https://<WIKI_HOST>:9443). Danach Test-Stack prüfen und mit
  `docker compose -f docker-compose.test.yml down -v` wieder entfernen.
- Ernstfall: `scripts/restore.sh <Ordner> --live` überschreibt die Live-Datenbank und -Dateien (fragt nach).
  Ist der Server komplett weg: Repo klonen, `<Ordner>/env` nach `.env` kopieren, `docker compose up -d --build`, dann restore mit `--live`.
- `.env` enthält Secrets: Backup-Ordner sind nur für den Besitzer lesbar (umask 077).

## Rechte, Gruppen, öffentlicher Bereich
- Rechte gibt es pro Gruppe auf Bereichen und Ordnern: Lesen, Schreiben, Veröffentlichen, Rechte verwalten.
  Sie gelten für alles darunter und addieren sich (Vereinigung über alle übergeordneten Ordner und die globalen Rechte).
  Ein Verbot gibt es nicht, weniger Rechte weiter unten gehen also nicht.
- Gruppen (Migration 0005, global): **Admin** alles, **IT-Team** Lesen/Schreiben/Veröffentlichen überall (keine Rechteverwaltung),
  **Leser** nur Lesen. Superuser dürfen immer alles. Benutzer den Gruppen unter /admin/ → Benutzer zuordnen.
- Rechte setzen: im Wiki einen Bereich/Ordner öffnen, rechts Kasten „Rechte“ (nur mit Recht „Rechte verwalten“).
  Ausgegraute Häkchen sind geerbt. Notfalls /admin/ → Node permissions (Zeile ohne Node = gilt überall).
- Entwürfe sehen nur Gruppen mit Schreib- oder Veröffentlichungsrecht. Wer nur schreiben darf, legt neue Seiten/Dateien
  als Entwurf an und kann sie nicht veröffentlichen.
- Öffentlich: Bereiche mit „Öffentlich“ (Kasten „Rechte“, nur Bereiche) sind ohne Anmeldung lesbar, aber nur veröffentlichte Inhalte,
  auch in Suche und Downloads. Angelegt: „FAQ für Anwender“. Ohne Anmeldung zeigt Findus zuerst die Anmeldung
  mit dem Link „FAQ für Anwender ohne Anmeldung lesen“; Links auf Seiten (/n/<id>) öffnen direkt.
- Audit-Log: Anlegen, Ändern, Verschieben, Löschen, Veröffentlichen, Wiederherstellen, Rechteänderungen und Anmeldungen
  (auch fehlgeschlagene) mit Benutzer, Ziel, Details und IP. Ansehen: /admin/ → Audit logs (nur lesbar).
- Alle Prüfungen laufen über `permissions.can(user, action, node)` (backend/core/permissions.py).

## Teams, Rechte und Papierkorb (v0.6)
- Teams (Verwaltung → Teams) haben einen eigenen Bereich, Mitglieder und Teamleiter; das Recht je Mitglied (Lesen / Lesen und
  Schreiben) setzt der Teamleiter. Technisch sind es zwei Gruppen je Team („Team X · Lesen“/„· Schreiben“) mit `NodePermission`-Zeilen
  auf dem Bereich, die normale Rechteprüfung (`permissions.can`) gilt unverändert.
- Globale Gruppenrechte (`node=None`) gelten nur noch für Fragen ohne Knoten (Bereiche anlegen, Übersicht); auf Bereiche wirken
  sie über Zeilen am Bereich (die Migration 0009 kopiert sie auf alle bestehenden Bereiche) oder bei Gruppen mit „verwalten“ (Admin).
- Rechte je Ordner: ein Ordner kann „erben“ oder eigene Häkchen setzen (überschreibt die darüber); „Ohne Anmeldung“ ist nur in
  Bereichen ohne `never_public` möglich.
- Papierkorb: Gelöschtes bleibt je Team (Standard 40 Tage) und wird vom Timer endgültig gelöscht, ebenso Seitenaufrufe nach 90 Tagen.
  Einrichten: `scripts/install-timers.sh` (siehe oben).
  Probelauf: `docker compose exec web python manage.py purge_trash --dry-run`.
