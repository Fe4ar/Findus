"""Sharing a team's folder with other teams (replaces the per-folder rights matrix of the team dialog).

Only the leader of the team that owns the area (or an admin) shares a folder; the target team's read group (look) or write
group (edit as well) gets a NodePermission row on that folder, so everything below it follows the normal rights. The
"share root" itself (rename-free) can be moved or deleted only from the owning side, so nobody walks off with it.
"""
from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from . import audit, rights
from .admin_api import led
from .models import Node, NodePermission, Team, TeamMember
from .permissions import WRITE, _chain, can, is_admin, is_private
from .views import node_or_404


def owner_team(node):
    return Team.objects.filter(area_id=_chain(node)[-1].pk).first()


def can_share(user, node):
    """Folders of a team area: the leaders of that team and admins; every member when the team's setting says so."""
    if node.kind != Node.FOLDER or node.space != Node.WIKI or is_private(node) or not user.is_authenticated:
        return False
    team = owner_team(node)
    if team is None:
        return False
    if is_admin(user) or led(user).filter(pk=team.pk).exists():
        return True
    return team.share_by_members and TeamMember.objects.filter(team=team, user=user).exists() and can(user, "read", node)


def may_grant_edit(user, node):
    """Leaders and admins hand out edit rights; a member can only pass on what they could do themselves."""
    team = owner_team(node)
    return is_admin(user) or led(user).filter(pk=team.pk).exists() or can(user, WRITE, node)


def shared_with(node, ctx=None):
    return (ctx or rights.Context()).shared_with(node)


def guard_root(user, node):
    """Delete and move of a shared folder only from the owning side (people who may write in the owning area)."""
    if node.kind == Node.FOLDER and shared_with(node) and not can(user, WRITE, _chain(node)[-1]):
        raise PermissionDenied("Dieser Ordner ist von einem anderen Team freigegeben; nur das besitzende Team verschiebt oder löscht ihn.")


def guard_receiver(user, node):
    """A team that received a folder neither shares it on nor changes sharing or rights in it (owning team and admins only)."""
    if not is_admin(user) and share_root(user, node):
        raise PermissionDenied("Dieser Ordner ist von einem anderen Team freigegeben; Weitergabe und Rechte steuert nur das besitzende Team.")


@api_view(["GET", "PUT"])
def node_shares(request, node_id):
    node = node_or_404(request.user, node_id)
    team = owner_team(node)
    if node.kind != Node.FOLDER or node.space != Node.WIKI or team is None:
        if request.method == "PUT":
            raise ValidationError({"detail": "Freigeben kann man nur Ordner eines Team-Bereichs."})
        return Response({"shared": [], "can_manage": False, "teams": [], "owner": None})
    ctx = rights.Context()
    if request.method == "PUT":
        guard_receiver(request.user, node)
        if not can_share(request.user, node):
            raise PermissionDenied("Ordner geben nur die Teamleitung oder, wenn das Team es erlaubt, seine Mitglieder frei.")
        wanted = {}
        for t in request.data.get("teams") or []:
            if not isinstance(t, dict) or not isinstance(t.get("team"), int):
                raise ValidationError({"teams": "Teams als {team, edit}."})
            if t["team"] == team.pk:
                raise ValidationError({"teams": "Das eigene Team hat den Ordner schon."})
            wanted[t["team"]] = bool(t.get("edit"))
        principals = {p["team"]: p for p in ctx.principals if p["team"]}
        if set(wanted) - set(principals):
            raise ValidationError({"teams": "Unbekanntes Team."})
        before_rows = {s["team"]: s["edit"] for s in ctx.shared_with(node)}
        if any(wanted[t] and not before_rows.get(t) for t in wanted) and not may_grant_edit(request.user, node):
            raise PermissionDenied("„Darf bearbeiten“ vergeben nur Mitglieder mit Schreibrecht auf diesen Ordner und die Teamleitung.")
        before = [s["name"] for s in ctx.shared_with(node)]
        with transaction.atomic():
            for tid, p in principals.items():
                if tid != team.pk:
                    rights.apply_cell(node, p, tid in wanted, wanted.get(tid, False), ctx)
        node.__dict__.pop("_findus_chain", None)
        after = rights.Context().shared_with(node)
        audit.log(request, "permissions", node, freigabe={"vorher": before, "nachher": [s["name"] for s in after]})
        return Response({"shared": after, "can_manage": True, "owner": team.name,
                         "teams": [{"id": t.pk, "name": t.name} for t in Team.objects.exclude(pk=team.pk).order_by("name")]})
    manage = can_share(request.user, node)
    return Response({"shared": ctx.shared_with(node), "can_manage": manage, "owner": team.name,
                     "teams": [{"id": t.pk, "name": t.name} for t in Team.objects.exclude(pk=team.pk).order_by("name")] if manage else []})


@api_view(["GET"])
def incoming(request):
    """Folders other teams shared with the user's teams (the "Von anderen Teams" part of the sidebar)."""
    if not request.user.is_authenticated:
        raise PermissionDenied()
    mine = {m.team_id: m.team for m in TeamMember.objects.filter(user=request.user).select_related("team")}
    groups = {g: t for t in mine.values() for g in (t.read_group_id, t.write_group_id) if g}
    out = {}
    for p in NodePermission.objects.filter(group_id__in=list(groups), node__kind=Node.FOLDER, node__deleted_at=None).select_related("node"):
        n = p.node
        owner = owner_team(n)
        if owner is None or owner.pk in mine or not can(request.user, "read", n):
            continue
        row = out.setdefault(n.pk, {"id": n.id, "title": n.title, "from_team": owner.name, "edit": False, "to": groups[p.group_id].name})
        row["edit"] = row["edit"] or (p.can_write and can(request.user, WRITE, n))
    return Response(sorted(out.values(), key=lambda r: (r["from_team"].lower(), r["title"].lower())))


def share_root(user, node):
    """(shared folder, receiving team id) when node lies in a folder another team shared with one of the user's teams, else None."""
    if not user.is_authenticated or node.space != Node.WIKI:
        return None
    mine = {m.team_id: m.team for m in TeamMember.objects.filter(user=user).select_related("team")}
    owner = owner_team(node)
    if not mine or (owner and owner.pk in mine):
        return None
    groups = {g: t for t in mine.values() for g in (t.read_group_id, t.write_group_id) if g}
    chain = _chain(node)  # node first, area last
    rows = {p.node_id: p for p in NodePermission.objects.filter(node_id__in=[n.pk for n in chain], group_id__in=list(groups))}
    for n in chain:  # the nearest shared folder above (or being) the node
        if n.pk in rows:
            return n, groups[rows[n.pk].group_id].pk
    return None
