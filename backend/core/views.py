import uuid
from pathlib import Path

import nh3
from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.models import Group
from django.db import connection, transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from .models import IntegrationSettings, Node, NodePermission, PageRevision, UserSettings
from . import audit, rights, throttle
from .features import enabled
from .permissions import FLAGS, MANAGE, PUBLISH, READ, WRITE, _chain, can, can_download, effective, governing, is_admin
from .search import revision_text

# Tags TipTap produces; everything else is stripped server-side.
HTML_TAGS = {
    "p", "br", "h1", "h2", "h3", "h4", "strong", "em", "u", "s", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "img", "hr", "table", "thead", "tbody", "tr", "th", "td", "span", "div",
}
HTML_ATTRS = {
    "a": {"href", "title", "target"},
    "img": {"src", "alt", "title", "width", "height"},
    "pre": {"class"}, "code": {"class"}, "span": {"class"},
    "th": {"colspan", "rowspan"}, "td": {"colspan", "rowspan"},
    "div": {"data-drawio", "data-docfile", "data-docname"},  # draw.io diagram / embedded document block, value = file node id (+ its name)
}


def sanitize(html):
    return nh3.clean(html, tags=HTML_TAGS, attributes=HTML_ATTRS, url_schemes={"http", "https", "mailto"})


def node_or_404(user, node_id, action=READ):
    node = get_object_or_404(Node.objects.select_related("parent", "created_by", "updated_by"), pk=node_id)
    # Unreadable and deleted look the same as missing.
    if any(n.deleted_at for n in [node, *node.ancestors()]) or not can(user, READ, node):
        raise NotFound()
    if action != READ and not can(user, action, node):
        raise PermissionDenied()
    return node


def user_name(u):
    return (u.get_full_name() or u.get_username()) if u else None


def node_summary(n, ctx=None):
    out = {"id": n.id, "kind": n.kind, "title": n.title, "status": n.status, "position": n.position,
           "has_children": n.kind in Node.CONTAINERS and n.children.filter(deleted_at=None, hidden=False).exists()}
    if ctx is not None and n.kind in Node.CONTAINERS and n.space == Node.WIKI:
        out["vis"] = ctx.visibility(n)  # same logic as the "Wirksam" column of the rights page
        out["team"] = ctx.team_of_area.get(n.pk)
        if n.kind == Node.FOLDER:
            out["shared"] = [s["name"] for s in ctx.shared_with(n)]  # teams this folder is shared with (small icon, hover)
    return out


def node_detail(user, n):
    data = {
        **node_summary(n),
        "parent": n.parent_id, "description": n.description, "tags": n.tags, "version": n.version,
        "is_public": n.is_public,
        "space": n.space,
        "target": n.target_id if n.target and n.target.deleted_at is None else None,
        "created_by": user_name(n.created_by), "created_at": n.created_at,
        "updated_by": user_name(n.updated_by), "updated_at": n.updated_at,
        "breadcrumb": [{"id": a.id, "title": a.title, "kind": a.kind} for a in n.ancestors()],
        "permissions": effective(user, n),
    }
    from .shares import share_root
    via = share_root(user, n)
    if via:  # reached through a folder somebody shared: the path starts there, the tab is the receiving team's (or Privat for a user share)
        root, team_id = via
        ids = [b["id"] for b in data["breadcrumb"]]
        data["breadcrumb"] = data["breadcrumb"][ids.index(root.id):] if root.id in ids else []
        if team_id is not None:
            data["via_team"] = team_id
        else:
            data["via_user"] = True
    if n.kind in Node.REVISIONED:
        rev = n.revisions.first()
        data["content"] = rev.content if rev else None
        data["content_html"] = rev.content_html if rev else ""
    if n.kind == Node.FILE:
        data["versions"] = [file_version_data(v) for v in n.file_versions.select_related("user")]
    return data


