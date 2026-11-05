"""Todoist integration (per user, optional): own and assigned Findus tasks are mirrored into one Todoist project.

Findus is internal (no webhooks from outside), so it polls the Todoist API v1 with a sync token every 5 minutes
(manage.py todoist_sync, systemd timer) and on "Jetzt abgleichen". Only tasks of the chosen project are read as
candidates or changed; tasks elsewhere in the account are never touched or stored. The API token is stored encrypted
(Fernet; key from INTEGRATION_KEY or derived from DJANGO_SECRET_KEY) and never leaves the server again.

Sync rules, per task, per field (title, due date, notes, done): compare Findus and Todoist with the state of the last
sync. Only one side changed: copy it over. Both changed differently: the later change wins and the task history says so.
Nothing is deleted on either side: a task removed in Todoist stays in Findus (unlinked), a task deleted in Findus stays
in Todoist and is not imported again.
"""
import base64
import hashlib
import json
import os
from datetime import timedelta
from urllib import error, parse, request

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from .features import enabled
from .models import IntegrationSettings, Task, TaskEvent, TodoistItem, TodoistLink

API = os.environ.get("TODOIST_API_URL", "https://api.todoist.com/api/v1")  # the variable exists for test stacks with a fake server only
PROJECT_NAME = "Findus"
FOOTER = "\n\n🔗 Findus: "
STALE_LOCK = timedelta(minutes=10)
LABELS = {"title": "Titel", "due": "Fälligkeit", "notes": "Notizen", "done": "Status"}


class TodoistError(Exception):
    """kind: auth (token invalid), network, rate, key (token not readable), api."""
    MESSAGES = {
        "auth": "Der Todoist-Token ist ungültig oder abgelaufen. Bitte neu verbinden.",
        "network": "Todoist ist nicht erreichbar. Der nächste Versuch folgt automatisch.",
        "rate": "Todoist bremst gerade (zu viele Anfragen). Der nächste Versuch folgt automatisch.",
        "key": "Der gespeicherte Token ist nicht mehr lesbar (Schlüssel geändert). Bitte neu verbinden.",
        "api": "Todoist hat die Anfrage abgelehnt.",
    }

    def __init__(self, kind, detail=""):
        self.kind, self.detail = kind, detail
        super().__init__(self.MESSAGES.get(kind, kind) + (f" ({detail})" if detail and kind == "api" else ""))


# --- token encryption -------------------------------------------------------------------------------------------

def _fernet():
    from cryptography.fernet import Fernet
    key = getattr(settings, "INTEGRATION_KEY", "") or base64.urlsafe_b64encode(hashlib.sha256(("todoist:" + settings.SECRET_KEY).encode()).digest())
    return Fernet(key)


def encrypt(token):
    return _fernet().encrypt(token.encode()).decode()


def decrypt(blob):
    from cryptography.fernet import InvalidToken
    try:
        return _fernet().decrypt(blob.encode()).decode()
    except (InvalidToken, ValueError):
        raise TodoistError("key")


# --- API client ------------------------------------------------------------------------------------------------

class Client:
    """Todoist API v1 over HTTPS (stdlib only). Tests replace this class with an in-memory fake."""

    def __init__(self, token):
        self.token = token

    def _call(self, method, path, body=None, form=None, query=None):
        url = API + path + (("?" + parse.urlencode(query)) if query else "")
        headers = {"Authorization": f"Bearer {self.token}", "User-Agent": "Findus", "Accept": "application/json"}
        data = None
        if form is not None:
            data, headers["Content-Type"] = parse.urlencode(form).encode(), "application/x-www-form-urlencoded"
        elif body is not None:
            data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
        try:
            with request.urlopen(request.Request(url, data=data, headers=headers, method=method), timeout=20) as r:
                raw = r.read()
        except error.HTTPError as e:
            raise TodoistError({401: "auth", 403: "auth", 429: "rate"}.get(e.code, "api"), f"HTTP {e.code}")
        except (error.URLError, TimeoutError, OSError):
            raise TodoistError("network")
        return json.loads(raw) if raw.strip() else {}

    def projects(self):
        out, cursor = [], None
        while True:
            page = self._call("GET", "/projects", query={"limit": 200, **({"cursor": cursor} if cursor else {})})
            out += [{"id": str(p["id"]), "name": p["name"]} for p in page.get("results", []) if not p.get("is_archived")]
            cursor = page.get("next_cursor")
            if not cursor:
                return out

    def add_project(self, name):
        p = self._call("POST", "/projects", body={"name": name})
        return {"id": str(p["id"]), "name": p["name"]}

    def sync(self, token):
        """{"sync_token", "full_sync", "items": [...]}; "*" reads everything, a token only what changed since."""
        r = self._call("POST", "/sync", form={"sync_token": token or "*", "resource_types": json.dumps(["items"])})
        return {"sync_token": r["sync_token"], "full_sync": bool(r.get("full_sync")), "items": r.get("items", [])}

    def add_task(self, project_id, content, description, due):
        body = {"content": content, "description": description, "project_id": project_id}
        if due:
            body["due_date"] = due
        return str(self._call("POST", "/tasks", body=body)["id"])

    def update_task(self, task_id, **fields):
        """content, description and/or due (YYYY-MM-DD or None to clear)."""
        body = {k: v for k, v in fields.items() if k != "due"}
        if "due" in fields:
            if fields["due"]:
                body["due_date"] = fields["due"]
            else:
                body["due_string"] = "no date"
        self._call("POST", f"/tasks/{task_id}", body=body)

    def close(self, task_id):
        self._call("POST", f"/tasks/{task_id}/close")

    def reopen(self, task_id):
        self._call("POST", f"/tasks/{task_id}/reopen")


