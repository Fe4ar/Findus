"""Personal dashboard: own shortcuts and categories, team shortcuts set by leaders, global ones set by admins."""
import re
from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from .models import Shortcut, ShortcutCategory, Team
from .permissions import is_admin
from .services import check_all


def _may_edit(user, cat):
    if cat.user_id:
        return cat.user_id == user.id
    if cat.team_id:
        return is_admin(user) or cat.team.members.filter(user=user, is_leader=True).exists()
    return is_admin(user)


def _category(user, cat_id):
    cat = ShortcutCategory.objects.select_related("team").filter(pk=cat_id).first()
    if cat is None or not _may_edit(user, cat):
        raise NotFound()
    return cat


def _check_url(url):
    url = str(url or "").strip()
    # "192.0.2.1" or "fritz.box:8080" get http://; "javascript:x" has a scheme without // and stays invalid.
    if url and "://" not in url and not re.match(r"[a-z][a-z0-9+.-]*:(?!\d)", url, re.I):
        url = "http://" + url
    if not url.lower().startswith(("http://", "https://", "tcp://")) or len(url) > 500:
        raise ValidationError({"url": "Adresse muss mit http://, https:// oder tcp:// beginnen."})
    return url


def _fields(d, partial=False):
    out = {}
    if "name" in d or not partial:
        out["name"] = str(d.get("name") or "").strip()[:100]
        if not out["name"]:
            raise ValidationError({"name": "Name fehlt."})
    if "url" in d or not partial:
        out["url"] = _check_url(d.get("url"))
    if "icon" in d:
        out["icon"] = str(d["icon"] or "🔗").strip()[:40] or "🔗"
    if "description" in d:
        out["description"] = str(d["description"] or "")[:300]
    return out


@api_view(["GET"])
def dashboard(request):
    u = request.user
    if not u.is_authenticated:
        raise NotFound()
    team_ids = set(u.team_memberships.values_list("team_id", flat=True))
    cats = [c for c in ShortcutCategory.objects.select_related("team").prefetch_related("shortcuts")
            if c.user_id == u.id or c.team_id in team_ids or (c.user_id is None and c.team_id is None)]
    order = {"global": 0, "team": 1, "user": 2}
    kind = lambda c: "user" if c.user_id else "team" if c.team_id else "global"
    cats.sort(key=lambda c: (order[kind(c)], c.team.name if c.team_id else "", c.position, c.id))
    status = check_all([s.url for c in cats for s in c.shortcuts.all()])
    return Response({"categories": [
        {"id": c.id, "name": c.name, "kind": kind(c), "team": c.team.name if c.team_id else None, "team_id": c.team_id,
         "editable": _may_edit(u, c),
         "shortcuts": [{"id": s.id, "name": s.name, "url": s.url, "icon": s.icon, "description": s.description,
                        "online": status.get(s.url)} for s in c.shortcuts.all()]} for c in cats],
        "teams": [{"id": t.id, "name": t.name} for t in Team.objects.all() if is_admin(u) or t.id in
                  set(u.team_memberships.filter(is_leader=True).values_list("team_id", flat=True))],
        "is_admin": is_admin(u)})


@api_view(["POST"])
def category_create(request):
    d = request.data
    name = str(d.get("name") or "").strip()[:100]
    if not name:
        raise ValidationError({"name": "Name fehlt."})
    cat = ShortcutCategory(name=name)
    if d.get("team"):
        cat.team = Team.objects.filter(pk=d["team"]).first()
        if cat.team is None or not _may_edit(request.user, cat):
            raise NotFound()
    elif d.get("global"):
        if not is_admin(request.user):
            raise PermissionDenied()
    else:
        cat.user = request.user
    last = ShortcutCategory.objects.filter(user=cat.user, team=cat.team).order_by("-position").first()
    cat.position = last.position + 1 if last else 0
    cat.save()
    return Response({"id": cat.id}, status=201)


@api_view(["PATCH", "DELETE"])
def category_edit(request, cat_id):
    cat = _category(request.user, cat_id)
    if request.method == "DELETE":
        cat.delete()
        return Response(status=204)
    name = str(request.data.get("name") or "").strip()[:100]
    if not name:
        raise ValidationError({"name": "Name fehlt."})
    cat.name = name
    cat.save()
    return Response({"id": cat.id})


@api_view(["POST"])
def shortcut_create(request):
    cat = _category(request.user, request.data.get("category"))
    last = cat.shortcuts.order_by("-position").first()
    s = Shortcut.objects.create(category=cat, position=last.position + 1 if last else 0, **_fields(request.data))
    return Response({"id": s.id}, status=201)


@api_view(["PATCH", "DELETE"])
def shortcut_edit(request, sc_id):
    s = Shortcut.objects.select_related("category__team").filter(pk=sc_id).first()
    if s is None or not _may_edit(request.user, s.category):
        raise NotFound()
    if request.method == "DELETE":
        s.delete()
        return Response(status=204)
    for k, v in _fields(request.data, partial=True).items():
        setattr(s, k, v)
    if "category" in request.data and request.data["category"] != s.category_id:
        s.category = _category(request.user, request.data["category"])
    s.save()
    return Response({"id": s.id})


@api_view(["PUT"])
def order(request):
    """Drag & drop result: {categories: [id…], shortcuts: {category id: [shortcut id…]}} – only what the user may edit."""
    with transaction.atomic():
        for i, cid in enumerate(request.data.get("categories") or []):
            cat = ShortcutCategory.objects.select_related("team").filter(pk=cid).first()
            if cat and _may_edit(request.user, cat):
                ShortcutCategory.objects.filter(pk=cid).update(position=i)
        for cid, ids in (request.data.get("shortcuts") or {}).items():
            cat = ShortcutCategory.objects.select_related("team").filter(pk=cid).first()
            if cat is None or not _may_edit(request.user, cat):
                continue
            for i, sid in enumerate(ids):
                s = Shortcut.objects.select_related("category__team").filter(pk=sid).first()
                # Moves between categories are allowed only between categories of the same owner.
                if s and _may_edit(request.user, s.category) and (s.category_id == cat.id or (
                        s.category.user_id == cat.user_id and s.category.team_id == cat.team_id)):
                    Shortcut.objects.filter(pk=sid).update(category=cat, position=i)
    return Response({"ok": True})