def file_version_data(v):
    return {"id": v.id, "original_name": v.original_name, "mime": v.mime, "size": v.size, "sha256": v.sha256,
            "user": user_name(v.user), "comment": v.comment, "source": v.source, "created_at": v.created_at,
            "url": f"/media-dl/{v.id}"}


def is_uuid(value):
    try:
        uuid.UUID(str(value))
        return True
    except ValueError:
        return False


def is_drawio(node):
    return node.kind == Node.FILE and node.space == Node.WIKI and node.title.lower().endswith(".drawio")


def validate_parent(kind, parent, space=Node.WIKI):
    if kind not in Node.SPACE_KINDS[space]:
        raise ValidationError({"kind": "Dieser Typ ist hier nicht erlaubt."})
    if parent is not None and parent.space != space:
        raise ValidationError({"parent": "Wiki und Karten sind getrennte Bäume."})
    if kind == Node.AREA:
        if parent is not None:
            raise ValidationError({"parent": "Bereiche liegen immer auf oberster Ebene."})
    elif space == Node.KARTE and parent is None:
        pass  # maps and folders may still sit at the top of the network tree (drag back to the top level)
    elif parent is None or parent.kind not in Node.CONTAINERS:
        raise ValidationError({"parent": "Ziel muss ein Bereich oder Ordner sein."})


# backend/VERSION is bumped together with frontend/package.json; the TV dashboard reads it from here.
VERSION = (Path(__file__).resolve().parent.parent / "VERSION").read_text().strip()


@api_view(["GET"])
def health(request):
    with connection.cursor() as cur:
        cur.execute("SELECT 1")
    return Response({"ok": True, "version": VERSION})


@api_view(["GET"])
def info(request):
    """Product information and the changelog (backend/CHANGELOG.md) for the administration's Info page."""
    if not request.user.is_authenticated:
        raise PermissionDenied()
    import django
    import platform
    try:
        changelog = (settings.BASE_DIR / "CHANGELOG.md").read_text(encoding="utf-8")
    except OSError:
        changelog = ""
    return Response({"name": "Findus", "version": VERSION, "license": "GNU AGPL v3", "repository": "https://github.com/Fe4ar/Findus",
                     "django": django.get_version(), "python": platform.python_version(), "changelog": changelog})


@api_view(["POST"])
def auth_login(request):
    name = str(request.data.get("username") or "")
    ks = throttle.keys(request, name)
    wait = throttle.locked_seconds(ks)
    if wait:
        return Response({"detail": f"Zu viele Fehlversuche. Bitte in {wait} Sekunden erneut versuchen."}, status=429, headers={"Retry-After": str(wait)})
    user = authenticate(request, username=request.data.get("username"), password=request.data.get("password"))
    if user is None:
        audit.log(request, "login_failed", username=name[:150])
        if (locked := throttle.record_failure(ks)):
            audit.log(request, "login_locked", username=name[:150], locked=locked)
        return Response({"detail": "Benutzername oder Passwort falsch."}, status=400)
    throttle.record_success(ks)
    login(request, user)
    audit.log(request, "login", user=user)
    return Response(me_data(user))


@api_view(["GET"])
def auth_gate(request):
    """forward_auth target of Caddy for /office/: 204 for a signed-in session, 401 for everyone else."""
    return Response(status=204 if request.user.is_authenticated else 401)


@api_view(["POST"])
def auth_logout(request):
    if request.user.is_authenticated:
        audit.log(request, "logout")
    logout(request)
    return Response(status=204)


def private_area(user):
    """The user's personal area, created on first use (rights: permissions.can, owner only)."""
    area = Node.objects.filter(parent=None, owner=user, deleted_at=None).first()
    if area is None:
        area = Node.objects.create(kind=Node.AREA, space=Node.WIKI, title="Mein Bereich", status=Node.PUBLISHED,
                                   never_public=True, owner=user, created_by=user, updated_by=user)
    return area