# --- mapping between Findus tasks and Todoist items -------------------------------------------------------------

def task_url(task):
    base = getattr(settings, "FINDUS_URL", "")
    return f"{base}/aufgaben?t={task.id}"


def _footer(task):
    return FOOTER + task_url(task)


def local_values(task):
    return {"title": task.title, "due": task.due.isoformat() if task.due else None, "notes": task.notes, "done": task.done_at is not None}


def remote_values(item):
    """Findus view of a Todoist item (description without the link back); due None for recurring items is handled by the caller."""
    desc = item.get("description") or ""
    cut = desc.rfind(FOOTER.strip())
    notes = desc[:cut].rstrip() if cut >= 0 and "Findus:" in desc[cut:] else desc
    due = (item.get("due") or {}).get("date")
    return {"title": item.get("content") or "", "due": due[:10] if due else None, "notes": notes,
            "done": bool(item.get("checked") or item.get("completed_at"))}


def _remote_time(item):
    t = parse_datetime(str(item.get("updated_at") or "")) if item.get("updated_at") else None
    return t if t and timezone.is_aware(t) else (timezone.make_aware(t) if t else timezone.now())


def _event(task, text):
    TaskEvent.objects.create(task=task, text=text[:300])


def _apply_local(task, changes):
    for f, v in changes.items():
        if f == "title":
            task.title = v[:200] or task.title
        elif f == "notes":
            task.notes = v[:5000]
        elif f == "due":
            task.due = parse_date(v) if v else None
        elif f == "done":
            task.done_at = (task.done_at or timezone.now()) if v else None
    task.save()


def _push(client, task, item_id, changes, due_locked):
    """Write the Findus side of the changed fields to Todoist."""
    fields = {}
    if "title" in changes:
        fields["content"] = changes["title"]
    if "notes" in changes or "title" in changes:
        fields["description"] = task.notes + _footer(task)
    if "due" in changes and not due_locked:
        fields["due"] = changes["due"]
    if fields:
        client.update_task(item_id, **fields)
    if "done" in changes:
        (client.close if changes["done"] else client.reopen)(item_id)


def _merge(link, client, mapping, item, now):
    """One linked task: three-way merge per field against the state of the last sync."""
    task, state = mapping.task, dict(mapping.state)
    local, remote = local_values(task), (remote_values(item) if item else dict(state))
    recurring = bool(item and (item.get("due") or {}).get("is_recurring"))
    if recurring:
        remote["due"] = state.get("due")  # a repeating Todoist task keeps its own schedule
    to_local, to_remote, new = {}, {}, dict(state)
    for f in LABELS:
        lc, rc = local[f] != state.get(f), remote[f] != state.get(f)
        if lc and rc and local[f] != remote[f]:
            remote_wins = _remote_time(item) >= task.updated_at
            _event(task, f"Konflikt bei „{LABELS[f]}“: die letzte Änderung gewann ({'Todoist' if remote_wins else 'Findus'}).")
            (to_local if remote_wins else to_remote)[f] = remote[f] if remote_wins else local[f]
            new[f] = remote[f] if remote_wins else local[f]
        elif rc:
            to_local[f], new[f] = remote[f], remote[f]
            _event(task, f"Aus Todoist übernommen: {LABELS[f]}.")
        elif lc:
            to_remote[f], new[f] = local[f], local[f]
    if to_remote:
        _push(client, task, mapping.todoist_id, to_remote, recurring)
    if to_local:
        _apply_local(task, to_local)
    if to_local or to_remote or new != state:
        mapping.state = new
        mapping.save(update_fields=["state"])


