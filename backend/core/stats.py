"""Page views, statistics for leaders/admins, the public FAQ landing data and the FAQ editors setting."""
from datetime import timedelta
from urllib.parse import urlsplit

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Count, F, Max, Q
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from .admin_api import _scope, need_admin
from .models import FaqEditor, FaqSettings, FileVersion, Node, PageCounter, PageView, Team, TeamMember
from .permissions import READ, can, is_public
from .views import node_or_404

User = get_user_model()
RAW_DAYS = 90  # shortcut: raw views are deleted after 90 days (purge_trash); only PageCounter.total keeps the history


def count_view(node, user):
    """Count a page view; the same viewer reloading within a minute counts once (user None = anonymous)."""
    recent = timezone.now() - timedelta(seconds=60)
    if not PageView.objects.filter(node=node, user=user, at__gte=recent).exists():
        with transaction.atomic():
            PageView.objects.create(node=node, user=user)
            c, _ = PageCounter.objects.get_or_create(node=node)
            PageCounter.objects.filter(pk=c.pk).update(total=F("total") + 1, last_viewed=timezone.now())


@api_view(["POST"])
def record_view(request, node_id):
    node = node_or_404(request.user, node_id)
    if node.kind != Node.PAGE:
        return Response(status=204)
    count_view(node, request.user if request.user.is_authenticated else None)
    return Response(status=204)


@api_view(["GET"])
def recent(request):
    """The pages the signed-in user opened last (from PageView), only those still readable and not deleted."""
    if not request.user.is_authenticated:
        raise NotFound()
    seen, out = set(), []
    for v in PageView.objects.filter(user=request.user).select_related("node").order_by("-at")[:200]:
        n = v.node
        if n.pk in seen:
            continue
        seen.add(n.pk)
        if any(x.deleted_at for x in [n, *n.ancestors()]) or not can(request.user, READ, n):
            continue
        out.append({"id": n.id, "title": n.title, "area": _root(n).title, "at": v.at})
        if len(out) == 5:
            break
    return Response(out)


def _root(node):
    while node.parent_id:
        node = node.parent
    return node


def _in_scope(node, area_ids):
    return area_ids is None or _root(node).pk in area_ids


@api_view(["GET"])
def stats(request):
    """Admin: everything, optionally ?team=<id>; team leaders: their teams' areas only."""
    admin, ids = _scope(request.user)
    want = request.query_params.get("team")
    teams = Team.objects.all() if admin else Team.objects.filter(pk__in=ids)
    if want:
        teams = teams.filter(pk=want)
        if not teams:
            raise NotFound()
    area_ids = None if admin and not want else {t.area_id for t in teams if t.area_id}
    nodes = Node.objects.filter(deleted_at=None, space=Node.WIKI).select_related("parent")
    mine = [n for n in nodes if _in_scope(n, area_ids) and not _root(n).owner_id]
    now = timezone.now()

    def top(days):
        rows = (PageView.objects.filter(at__gte=now - timedelta(days=days), node__deleted_at=None)
                .values("node").annotate(n=Count("id")).order_by("-n")[:60])
        by = {n.pk: n for n in mine}
        return [{"id": r["node"], "title": by[r["node"]].title, "views": r["n"]} for r in rows if r["node"] in by][:8]

    pages = [n for n in mine if n.kind == Node.PAGE]
    by_id = {n.pk: n for n in pages}
    recent = []
    for v in PageView.objects.filter(node__in=by_id).select_related("user").order_by("-at")[:200]:
        if all(r["id"] != v.node_id for r in recent):
            recent.append({"id": v.node_id, "title": by_id[v.node_id].title, "at": v.at,
                           "user": (v.user.get_username() if v.user else "anonym")})
        if len(recent) == 8:
            break
    members = TeamMember.objects.filter(team__in=teams).values("user").distinct().count() if (not admin or want) else User.objects.count()
    return Response({
        "teams": [{"id": t.id, "name": t.name} for t in (Team.objects.all() if admin else teams)],
        "counts": {"pages": len(pages), "faqs": sum(1 for n in pages if is_public(n)),
                   "files": sum(1 for n in mine if n.kind == Node.FILE), "members": members},
        "recent": recent, "top7": top(7), "top30": top(30)})


@api_view(["GET"])
def faq(request):
    return Response(faq_data(request.user))