def nav_data(user):
    """Top navigation: one tab per team (admins: all teams) with its area, and whether areas outside every team exist."""
    from .models import Team
    teams = Team.objects.all() if is_admin(user) else Team.objects.filter(members__user=user)
    other = any(not a.is_public and not hasattr(a, "team") and a.owner_id is None and can(user, READ, a)
                for a in Node.objects.filter(parent=None, kind=Node.AREA, space=Node.WIKI, deleted_at=None))
    admin = is_admin(user)
    led = {m.team_id: m.is_leader or m.can_write for m in user.team_memberships.all()}
    return {"private": private_area(user).id if user.is_active else None,
            "teams": [{"id": t.id, "name": t.name, "area": t.area_id, "write": admin or led.get(t.id, False)}
                      for t in teams.distinct().select_related("area") if t.area_id],
            "other": other,
            "public_areas": [a.id for a in Node.objects.filter(parent=None, kind=Node.AREA, space=Node.WIKI, is_public=True, deleted_at=None)
                             if can(user, READ, a)]}


def me_data(user):
    if not user.is_authenticated:
        return {"authenticated": False}
    return {"authenticated": True, "username": user.get_username(), "name": user_name(user),
            "is_superuser": user.is_superuser, "is_admin": is_admin(user), "can_create_area": can(user, WRITE) and "wiki" in enabled(user), "can_overview": can(user, READ),
            "can_download": can_download(user), "collabora": bool(settings.COLLABORA_UPSTREAM), "features": sorted(enabled(user)), "nav": nav_data(user), "todoist": IntegrationSettings.allowed(), "idle_logout_minutes": IntegrationSettings.idle_minutes(), "teams": [{"id": m.team_id, "name": m.team.name, "leader": m.is_leader, "can_write": m.is_leader or m.can_write}
                      for m in user.team_memberships.select_related("team")],
            "theme": getattr(getattr(user, "findus_settings", None), "theme", "auto"),
            "language": getattr(getattr(user, "findus_settings", None), "language", "de"),
            "wiki_view": getattr(getattr(user, "findus_settings", None), "wiki_view", "tree"),
            "must_change_password": bool(getattr(getattr(user, "findus_settings", None), "must_change_password", False))}


@api_view(["POST"])
def auth_password(request):
    """Own password: old one once, new one twice. Also the way out of the start admin's forced change."""
    from django.contrib.auth import update_session_auth_hash
    from django.contrib.auth.password_validation import validate_password
    from django.core.exceptions import ValidationError as DjangoValidationError
    user = request.user
    if not user.is_authenticated:
        raise PermissionDenied()
    ks = [("user", f"pwchange:{user.pk}")]
    wait = throttle.locked_seconds(ks)
    if wait:
        return Response({"detail": f"Zu viele Fehlversuche. Bitte in {wait} Sekunden erneut versuchen."}, status=429, headers={"Retry-After": str(wait)})
    old, new, again = (str(request.data.get(k) or "") for k in ("old", "new", "new2"))
    if not user.check_password(old):
        throttle.record_failure(ks)
        raise ValidationError({"old": "Das bisherige Passwort stimmt nicht."})
    if new != again:
        raise ValidationError({"new2": "Die beiden neuen Passwörter sind verschieden."})
    if new == old:
        raise ValidationError({"new": "Das neue Passwort muss sich vom bisherigen unterscheiden."})
    try:
        validate_password(new, user)
    except DjangoValidationError as e:
        raise ValidationError({"new": list(e.messages)})
    user.set_password(new)
    user.save(update_fields=["password"])
    UserSettings.objects.filter(user=user).update(must_change_password=False)
    throttle.record_success(ks)
    update_session_auth_hash(request, user)  # this session stays signed in, other sessions of the account end
    audit.log(request, "user", username=user.get_username(), what="Passwort geändert")
    from django.contrib.auth import get_user_model
    return Response(me_data(get_user_model().objects.get(pk=user.pk)))


