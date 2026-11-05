"""Tasks: personal to-do items. Everyone sees their own; teammates' tasks can be shown too (not the private ones).

Anyone may create a task for themselves or, as a teammate, for a colleague. The owner, the creator and admins change
or delete it; everyone else only reads. Admins see all tasks when they ask for colleagues.
"""
from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from .features import enabled
from .models import Task, TaskSection, TeamMember
from .permissions import is_admin
from .views import user_name

User = get_user_model()
RECENT_DONE = timedelta(days=14)


def need_tasks(request):
    if not request.user.is_authenticated:
        raise PermissionDenied("Bitte anmelden.")
    if "tasks" not in enabled(request.user):
        raise PermissionDenied("Aufgaben sind für dein Team nicht aktiviert.")


def colleague_ids(user):
    """Users who share a team with the user (everyone for admins), the user excluded."""
    if is_admin(user):
        return set(User.objects.filter(is_active=True).values_list("id", flat=True)) - {user.id}
    teams = TeamMember.objects.filter(user=user).values("team_id")
    return set(TeamMember.objects.filter(team_id__in=teams).values_list("user_id", flat=True)) - {user.id}


def can_edit(user, task):
    return is_admin(user) or user.id in (task.user_id, task.created_by_id)


def data(user, t):
    return {"id": t.id, "title": t.title, "notes": t.notes, "due": t.due, "done": t.done_at is not None, "private": t.private, "section": t.section_id,
            "owner": {"id": t.user_id, "name": user_name(t.user)}, "mine": t.user_id == user.id,
            "created_by": user_name(t.created_by), "editable": can_edit(user, t), "todoist": hasattr(t, "todoist_item"),
            "overdue": t.done_at is None and t.due is not None and t.due < timezone.localdate()}


def order_key(t):
    """Order inside a section: the manual position first, then soonest due (no date last), then newest."""
    return (t.position, t.due is None, t.due or date.max, -t.id)


def _assignee(user, d, default):
    uid = d.get("user", default)
    if uid == user.id:
        return user
    if uid not in colleague_ids(user):
        raise ValidationError({"user": "Aufgaben kannst du dir selbst oder Kollegen aus deinem Team geben."})
    return User.objects.get(pk=uid)


def _fields(d, t):
    if "title" in d:
        title = str(d["title"] or "").strip()[:200]
        if not title:
            raise ValidationError({"title": "Titel fehlt."})
        t.title = title
    if "notes" in d:
        t.notes = str(d["notes"] or "")[:5000]
    if "due" in d:
        due = parse_date(str(d["due"])) if d["due"] else None
        if d["due"] and due is None:
            raise ValidationError({"due": "Datum als JJJJ-MM-TT."})
        t.due = due
    if "private" in d:
        t.private = bool(d["private"])
    if "done" in d:
        t.done_at = (t.done_at or timezone.now()) if d["done"] else None


@api_view(["GET", "POST"])
def task_list(request):
    need_tasks(request)
    user = request.user
    if request.method == "POST":
        t = Task(user=_assignee(user, request.data, user.id), created_by=user)
        _fields(request.data, t)
        if not t.title:
            raise ValidationError({"title": "Titel fehlt."})
        t.position = max(Task.objects.filter(user=t.user, section=None).values_list("position", flat=True), default=-1) + 1
        t.save()
        return Response(data(user, t), status=201)
    scope = Q(user=user)
    if request.query_params.get("colleagues") == "1":
        scope |= Q(user_id__in=colleague_ids(user), private=False)
    qs = Task.objects.filter(scope).select_related("user", "created_by")
    if request.query_params.get("done") != "1":
        qs = qs.filter(Q(done_at=None) | Q(done_at__gte=timezone.now() - RECENT_DONE))
    # Open first, soonest due first (no date last), then newest.
    rows = sorted(qs, key=lambda t: (t.done_at is not None, *order_key(t)))
    return Response([data(user, t) for t in rows])


@api_view(["GET"])
def task_people(request):
    """Colleagues a task can be given to."""
    need_tasks(request)
    users = User.objects.filter(pk__in=colleague_ids(request.user)).order_by("first_name", "username")
    return Response([{"id": u.id, "name": user_name(u)} for u in users])


