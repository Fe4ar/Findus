"""Sharing folders: a team's folder with other teams, and a folder of someone's private area with teams or single users.

Team folder: only the leader of the team that owns the area (or an admin) shares; the target team's read group (look) or write group
(edit as well) gets a NodePermission row on that folder, so everything below it follows the normal rights.
Private folder: only its owner shares, with teams (same NodePermission rows) or single users (UserShare rows); see
permissions.shared_actions. Rights to manage are never handed out.

The "share root" itself can be moved or deleted only from the owning side, and whoever received a folder neither shares it on nor
changes sharing or rights in it, so nobody walks off with it.
"""
from django.contrib.auth import get_user_model
from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from . import audit, rights
from .admin_api import led
from .models import Node, NodePermission, Team, TeamMember, UserShare
from .permissions import WRITE, _chain, can, is_admin, is_private
from .views import node_or_404, user_name

User = get_user_model()
MAX_USER_SHARES = 50


def owner_team(node):
    return Team.objects.filter(area_id=_chain(node)[-1].pk).first()


def private_owner_id(node):
    return _chain(node)[-1].owner_id


def can_share(user, node):
    """Team folders: the leaders of that team and admins; every member when the team's setting says so. Private folders: the owner."""
    if node.kind != Node.FOLDER or node.space != Node.WIKI or not user.is_authenticated:
        return False
    if is_private(node):
        return user.pk == private_owner_id(node)
    team = owner_team(node)
    if team is None:
        return False
    if is_admin(user) or led(user).filter(pk=team.pk).exists():
        return True
    return team.share_by_members and TeamMember.objects.filter(team=team, user=user).exists() and can(user, "read", node)


def may_grant_edit(user, node):
    """Leaders and admins hand out edit rights, a private folder's owner too; a member can only pass on what they could do themselves."""
    if is_private(node):
        return user.pk == private_owner_id(node)
    team = owner_team(node)
    return is_admin(user) or led(user).filter(pk=team.pk).exists() or can(user, WRITE, node)


def shared_with(node, ctx=None):
    return (ctx or rights.Context()).shared_with(node)


def user_shares_of(node):
    return [{"user": s.user_id, "name": user_name(s.user), "edit": s.can_write} for s in node.user_shares.select_related("user").order_by("user__username")]


def guard_root(user, node):
    """Delete and move of a shared folder only from the owning side (people who may write in the owning area)."""
    if node.kind == Node.FOLDER and (shared_with(node) or node.user_shares.exists()) and not can(user, WRITE, _chain(node)[-1]):
        raise PermissionDenied("Dieser Ordner ist freigegeben; nur der Besitzer (das besitzende Team) verschiebt oder löscht ihn.")


def guard_no_delete(user, node):
    """Whoever received content (a folder shared with them or their team, and everything in it) never deletes it, whatever rights they have:
    only the owner does. The receiver can "Entfernen" the share instead (leave_share)."""
    if share_root(user, node):
        raise PermissionDenied("Freigegebene Inhalte darf nur der Besitzer löschen. Mit „Entfernen“ löst du die Freigabe für dich.")


@api_view(["POST"])
def leave_share(request, node_id):
    """The receiver's counterpart of "Freigabe zurücknehmen": dissolve the share of this folder for the user (single-user share) and for the
    teams the user leads (team share). The content stays with the owner untouched."""
    node = node_or_404(request.user, node_id)
    root = share_root(request.user, node)
    if root is None or root[0].pk != node.pk:
        raise ValidationError({"detail": "Nur ein freigegebener Ordner selbst kann entfernt werden."})
    removed = UserShare.objects.filter(node=node, user=request.user).delete()[0]
    for m in TeamMember.objects.filter(user=request.user, is_leader=True).select_related("team"):
        groups = [g for g in (m.team.read_group_id, m.team.write_group_id) if g]
        removed += NodePermission.objects.filter(node=node, group_id__in=groups).delete()[0]
    if not removed:
        raise PermissionDenied("Die Freigabe an ein Team lösen nur die Teamleiter („Entfernen“).")
    node.__dict__.pop("_findus_chain", None)
    request.user.__dict__.pop("_findus_user_shares", None)
    audit.log(request, "permissions", None, freigabe={"entfernt": True, "von_empfaenger": True})
    return Response({"removed": removed})