@api_view(["PUT"])
def auth_settings(request):
    if not request.user.is_authenticated:
        raise PermissionDenied()
    d, values = request.data, {}
    if "theme" in d or not ("language" in d or "wiki_view" in d):
        if d.get("theme") not in dict(UserSettings.THEMES):
            raise ValidationError({"theme": "auto, light, dark oder color."})
        values["theme"] = d["theme"]
    if "wiki_view" in d:
        if d["wiki_view"] not in dict(UserSettings.WIKI_VIEWS):
            raise ValidationError({"wiki_view": "tree oder classic."})
        values["wiki_view"] = d["wiki_view"]
    if "language" in d:
        if d["language"] not in dict(UserSettings.LANGUAGES):
            raise ValidationError({"language": "de oder en."})
        values["language"] = d["language"]
    UserSettings.objects.update_or_create(user=request.user, defaults=values)
    request.user.refresh_from_db()
    return Response(me_data(request.user))


@ensure_csrf_cookie
@api_view(["GET"])
def auth_me(request):
    return Response(me_data(request.user))


@api_view(["GET"])
def tree(request):
    parent_id = request.query_params.get("parent") or None
    if parent_id:
        parent = node_or_404(request.user, parent_id)
        qs = parent.children.filter(deleted_at=None, hidden=False)  # inline attachments of pages stay out of the tree
    else:
        space = request.query_params.get("space") or Node.WIKI
        if space == Node.KARTE and request.user.is_authenticated and "network" not in enabled(request.user):
            raise PermissionDenied("Diese Funktion ist für dein Team nicht aktiviert.")
        qs = Node.objects.filter(parent=None, deleted_at=None, space=space)
        # Navigation tabs: "Alle Anwender" lists the public areas, the rest-of-wiki tab everything that is neither public nor a team's.
        scope = request.query_params.get("scope")
        if scope == "private":
            qs = qs.filter(owner=request.user) if request.user.is_authenticated else qs.none()
        else:
            qs = qs.filter(owner=None)  # personal areas only show under "Privat"
        if scope == "public":
            qs = qs.filter(is_public=True)
        elif scope == "other":
            qs = qs.filter(is_public=False, team=None)
    from .shares import can_share
    ctx = rights.Context()
    details = request.query_params.get("details") == "1"  # explorer view: change date and author, size of files
    out = []
    for n in qs.select_related("updated_by") if details else qs:
        if not can(request.user, READ, n):
            continue
        row = {**node_summary(n, ctx), "writable": can(request.user, WRITE, n),
               **({"updated_at": n.updated_at, "updated_by": user_name(n.updated_by),
                   "size": (n.file_versions.first().size if n.kind == Node.FILE and n.file_versions.exists() else None)} if details else {}),
               **({"can_share": can_share(request.user, n)} if n.kind == Node.FOLDER else {})}
        if n.kind == Node.FOLDER and n.space == Node.WIKI:
            if row.get("can_share") or not _chain(n)[-1].owner_id:
                row["shared"] = [*row.get("shared", []), *[user_name(s.user) for s in n.user_shares.select_related("user")]]
            else:
                row["shared"] = []  # a recipient of a private folder does not see with whom else it is shared
        out.append(row)
    return Response(out)