@api_view(["GET"])
def task_history(request, task_id):
    """What the Todoist sync did to a task (the owner, creator and admins read it)."""
    need_tasks(request)
    t = Task.objects.filter(pk=task_id).first()
    if t is None or not can_edit(request.user, t):
        raise NotFound()
    return Response([{"at": e.at, "text": e.text} for e in t.events.all()[:30]])


@api_view(["PATCH", "DELETE"])
def task_edit(request, task_id):
    need_tasks(request)
    user = request.user
    t = Task.objects.select_related("user", "created_by").filter(pk=task_id).first()
    # Others' private tasks look like missing ones; other people's tasks of non-colleagues too.
    if t is None or (t.user_id != user.id and not is_admin(user)
                     and (t.private and t.created_by_id != user.id or t.user_id not in colleague_ids(user))):
        raise NotFound()
    if not can_edit(user, t):
        raise PermissionDenied("Nur Besitzer, Ersteller und Admins ändern diese Aufgabe.")
    if request.method == "DELETE":
        t.delete()
        return Response(status=204)
    _fields(request.data, t)
    if "user" in request.data:
        t.user = _assignee(user, request.data, t.user_id)
    t.save()
    return Response(data(user, t))


# --- sections of the own board and manual order -----------------------------------------------------------------

MAX_SECTIONS = 30


def _section_data(s):
    return {"id": s.id, "title": s.title, "position": s.position}


def _title(d):
    title = str(d.get("title") or "").strip()[:100]
    if not title:
        raise ValidationError({"title": "Name fehlt."})
    return title


def _renumber(rows, moved, before):
    """Put `moved` before `before` (None = at the end) in the ordered list `rows`; returns the final list."""
    rows = [r for r in rows if r.pk != moved.pk]
    ids = [r.pk for r in rows]
    if before is not None and before not in ids:
        raise ValidationError({"before": "Zielposition nicht gefunden."})
    rows.insert(ids.index(before) if before is not None else len(rows), moved)
    for i, r in enumerate(rows):
        r.position = i
    return rows


@api_view(["GET", "POST"])
def section_list(request):
    need_tasks(request)
    mine = TaskSection.objects.filter(user=request.user)
    if request.method == "POST":
        if mine.count() >= MAX_SECTIONS:
            raise ValidationError({"title": f"Mehr als {MAX_SECTIONS} Bereiche sind nicht möglich."})
        s = TaskSection.objects.create(user=request.user, title=_title(request.data), position=max(mine.values_list("position", flat=True), default=-1) + 1)
        return Response(_section_data(s), status=201)
    return Response([_section_data(s) for s in mine])


def _own_section(request, section_id):
    need_tasks(request)
    s = TaskSection.objects.filter(pk=section_id, user=request.user).first()
    if s is None:
        raise NotFound()
    return s


@api_view(["PATCH", "DELETE"])
def section_edit(request, section_id):
    s = _own_section(request, section_id)
    if request.method == "DELETE":
        s.delete()  # its tasks fall back to "Ohne Bereich"
        return Response(status=204)
    s.title = _title(request.data)
    s.save()
    return Response(_section_data(s))


@api_view(["POST"])
def section_move(request, section_id):
    """Body {before: <section id>|null}: put the section in front of that one (null = last)."""
    s = _own_section(request, section_id)
    rows = _renumber(list(TaskSection.objects.filter(user=request.user)), s, request.data.get("before"))
    TaskSection.objects.bulk_update(rows, ["position"])
    return Response([_section_data(r) for r in rows])


@api_view(["POST"])
def task_move(request, task_id):
    """Body {section: <id>|null, before: <task id>|null}: move the own task into a section, in front of another task (null = last).
    Only the order fields change (bulk_update), so the move does not count as an edit for the Todoist sync."""
    need_tasks(request)
    user = request.user
    t = Task.objects.filter(pk=task_id, user=user).first()
    if t is None:
        raise NotFound()
    sid = request.data.get("section")
    if sid is not None and not TaskSection.objects.filter(pk=sid, user=user).exists():
        raise ValidationError({"section": "Bereich nicht gefunden."})
    rows = sorted(Task.objects.filter(user=user, section_id=sid), key=order_key)
    t.section_id = sid
    rows = _renumber(rows, t, request.data.get("before"))
    Task.objects.bulk_update(rows, ["position", "section"])
    return Response({"ok": True})
