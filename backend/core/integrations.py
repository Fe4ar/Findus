"""Integration endpoints: Todoist connection per user (token stored encrypted, never returned) and the global admin switch."""
from rest_framework.decorators import api_view
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from . import audit, todoist
from .admin_api import need_admin
from .features import enabled
from .models import IntegrationSettings, TodoistLink
from .tasks import need_tasks


def need_todoist(request):
    need_tasks(request)  # the team function "Aufgaben" governs it
    if not IntegrationSettings.allowed():
        raise PermissionDenied("Die Todoist-Integration ist von einem Administrator ausgeschaltet.")


def link_data(user):
    link = TodoistLink.objects.filter(user=user).first()
    base = {"allowed": IntegrationSettings.allowed(), "connected": link is not None}
    if link is None:
        return base
    # The token itself is never part of a response; only that there is one, since when, and how the last run went.
    return {**base, "since": link.connected_at, "project": {"id": link.project_id, "name": link.project_name},
            "include_private": link.include_private, "import_new": link.import_new,
            "last_sync_at": link.last_sync_at, "last_error": link.last_error, "last_error_at": link.last_error_at}


def _fail(e):
    status = 400 if e.kind in ("auth", "api") else 502
    return Response({"detail": str(e)}, status=status)


@api_view(["GET", "POST", "PATCH", "DELETE"])
def todoist_link(request):
    need_todoist(request)
    user = request.user
    if request.method == "GET":
        return Response(link_data(user))
    if request.method == "DELETE":
        deleted = TodoistLink.objects.filter(user=user).delete()[0]
        if deleted:
            audit.log(request, "user", None, what="Todoist getrennt")
        return Response(link_data(user))
    link = TodoistLink.objects.filter(user=user).first()
    if request.method == "POST":
        token = str(request.data.get("token") or "").strip()
        if not token or len(token) > 200 or any(c.isspace() for c in token):
            raise ValidationError({"token": "Bitte den persönlichen API-Token aus Todoist einfügen."})
        try:
            link = todoist.connect(user, token, request.data.get("project_id") or None)
        except todoist.TodoistError as e:
            return _fail(e)
        audit.log(request, "user", None, what="Todoist verbunden")
        todoist.sync_link(link)
        return Response(link_data(user), status=201)
    if link is None:
        raise ValidationError({"detail": "Todoist ist nicht verbunden."})
    d = request.data
    if "include_private" in d:
        link.include_private = bool(d["include_private"])
    if "import_new" in d:
        link.import_new = bool(d["import_new"])
    if d.get("project_id") and d["project_id"] != link.project_id:
        try:
            project = next((p for p in todoist.Client(todoist.decrypt(link.token_enc)).projects() if p["id"] == d["project_id"]), None)
        except todoist.TodoistError as e:
            return _fail(e)
        if project is None:
            raise ValidationError({"project_id": "Projekt nicht gefunden."})
        # Another project means a fresh start: the old links go, the tasks on both sides stay.
        link.project_id, link.project_name, link.sync_token = project["id"], project["name"], ""
        link.items.all().delete()
    link.save()
    return Response(link_data(user))


@api_view(["GET"])
def todoist_projects(request):
    need_todoist(request)
    link = TodoistLink.objects.filter(user=request.user).first()
    if link is None:
        raise ValidationError({"detail": "Todoist ist nicht verbunden."})
    try:
        return Response(todoist.Client(todoist.decrypt(link.token_enc)).projects())
    except todoist.TodoistError as e:
        return _fail(e)


@api_view(["POST"])
def todoist_sync_now(request):
    need_todoist(request)
    link = TodoistLink.objects.filter(user=request.user).first()
    if link is None:
        raise ValidationError({"detail": "Todoist ist nicht verbunden."})
    todoist.sync_link(link)
    return Response(link_data(request.user))


@api_view(["GET", "PUT"])
def admin_integrations(request):
    need_admin(request)
    if request.method == "PUT":
        if "todoist_allowed" not in request.data:
            raise ValidationError({"todoist_allowed": "true oder false"})
        on = bool(request.data["todoist_allowed"])
        IntegrationSettings.objects.update_or_create(pk=1, defaults={"todoist_allowed": on})
        audit.log(request, "user", None, what=f"Todoist-Integration {'erlaubt' if on else 'verboten'}")
    return Response({"todoist_allowed": IntegrationSettings.allowed(), "todoist_links": TodoistLink.objects.count()})