@api_view(["POST"])
def node_create(request):
    kind = request.data.get("kind")
    if kind not in (Node.AREA, Node.FOLDER, Node.PAGE, Node.MAP, Node.LINK):
        raise ValidationError({"kind": "area, folder, page, map oder link"})
    target = None
    if kind == Node.LINK:
        target = Node.objects.filter(pk=request.data.get("target") or None, deleted_at=None).first() \
            if is_uuid(request.data.get("target")) else None
        if target is None or not can(request.user, READ, target) or not is_drawio(target):
            raise ValidationError({"target": "Ziel muss eine draw.io-Datei im Wiki sein."})
    title = (request.data.get("title") or "").strip() or (target.title.removesuffix(".drawio") if target else "")
    if not title:
        raise ValidationError({"title": "Titel fehlt."})
    parent = node_or_404(request.user, request.data["parent"], WRITE) if request.data.get("parent") else None
    if parent is None and not can(request.user, WRITE):
        raise NotFound()
    space = parent.space if parent else request.data.get("space") or Node.WIKI
    if space not in Node.SPACE_KINDS:
        raise ValidationError({"space": "wiki oder karte"})
    validate_parent(kind, parent, space)
    if parent is None and ("network" if space == Node.KARTE else "wiki") not in enabled(request.user):
        raise PermissionDenied("Diese Funktion ist für dein Team nicht aktiviert.")
    last = Node.objects.filter(parent=parent, space=space, deleted_at=None).order_by("-position").first()
    # Without the publish right new content starts as a draft, so only writers see it until someone publishes it.
    status = Node.PUBLISHED if kind in Node.CONTAINERS or can(request.user, PUBLISH, parent) else Node.DRAFT
    node = Node.objects.create(parent=parent, kind=kind, space=space, title=title[:255], target=target,
                               position=(last.position + 1) if last else 0, status=status,
                               created_by=request.user, updated_by=request.user)
    if parent is None and not is_admin(request.user):
        # A new area starts with the creator's groups only (Admins see everything anyway); rights are set on the rights page.
        for p in NodePermission.objects.filter(node=None, group__user=request.user):
            NodePermission.objects.create(node=node, group=p.group, can_read=p.can_read, can_write=p.can_write,
                                          can_publish=p.can_publish)
        node.never_public = True
        node.save(update_fields=["never_public"])
    audit.log(request, "create", node, kind=kind)
    return Response(node_detail(request.user, node), status=201)


@api_view(["POST"])
def node_reorder(request, node_id):
    """Body {before: <node id>|null, first: bool, parent: <folder id>}: put the node in front of that node (null = last, first = at the top).
    With "parent" the node first moves into that folder (or out of its folder onto a higher level), like a PATCH of the parent.
    Needs the write right in the source and in the target folder; files and other kinds are listed together, hidden attachments are not part of the order."""
    node = node_or_404(request.user, node_id, WRITE)
    old = node.parent
    if old is None or not can(request.user, WRITE, old):
        raise PermissionDenied("Die Reihenfolge ändert, wer im Ordner schreiben darf.")
    parent, moved = old, False
    if "parent" in request.data and str(request.data["parent"] or "") != str(node.parent_id):
        from .shares import guard_root
        guard_root(request.user, node)  # a folder shared by another team is moved only by its owners
        parent = node_or_404(request.user, request.data["parent"], WRITE) if request.data["parent"] else None
        if parent is None:
            raise ValidationError({"parent": "Zielordner fehlt."})
        validate_parent(node.kind, parent, node.space)
        if parent.pk == node.pk or node in parent.ancestors():
            raise ValidationError({"parent": "Ein Ordner kann nicht in sich selbst verschoben werden."})
        moved = True
    rows = [n for n in Node.objects.filter(parent=parent, space=node.space, deleted_at=None, hidden=False) if n.pk != node.pk]
    before = request.data.get("before")
    ids = [str(n.pk) for n in rows]
    if before is not None and str(before) not in ids:
        raise ValidationError({"before": "Zielposition liegt nicht in diesem Ordner."})
    at = 0 if request.data.get("first") else ids.index(str(before)) if before is not None else len(rows)
    rows.insert(at, node)
    node.parent = parent
    node.__dict__.pop("_findus_chain", None)  # rights are inherited from the new place
    for i, n in enumerate(rows):
        n.position = i
    Node.objects.bulk_update(rows, ["position", "parent"])
    if moved:
        audit.log(request, "move", node, parent=[str(old.pk), str(parent.pk)])
    return Response({"ok": True})