def ticket_data():
    """The ticket system link for the help portal and the FAQ (None when no address is set): the only setting the public API hands out."""
    ts = FaqSettings.objects.filter(pk=1).first()
    return {"url": ts.ticket_url, "label": ts.ticket_label} if ts and ts.ticket_url else None


def valid_ticket_url(url):
    """http(s) address with a host and no blanks; {q} is replaced by the search term in the browser."""
    p = urlsplit(url)
    return p.scheme in ("http", "https") and bool(p.netloc) and not any(c.isspace() for c in url)


def faq_data(user):
    """Landing data of the public FAQ for a user: most read and newest pages, the categories (top folders) with their pages."""
    areas = [a for a in Node.objects.filter(parent=None, kind=Node.AREA, space=Node.WIKI, is_public=True, deleted_at=None)
             if can(user, READ, a)]
    pages = [p for p in Node.objects.filter(kind=Node.PAGE, deleted_at=None).select_related("parent")
             if _root(p).pk in {a.pk for a in areas} and can(user, READ, p)]
    counts = {c.node_id: c.total for c in PageCounter.objects.filter(node__in=pages)}
    top = sorted(pages, key=lambda p: (-counts.get(p.pk, 0), p.title))[:6]
    cats = []
    for a in areas:
        for f in a.children.filter(deleted_at=None).order_by("position", "title"):
            if f.kind == Node.FOLDER and can(user, READ, f):
                items = [p for p in pages if f.pk in {x.pk for x in [p, *p.ancestors()]}]
                cats.append({"id": f.id, "title": f.title, "pages": [{"id": p.id, "title": p.title} for p in items[:8]], "more": max(0, len(items) - 8)})
        direct = [p for p in pages if p.parent_id == a.pk]
        if direct:
            cats.append({"id": a.id, "title": a.title, "pages": [{"id": p.id, "title": p.title} for p in direct[:8]], "more": max(0, len(direct) - 8)})
    newest = sorted(pages, key=lambda p: p.updated_at, reverse=True)[:6]
    row = lambda p: {"id": p.id, "title": p.title, "views": counts.get(p.pk, 0), "category": p.parent.title if p.parent else ""}
    return {"ticket": ticket_data(), "top": [row(p) for p in top], "recent": [row(p) for p in newest], "categories": cats}


@api_view(["GET", "PUT"])
def faq_editors(request):
    """Admin: who may edit the public FAQ. PUT {users: [ids], teams: [ids]}; both empty = no restriction (rights as before)."""
    need_admin(request)
    if request.method == "PUT":
        d = request.data
        if "ticket_url" in d:
            url = str(d.get("ticket_url") or "").strip()
            if url and not valid_ticket_url(url):
                raise ValidationError({"ticket_url": "Bitte eine vollständige http://- oder https://-Adresse ohne Leerzeichen eintragen."})
            FaqSettings.objects.update_or_create(pk=1, defaults={"ticket_url": url[:500], "ticket_label": (str(d.get("ticket_label") or "").strip() or "Ticket erstellen")[:60]})
        users, teams = request.data.get("users") or [], request.data.get("teams") or []
        if not isinstance(users, list) or not isinstance(teams, list):
            raise ValidationError({"detail": "Listen erwartet."})
        if User.objects.filter(pk__in=users).count() != len(set(users)) or Team.objects.filter(pk__in=teams).count() != len(set(teams)):
            raise ValidationError({"detail": "Unbekannte Person oder unbekanntes Team."})
        with transaction.atomic():
            FaqEditor.objects.all().delete()
            FaqEditor.objects.bulk_create([FaqEditor(user_id=u) for u in set(users)] + [FaqEditor(team_id=t) for t in set(teams)])
        from . import audit
        audit.log(request, "team", None, what="FAQ-Redaktion geändert", users=sorted(set(users)), teams=sorted(set(teams)))
    rows = list(FaqEditor.objects.all())
    ts = FaqSettings.objects.filter(pk=1).first()
    return Response({"restricted": bool(rows), "ticket_url": ts.ticket_url if ts else "", "ticket_label": ts.ticket_label if ts else "Ticket erstellen",
                     "users": [e.user_id for e in rows if e.user_id and not e.team_id], "teams": [e.team_id for e in rows if e.team_id and not e.user_id],
                     "all_users": [{"id": u.id, "name": u.get_full_name() or u.username} for u in User.objects.filter(is_active=True).order_by("username")],
                     "all_teams": [{"id": t.id, "name": t.name} for t in Team.objects.all()]})