def _eligible(link, task):
    return task.done_at is None and (link.include_private or not task.private)


def _run(link, client, items, token, full):
    now = timezone.now()
    in_project = {str(i["id"]): i for i in items if str(i.get("project_id")) == link.project_id}
    elsewhere = {str(i["id"]): i for i in items if str(i.get("project_id")) != link.project_id}
    mappings = list(link.items.select_related("task"))
    known = {m.todoist_id for m in mappings}
    for m in mappings:
        item = in_project.get(m.todoist_id)
        gone = (item is not None and item.get("is_deleted")) or (m.todoist_id in elsewhere)
        if m.task is None:  # tombstone of a task deleted in Findus: forget it once Todoist lost it too
            if gone or (not full and item is None and m.todoist_id in elsewhere):
                m.delete()
            continue
        if gone:
            _event(m.task, "In Todoist gelöscht oder aus dem Projekt verschoben: die Aufgabe bleibt hier, der Abgleich endet für sie.")
            m.delete()
            continue
        if item is None and full:
            continue  # a full read lists only open tasks: absence says nothing
        _merge(link, client, m, item, now)
    if link.import_new:
        for tid, item in in_project.items():
            if tid in known or item.get("is_deleted") or remote_values(item)["done"]:
                continue
            v = remote_values(item)
            with transaction.atomic():
                task = Task.objects.create(user=link.user, created_by=link.user, title=v["title"][:200] or "(ohne Titel)", notes=v["notes"][:5000],
                                           due=parse_date(v["due"]) if v["due"] else None)
                TodoistItem.objects.create(link=link, todoist_id=tid, task=task, state=v)
                _event(task, "Aus Todoist übernommen (neue Aufgabe im Projekt).")
    linked = set(link.items.exclude(task=None).values_list("task_id", flat=True))
    for task in Task.objects.filter(user=link.user, done_at=None).exclude(pk__in=linked).order_by("id"):
        if not _eligible(link, task):
            continue
        tid = client.add_task(link.project_id, task.title, task.notes + _footer(task), task.due.isoformat() if task.due else None)
        TodoistItem.objects.create(link=link, todoist_id=tid, task=task, state=local_values(task))
        _event(task, "Mit Todoist verbunden.")
    link.sync_token = token


def sync_link(link, client_class=None):
    """One sync run for a link. Returns "ok", "busy" or the error message (also stored on the link). Safe to repeat: every
    step records what it did, so an interrupted run neither duplicates nor loses tasks."""
    now = timezone.now()
    won = TodoistLink.objects.filter(pk=link.pk).filter(syncing=False).update(syncing=True, sync_started_at=now) \
        or TodoistLink.objects.filter(pk=link.pk, sync_started_at__lt=now - STALE_LOCK).update(syncing=True, sync_started_at=now)
    if not won:
        return "busy"
    link.refresh_from_db()
    try:
        client = (client_class or Client)(decrypt(link.token_enc))
        data = client.sync(link.sync_token)
        _run(link, client, data["items"], data["sync_token"], data["full_sync"] or not link.sync_token)
        link.last_sync_at, link.last_error, link.last_error_at = timezone.now(), "", None
        result = "ok"
    except TodoistError as e:
        link.last_error, link.last_error_at, result = str(e), timezone.now(), str(e)
    finally:
        link.syncing = False
        link.save()
    return result


def sync_all():
    """For the timer: every link whose user may use tasks, unless an admin switched the integration off."""
    if not IntegrationSettings.allowed():
        return {"skipped": "off"}
    out = {}
    for link in TodoistLink.objects.select_related("user"):
        out[link.user.get_username()] = sync_link(link) if "tasks" in enabled(link.user) and link.user.is_active else "übersprungen"
    return out


def connect(user, token, project_id=None):
    """Verify the token, pick or create the project and store everything. Raises TodoistError; stores nothing on failure."""
    client = Client(token)
    projects = client.projects()
    chosen = next((p for p in projects if p["id"] == project_id), None) if project_id else next((p for p in projects if p["name"] == PROJECT_NAME), None)
    if project_id and not chosen:
        raise TodoistError("api", "Projekt nicht gefunden")
    chosen = chosen or client.add_project(PROJECT_NAME)
    link, _ = TodoistLink.objects.update_or_create(user=user, defaults=dict(
        token_enc=encrypt(token), project_id=chosen["id"], project_name=chosen["name"], sync_token="", connected_at=timezone.now(),
        last_error="", last_error_at=None, last_sync_at=None, syncing=False))
    link.items.all().delete()
    return link