@api_view(["GET", "PATCH", "DELETE"])
def node_view(request, node_id):
    if request.method == "GET":
        return Response(node_detail(request.user, node_or_404(request.user, node_id)))

    node = node_or_404(request.user, node_id, WRITE)
    if request.method == "DELETE" or "parent" in request.data:
        from .shares import guard_root
        guard_root(request.user, node)  # a folder shared by another team is moved or deleted only by its owners
    if request.method == "DELETE":
        now = timezone.now()
        with transaction.atomic():
            todo = [node]
            while todo:
                n = todo.pop()
                todo.extend(n.children.filter(deleted_at=None))
                Node.objects.filter(pk=n.pk).update(deleted_at=now, updated_by=request.user)
        audit.log(request, "delete", node)
        return Response(status=204)

    data = request.data
    before = {"title": node.title, "status": node.status, "parent": str(node.parent_id or ""), "is_public": node.is_public}
    for field in ("title", "description"):
        if field in data:
            setattr(node, field, str(data[field]).strip()[:255] if field == "title" else str(data[field]))
    if not node.title:
        raise ValidationError({"title": "Titel fehlt."})
    if "tags" in data:
        node.tags = [str(t).strip()[:50] for t in data["tags"] if str(t).strip()]
    if "status" in data:
        if data["status"] not in (Node.DRAFT, Node.PUBLISHED):
            raise ValidationError({"status": "draft oder published"})
        if data["status"] != node.status and not can(request.user, PUBLISH, node):
            raise PermissionDenied("Veröffentlichen erfordert das Recht „Veröffentlichen“.")
        node.status = data["status"]
    if "is_public" in data and bool(data["is_public"]) != node.is_public:
        if node.kind != Node.AREA or node.space != Node.WIKI:
            raise ValidationError({"is_public": "Nur Bereiche im Wiki können öffentlich sein."})
        if not can(request.user, MANAGE, node):
            raise PermissionDenied()
        if data["is_public"]:
            raise ValidationError({"is_public": "„Ohne Anmeldung“ gibt es nur im FAQ."})
        node.is_public = False
    if "parent" in data and str(data["parent"] or "") != str(node.parent_id or ""):
        target = node_or_404(request.user, data["parent"], WRITE) if data["parent"] else None
        validate_parent(node.kind, target, node.space)
        if target and (target.pk == node.pk or node in target.ancestors()):
            raise ValidationError({"parent": "Ein Ordner kann nicht in sich selbst verschoben werden."})
        node.parent = target
        node.__dict__.pop("_findus_chain", None)  # rights are inherited from the new place from now on
    if "position" in data:
        node.position = int(data["position"])
    node.updated_by = request.user
    node.save()
    after = {"title": node.title, "status": node.status, "parent": str(node.parent_id or ""), "is_public": node.is_public}
    changed = {k: [before[k], after[k]] for k in before if before[k] != after[k]}
    if "parent" in changed:
        audit.log(request, "move", node, **changed)
    elif "status" in changed:
        audit.log(request, "publish", node, **changed)
    elif changed or any(f in data for f in ("description", "tags")):
        audit.log(request, "update", node, **changed)
    return Response(node_detail(request.user, node))


@api_view(["PUT"])
def page_content(request, node_id):
    node = node_or_404(request.user, node_id, WRITE)
    if node.kind not in Node.REVISIONED:
        raise NotFound()
    content = request.data.get("content") or {}
    if node.kind == Node.MAP and not isinstance(content.get("elements"), list):
        raise ValidationError({"content": "Karte braucht eine Liste elements."})
    with transaction.atomic():
        node = Node.objects.select_for_update().get(pk=node.pk)
        if int(request.data.get("base_version", -1)) != node.version:
            return Response({"detail": "Seite wurde inzwischen geändert.", "current": node_detail(request.user, node)},
                            status=409)
        rev = PageRevision.objects.create(node=node, content=content,
                                          content_html=sanitize(request.data.get("html") or "") if node.kind == Node.PAGE else "",
                                          user=request.user, comment=(request.data.get("comment") or "")[:255])
        node.search_text = revision_text(node.kind, rev.content, rev.content_html)
        node.version += 1
        node.updated_by = request.user
        node.save()
    audit.log(request, "update", node, version=node.version)
    return Response(node_detail(request.user, node))


