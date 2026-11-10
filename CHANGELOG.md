# Changelog

All notable changes, newest first. Format after [Keep a Changelog](https://keepachangelog.com), versions follow [SemVer](https://semver.org).

## [0.8.2] - 2026-11-10

### Fixed
- PDFs show again in the page: the PDF view of a file and embedded PDF blocks failed with "… refused to connect" because file responses carried `X-Frame-Options: DENY`, which also blocked the page's own preview frame. File responses now allow framing by the same origin only (`SAMEORIGIN`); all other responses stay unframeable. Works independent of host and port

## [0.8.1] - 2026-11-09

### Fixed
- The tab bar stands out from the page again: inactive tabs have their own fill and frame, the active tab is framed with an accent bar, a single open tab keeps its frame, and the "+" button is a small framed button (light and dark theme)

## [0.8.0] - 2026-11-09

### Added
- Fresh installations create the administrator `admin` (password `admin1234!`) on their first start; the first login forces a new password before anything else works. Existing installations are not touched, `scripts/createsuperuser.sh` stays available
- Own password change in the profile menu (old password, new one twice, checked by the Django validators, locked after repeated failures)
- Personal area per user ("Privat"): readable only by its owner, not even by administrators; admins can delete a user, the account and its area are kept for a retention period (setting) and can be restored together
- Folders can be shared with other teams (right click, read or edit); the folder gets a small icon whose tooltip names the teams, receiving teams see it under "Von anderen Teams" and cannot share it on or change rights in it. Team setting: only the leaders or every member may share
- Search: filter chips (everything, private, teams; several at once), grouped hits with marked words, and an "Exakt" mode (whole words, "quoted phrases", no stems or prefixes); filters only narrow what the user may read
- Pages can mix own text and files: an embedded document is a collapsed block that opens editable right on the page (Collabora or OnlyOffice); screenshots and image files can be pasted or dropped into the editor, other dropped files are embedded
- A team can be created without members and filled later

### Changed
- The functions "Aufgaben" and "Netzwerk" are off for existing teams after the update (migration 0022) until an administrator releases them per team; new teams start with them off
- The per-folder rights matrix in the team dialog is gone; teams share folders instead (the FAQ keeps its folder table)
- The sidebar of a team starts with a head (team icon, name, who may see it, "+" menu for a new folder or page) instead of two large buttons at the bottom
- Group names of teams whose name already starts with "Team" lose the doubled word ("Team IT · Lesen", migration 0024)
- Private areas show the badge "Privat" instead of "Nur Admin"

### Fixed
- The dialog title of a team no longer reads "Team Team IT"

## [0.7.0] - 2026-11-05

### Added
- Tasks: personal task list with sections (create, rename, delete, reorder), drag & drop between and inside sections with a menu and arrow-button fallback, tasks for teammates, private tasks, "My tasks" on the overview
- Todoist: every user can connect a personal Todoist project (API token stored encrypted, never returned); two-way sync every five minutes, field-wise merge, history per task, global switch for administrators
- Functions per team (wiki, FAQ, tasks, network, export) can be switched on and off; team leaders manage their own team's functions
- Navigation: one tab per team plus "All users", tabs fold into a "More" menu, users without a team only get the overview and the FAQ
- Help portal for people without an account (own entry point `/hilfe`, optional own host `PUBLIC_HOST`, read-only anonymous API), ticket card with a link to your ticket system, "recently viewed" list
- FAQ editors: named people or teams may edit and publish in the public area
- Collabora Online as an optional editor for Office files (WOPI, `COLLABORA_UPSTREAM`); import and export of whole folders (Markdown ZIP with attachments)
- Login protection: failed logins are counted per user name and per address, progressive lock (30 s up to 15 min, HTTP 429), audit entries `login_failed` and `login_locked`
- `/api/health` reports the version; new `CSP_HEADER` setting (e.g. `Content-Security-Policy-Report-Only`)

### Changed
- Overview is a page of its own with each section in a box
- Caddy sends HSTS, `nosniff`, a referrer policy and a strict Content-Security-Policy; `/office/` is reachable for signed-in sessions only, `/drawio/` serves only the static editor (no servlets, read methods only)
- Migrations 0016–0021 (functions per team, tasks, sections, Todoist, login lock) run on start; take a backup first

### Removed
- `/api/board` (the job board of the overview) is no longer part of the public repository; it was an internal feature and moves into a private extension

### Fixed
- Scrolling over an embedded document (Collabora, PDF) no longer scrolls the page behind it

## [0.6.0] - 2026-10-29

### Added
- Teams with their own knowledge area, members and leaders; read or read/write right per member
- Per-user download/export right; export, file download and OnlyOffice download are blocked without it
- Folder rights per team (inherit or own rights), public access only inside the FAQ
- Trash per team with retention (default 40 days), purge command and systemd timer
- Audit log per team, page view counter and statistics, admin menu (users, teams, trash, log, system)
- Personal dashboard with own, team and global shortcuts, "recently visited" tile; sidebar tree with visibility badges
- Public FAQ landing page with search, most read posts and an optional ticket link; FAQ editors setting
- New-user and new-team dialogs keep a draft; add a new user straight from the team dialog
- Unattended createsuperuser, install-timers.sh for backup and purge timers

### Changed
- Light theme with higher contrast (WCAG AA); tabs only above the content, permanent sidebar
- Users: single Administrator checkbox; migration 0015 removes empty IT-Team and Leser groups (rights come from teams)

### Fixed
- Dashboard shortcut addresses without a scheme get http://; API field errors are shown instead of "Fehler 400"
- Sidebar no longer scrolls sideways; visibility badge of a single team area

## [0.5.0] - 2026-10-27

Stable release of 0.5.0-rc1 (same code, now running in production).

### Added
- Permissions: group rights per node with inheritance, public area with anonymous read-only view, publish right, audit log; rights box per area/folder
- Theme per user account (light/dark/system), applied before first paint
- In-app tabs: open pages, maps and files side by side (Ctrl/middle click), keep-alive panes, pin, reorder, split view, restored per user, unsaved-change marks
- Own dialogs and toasts instead of the browser's prompt/confirm/alert (native `<dialog>`)
- Profile menu with initials avatar: theme switch, settings, admin links, logout
- Areas in the network tab above folders and maps (existing items move into a default area)
- Editor toolbar with inline SVG icons
- Rack editor: 16 device types with front graphics and a palette, snapping into rack units with collision check, front/back view (mounting side per device)
- Device details: side panel on click, modal on double click; IP, hostname, MAC, model, serial number, notes with IP/MAC validation
- Undo/redo, copy/paste and multi-select in the map editor
- Search inside maps; global search hits open the map with the device selected
- Zoom (Ctrl+wheel, buttons) and panning
- Cable colours by medium or VLAN with legend, port grid per switch/patch panel, rack metrics (units, power against UPS/PDU capacity, weight)
- Map export as SVG (standalone) and PNG

### Changed
- Map code split into `frontend/src/karte/` modules

### Fixed
- restore.sh recreates the database instead of `pg_restore --clean`

## [0.5.0-rc1] - 2026-10-25

### Added
- Permissions: group rights per node with inheritance, public area with anonymous read-only view, publish right, audit log; rights box per area/folder
- Theme per user account (light/dark/system), applied before first paint
- In-app tabs: open pages, maps and files side by side (Ctrl/middle click), keep-alive panes, pin, reorder, split view, restored per user, unsaved-change marks
- Own dialogs and toasts instead of the browser's prompt/confirm/alert (native `<dialog>`)
- Profile menu with initials avatar: theme switch, settings, admin links, logout
- Areas in the network tab above folders and maps (existing items move into a default area)
- Editor toolbar with inline SVG icons
- Rack editor: 16 device types with front graphics and a palette, snapping into rack units with collision check, front/back view (mounting side per device)
- Device details: side panel on click, modal on double click; IP, hostname, MAC, model, serial number, notes with IP/MAC validation
- Undo/redo, copy/paste and multi-select in the map editor
- Search inside maps; global search hits open the map with the device selected
- Zoom (Ctrl+wheel, buttons) and panning
- Cable colours by medium or VLAN with legend, port grid per switch/patch panel, rack metrics (units, power against UPS/PDU capacity, weight)
- Map export as SVG (standalone) and PNG

### Changed
- Map code split into `frontend/src/karte/` modules

### Fixed
- restore.sh recreates the database instead of `pg_restore --clean`

## [0.4.0] - 2026-10-25

Internal milestone; published as part of 0.5.0-rc1 and 0.5.0.

### Added
- Map editor: rack device types with front graphics, snapping into rack units with collision check, palette
- Device detail panel and modal, undo/redo, copy/paste, multi-select, search inside maps, zoom and panning

### Changed
- Map code split into `frontend/src/karte/` modules

## [0.3.0] - 2026-10-25

Internal milestone; published as part of 0.5.0-rc1 and 0.5.0.

### Added
- Profile menu with round initials avatar: theme switch, settings dialog, links to administration and audit log
- Areas in the network tab above folders and maps, rights box on network areas and folders
- Editor toolbar with own inline SVG icons (light and dark)

## [0.2.0] - 2026-10-25

Internal milestone; published as part of 0.5.0-rc1 and 0.5.0.

### Added
- Permissions: group rights per node with inheritance, public area with anonymous read-only view, publish right, audit log
- Rights box per area and folder with public switch
- Theme (light, dark, system) saved per user account
- In-app tabs with keep-alive panes, pin, reorder, split view and unsaved-change marks
- Own dialogs and toasts instead of the browser's prompt, confirm and alert

### Fixed
- restore.sh recreates the database instead of `pg_restore --clean`

## [0.1.0] - 2026-10-25

### Added
- Wiki with areas, folders, pages and files; drafts, publishing, version history with diff and restore
- Files with versions; Office documents in OnlyOffice, diagrams in a self-hosted draw.io
- Network tab: rack and topology maps with live reachability
- Full-text search (PostgreSQL, German), export as PDF or Markdown
- Service dashboard, backup and restore scripts, isolated test stack
- Design system with light and dark mode, self-hosted Inter font