def guard_receiver(user, node):
    """Whoever received a folder neither shares it on nor changes sharing or rights in it (owner, owning team and admins only)."""
    if not (is_admin(user) and not is_private(node)) and share_root(user, node):
        raise PermissionDenied("Dieser Ordner ist von jemand anderem freigegeben; Weitergabe und Rechte steuert nur der Besitzer (das besitzende Team).")


def _team_choices(exclude=None):
    return [{"id": t.pk, "name": t.name} for t in Team.objects.exclude(pk=exclude).order_by("name")]


def _parse_users(raw, owner_id):
    wanted = {}
    for u in raw or []:
        if not isinstance(u, dict) or not isinstance(u.get("user"), int):
            raise ValidationError({"users": "Benutzer als {user, edit}."})
        if u["user"] == owner_id:
            raise ValidationError({"users": "Den eigenen Ordner musst du dir nicht freigeben."})
        wanted[u["user"]] = bool(u.get("edit"))
    if len(wanted) > MAX_USER_SHARES:
        raise ValidationError({"users": f"Höchstens {MAX_USER_SHARES} Benutzer je Ordner."})
    found = set(User.objects.filter(pk__in=list(wanted), is_active=True).exclude(findus_settings__deleted_at__isnull=False).values_list("pk", flat=True))
    if set(wanted) - found:
        raise ValidationError({"users": "Unbekannter oder gesperrter Benutzer."})
    return wanted


@api_view(["GET", "PUT"])
def node_shares(request, node_id):
    node = node_or_404(request.user, node_id)
    private = is_private(node)
    team = None if private else owner_team(node)
    if node.kind != Node.FOLDER or node.space != Node.WIKI or (not private and team is None):
        if request.method == "PUT":
            raise ValidationError({"detail": "Freigeben kann man nur Ordner eines Team-Bereichs oder des eigenen privaten Bereichs."})
        return Response({"shared": [], "users": [], "can_manage": False, "teams": [], "owner": None, "private": private})
    ctx = rights.Context()
    owner_label = user_name(_chain(node)[-1].owner) + " (privat)" if private else team.name
    own_id = team.pk if team else None
    if request.method == "PUT":
        guard_receiver(request.user, node)
        if not can_share(request.user, node):
            raise PermissionDenied("Den privaten Ordner gibt nur sein Besitzer frei." if private else
                                   "Ordner geben nur die Teamleitung oder, wenn das Team es erlaubt, seine Mitglieder frei.")
        wanted = {}
        for t in request.data.get("teams") or []:
            if not isinstance(t, dict) or not isinstance(t.get("team"), int):
                raise ValidationError({"teams": "Teams als {team, edit}."})
            if t["team"] == own_id:
                raise ValidationError({"teams": "Das eigene Team hat den Ordner schon."})
            wanted[t["team"]] = bool(t.get("edit"))
        principals = {p["team"]: p for p in ctx.principals if p["team"]}
        if set(wanted) - set(principals):
            raise ValidationError({"teams": "Unbekanntes Team."})
        wanted_users = _parse_users(request.data.get("users"), private_owner_id(node)) if private else {}
        before_rows = {s["team"]: s["edit"] for s in ctx.shared_with(node)}
        before_users = {s["user"]: s["edit"] for s in user_shares_of(node)} if private else {}
        if (any(wanted[t] and not before_rows.get(t) for t in wanted) or any(wanted_users[u] and not before_users.get(u) for u in wanted_users)) \
                and not may_grant_edit(request.user, node):
            raise PermissionDenied("„Darf bearbeiten“ vergeben nur Mitglieder mit Schreibrecht auf diesen Ordner und die Teamleitung.")
        before = [s["name"] for s in ctx.shared_with(node)]
        with transaction.atomic():
            for tid, p in principals.items():
                if tid != own_id:
                    rights.apply_cell(node, p, tid in wanted, wanted.get(tid, False), ctx)
            if private:
                node.user_shares.exclude(user_id__in=list(wanted_users)).delete()
                for uid, edit in wanted_users.items():
                    UserShare.objects.update_or_create(node=node, user_id=uid, defaults={"can_write": edit})
        node.__dict__.pop("_findus_chain", None)
        request.user.__dict__.pop("_findus_user_shares", None)
        after = rights.Context().shared_with(node)
        # Private folders: no title in the log (admins read it), only that and how many.
        audit.log(request, "permissions", None if private else node,
                  freigabe=({"privat": True, "teams": len(after), "benutzer": len(wanted_users)} if private
                            else {"vorher": before, "nachher": [s["name"] for s in after]}))
        return Response({"shared": after, "users": user_shares_of(node) if private else [], "can_manage": True, "owner": owner_label,
                         "teams": _team_choices(own_id), "private": private})
    manage = can_share(request.user, node)
    if private and not manage:  # a recipient of a private folder learns nothing about the other recipients
        return Response({"shared": [], "users": [], "can_manage": False, "teams": [], "owner": owner_label, "private": True})
    return Response({"shared": ctx.shared_with(node), "users": user_shares_of(node) if private else [], "can_manage": manage,
                     "owner": owner_label, "teams": _team_choices(own_id) if manage else [], "private": private})


