# Changelog

All notable changes, newest first. Versions follow [SemVer](https://semver.org).

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

## [0.1.0] - 2026-10-25

### Added
- Wiki with areas, folders, pages and files; drafts, publishing, version history with diff and restore
- Files with versions; Office documents in OnlyOffice, diagrams in a self-hosted draw.io
- Network tab: rack and topology maps with live reachability
- Full-text search (PostgreSQL, German), export as PDF or Markdown
- Service dashboard, backup and restore scripts, isolated test stack
- Design system with light and dark mode, self-hosted Inter font
