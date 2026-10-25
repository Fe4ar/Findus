import uuid

import nh3
from django.contrib.auth import authenticate, login, logout
from django.db import connection, transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from .models import Node, PageRevision
from .permissions import READ, WRITE, can, effective
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
    "div": {"data-drawio"},  # draw.io diagram block, value = .drawio file node id
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


def node_summary(n):
    return {"id": n.id, "kind": n.kind, "title": n.title, "status": n.status, "position": n.position,
            "has_children": n.kind in Node.CONTAINERS and n.children.filter(deleted_at=None).exists()}


def node_detail(user, n):
    data = {
        **node_summary(n),
        "parent": n.parent_id, "description": n.description, "tags": n.tags, "version": n.version,
        "is_public": n.is_public,
        "target": n.target_id if n.target and n.target.deleted_at is None else None,
        "created_by": user_name(n.created_by), "created_at": n.created_at,
        "updated_by": user_name(n.updated_by), "updated_at": n.updated_at,
        "breadcrumb": [{"id": a.id, "title": a.title, "kind": a.kind} for a in n.ancestors()],
        "permissions": effective(user, n),
    }
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
    if space == Node.KARTE:
        if parent is not None and parent.kind != Node.FOLDER:
            raise ValidationError({"parent": "Ziel muss ein Ordner sein."})
    elif kind == Node.AREA:
        if parent is not None:
            raise ValidationError({"parent": "Bereiche liegen immer auf oberster Ebene."})
    elif parent is None or parent.kind not in Node.CONTAINERS:
        raise ValidationError({"parent": "Ziel muss ein Bereich oder Ordner sein."})


@api_view(["GET"])
def health(request):
    with connection.cursor() as cur:
        cur.execute("SELECT 1")
    return Response({"ok": True})


@api_view(["POST"])
def auth_login(request):
    user = authenticate(request, username=request.data.get("username"), password=request.data.get("password"))
    if user is None:
        return Response({"detail": "Benutzername oder Passwort falsch."}, status=400)
    login(request, user)
    return Response(me_data(user))


@api_view(["POST"])
def auth_logout(request):
    logout(request)
    return Response(status=204)


def me_data(user):
    if not user.is_authenticated:
        return {"authenticated": False}
    return {"authenticated": True, "username": user.get_username(), "name": user_name(user),
            "is_superuser": user.is_superuser}


@ensure_csrf_cookie
@api_view(["GET"])
def auth_me(request):
    return Response(me_data(request.user))


@api_view(["GET"])
def tree(request):
    parent_id = request.query_params.get("parent") or None
    if parent_id:
        parent = node_or_404(request.user, parent_id)
        qs = parent.children.filter(deleted_at=None)
    else:
        space = request.query_params.get("space") or Node.WIKI
        qs = Node.objects.filter(parent=None, deleted_at=None, space=space)
    return Response([node_summary(n) for n in qs if can(request.user, READ, n)])


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
    last = Node.objects.filter(parent=parent, space=space, deleted_at=None).order_by("-position").first()
    node = Node.objects.create(parent=parent, kind=kind, space=space, title=title[:255], target=target,
                               position=(last.position + 1) if last else 0,
                               created_by=request.user, updated_by=request.user)
    return Response(node_detail(request.user, node), status=201)


@api_view(["GET", "PATCH", "DELETE"])
def node_view(request, node_id):
    if request.method == "GET":
        return Response(node_detail(request.user, node_or_404(request.user, node_id)))

    node = node_or_404(request.user, node_id, WRITE)
    if request.method == "DELETE":
        now = timezone.now()
        with transaction.atomic():
            todo = [node]
            while todo:
                n = todo.pop()
                todo.extend(n.children.filter(deleted_at=None))
                Node.objects.filter(pk=n.pk).update(deleted_at=now, updated_by=request.user)
        return Response(status=204)

    data = request.data
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
        node.status = data["status"]
    if "parent" in data and str(data["parent"] or "") != str(node.parent_id or ""):
        target = node_or_404(request.user, data["parent"], WRITE) if data["parent"] else None
        validate_parent(node.kind, target, node.space)
        if target and (target.pk == node.pk or node in target.ancestors()):
            raise ValidationError({"parent": "Ein Ordner kann nicht in sich selbst verschoben werden."})
        node.parent = target
    if "position" in data:
        node.position = int(data["position"])
    node.updated_by = request.user
    node.save()
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
    return Response(node_detail(request.user, node))