@api_view(["GET"])
def history(request, node_id):
    node = node_or_404(request.user, node_id)
    if node.kind in Node.REVISIONED:
        return Response([{"id": r.id, "user": user_name(r.user), "comment": r.comment, "created_at": r.created_at}
                         for r in node.revisions.select_related("user")])
    if node.kind == Node.FILE:
        return Response([file_version_data(v) for v in node.file_versions.select_related("user")])
    return Response([])


@api_view(["GET"])
def history_revision(request, node_id, rev_id):
    node = node_or_404(request.user, node_id)
    rev = get_object_or_404(node.revisions, pk=rev_id)
    return Response({"id": rev.id, "content": rev.content, "content_html": rev.content_html,
                     "user": user_name(rev.user), "comment": rev.comment, "created_at": rev.created_at})


@api_view(["POST"])
def history_restore(request, node_id, rev_id):
    node = node_or_404(request.user, node_id, WRITE)
    rev = get_object_or_404(node.revisions, pk=rev_id)
    with transaction.atomic():
        node = Node.objects.select_for_update().get(pk=node.pk)
        PageRevision.objects.create(node=node, content=rev.content, content_html=rev.content_html, user=request.user,
                                    comment=f"Wiederhergestellt: Version vom {timezone.localtime(rev.created_at):%d.%m.%Y %H:%M}")
        node.search_text = revision_text(node.kind, rev.content, rev.content_html)
        node.version += 1
        node.updated_by = request.user
        node.save()
    audit.log(request, "restore", node, revision=rev_id)
    return Response(node_detail(request.user, node))


def _flags(p):
    return {f: getattr(p, f) for f in FLAGS.values()}


@api_view(["GET", "PUT"])
def node_permissions(request, node_id):
    """Group rights set directly on a node (PUT replaces them) plus what each group inherits from above."""
    node = node_or_404(request.user, node_id, MANAGE)
    from .shares import guard_receiver
    guard_receiver(request.user, node)
    groups = list(Group.objects.order_by("name"))
    if request.method == "PUT":
        rows = request.data.get("rows")
        if not isinstance(rows, list):
            raise ValidationError({"rows": "Liste erwartet."})
        by_id = {g.id: g for g in groups}
        new = {}
        for r in rows:
            gid = r.get("group") if isinstance(r, dict) else None
            if gid not in by_id:
                raise ValidationError({"rows": f"Unbekannte Gruppe {gid!r}."})
            flags = {f: bool(r.get(f)) for f in FLAGS.values()}
            if any(flags.values()):
                new[gid] = flags
        with transaction.atomic():
            old = {p.group.name: _flags(p) for p in node.permissions.select_related("group")}
            node.permissions.all().delete()
            NodePermission.objects.bulk_create(NodePermission(node=node, group_id=g, **f) for g, f in new.items())
        audit.log(request, "permissions", node, before=old, after={by_id[g].name: f for g, f in new.items()})
        request.user.__dict__.pop("_findus_grants", None)
    chain = _chain(node)[1:]
    chain = [a.pk for a in chain[:governing(_chain(node)) ]]  # what inherits down to this node (up to the governing one)
    own = {p.group_id: _flags(p) for p in node.permissions.all()}
    inherited = {}
    for p in NodePermission.objects.filter(Q(node=None, can_manage=True) | Q(node_id__in=chain)):
        acc = inherited.setdefault(p.group_id, dict.fromkeys(FLAGS.values(), False))
        for f, on in _flags(p).items():
            acc[f] = acc[f] or on
    return Response({"groups": [{"id": g.id, "name": g.name, "own": own.get(g.id),
                                 "inherited": inherited.get(g.id, dict.fromkeys(FLAGS.values(), False))}
                                for g in groups]})