@api_view(["GET"])
def people(request):
    """Find users to share a private folder with: at least two letters of the name, active users only, ten at most."""
    if not request.user.is_authenticated:
        raise PermissionDenied()
    q = str(request.query_params.get("q") or "").strip()
    if len(q) < 2:
        return Response([])
    from django.db.models import Q
    qs = (User.objects.filter(is_active=True).exclude(pk=request.user.pk).exclude(findus_settings__deleted_at__isnull=False)
          .filter(Q(username__icontains=q) | Q(first_name__icontains=q) | Q(last_name__icontains=q)).order_by("first_name", "username")[:10])
    return Response([{"id": u.pk, "name": user_name(u), "username": u.get_username()} for u in qs])


@api_view(["GET"])
def incoming(request):
    """Folders shared with the user's teams or with the user alone: "Von anderen Teams" in a team's sidebar, "Für mich freigegeben" under Privat."""
    if not request.user.is_authenticated:
        raise PermissionDenied()
    user = request.user
    mine = {m.team_id: m.team for m in TeamMember.objects.filter(user=user).select_related("team")}
    groups = {g: t for t in mine.values() for g in (t.read_group_id, t.write_group_id) if g}
    out = {}
    for p in NodePermission.objects.filter(group_id__in=list(groups), node__kind=Node.FOLDER, node__deleted_at=None).select_related("node"):
        n = p.node
        root = _chain(n)[-1]
        owner = owner_team(n)
        # The owner of a private folder sees it under its team too (marked "Du"), so they can check where they shared it.
        if (owner and owner.pk in mine) or (owner is None and root.owner_id is None) or not can(user, "read", n):
            continue
        label = ("Du" if root.owner_id == user.pk else user_name(root.owner)) + " (privat)" if root.owner_id else owner.name
        row = out.setdefault(n.pk, {"id": n.id, "title": n.title, "from_team": label, "edit": False, "to": groups[p.group_id].name, "to_user": False, "can_leave": False})
        row["edit"] = row["edit"] or (p.can_write and can(user, WRITE, n))
        row["can_leave"] = row["can_leave"] or TeamMember.objects.filter(user=user, team=groups[p.group_id], is_leader=True).exists()
    for s in UserShare.objects.filter(user=user, node__deleted_at=None).select_related("node"):
        n = s.node
        if n.kind == Node.FOLDER and can(user, "read", n):
            out[n.pk] = {"id": n.id, "title": n.title, "from_team": user_name(_chain(n)[-1].owner) + " (privat)", "edit": s.can_write and can(user, WRITE, n),
                         "to": "Du", "to_user": True, "can_leave": True}
    return Response(sorted(out.values(), key=lambda r: (r["from_team"].lower(), r["title"].lower())))


def share_root(user, node):
    """(shared folder, receiving team id or None for a user share) when node lies in a folder shared with one of the user's teams or
    with the user, else None. The owner of a private area and the owning team of a team area receive nothing from themselves."""
    if not user.is_authenticated or node.space != Node.WIKI:
        return None
    chain = _chain(node)  # node first, area last
    root = chain[-1]
    if root.owner_id == user.pk:
        return None
    mine = {m.team_id: m.team for m in TeamMember.objects.filter(user=user).select_related("team")}
    owner = owner_team(node)
    if owner and owner.pk in mine:
        return None
    groups = {g: t for t in mine.values() for g in (t.read_group_id, t.write_group_id) if g}
    ids = [n.pk for n in chain[:-1]]
    rows = {p.node_id: p for p in NodePermission.objects.filter(node_id__in=ids, group_id__in=list(groups))} if groups else {}
    users = set(UserShare.objects.filter(node_id__in=ids, user=user).values_list("node_id", flat=True))
    for n in chain[:-1]:  # the nearest shared folder above (or being) the node
        if n.pk in users:
            return n, None
        if n.pk in rows:
            return n, groups[rows[n.pk].group_id].pk
    return None
