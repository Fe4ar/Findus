"""Admin menu API: users, teams, rights per folder, trash, audit log, system. Admins do everything; team leaders see
and change only their own team (members' write right, trash, rights of the team's folders, the team's log)."""
import shutil
import uuid
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from . import audit, rights, teams
from .features import FEATURES
from .models import AuditLog, FileVersion, IntegrationSettings, Node, NodePermission, PageRevision, Team, TeamMember, UserSettings
from .permissions import WRITE, _chain, can, governing, is_admin, is_private, is_public
from .views import is_uuid, user_name

User = get_user_model()
DEFAULT_TRASH_DAYS = 40

AUDIT_CLEAR_PHRASE = "PROTOKOLL LÖSCHEN"


def need_login(request):
    if not request.user.is_authenticated:
        raise PermissionDenied("Bitte anmelden.")


def need_admin(request):
    if not is_admin(request.user):
        raise PermissionDenied("Nur für Administratoren.")


def led(user):
    """Teams the user leads."""
    return Team.objects.filter(members__user=user, members__is_leader=True) if user.is_authenticated else Team.objects.none()


def team_or_404(user, team_id, lead=False):
    """Admins: every team. Others: teams they belong to; with lead=True only those they lead."""
    team = Team.objects.filter(pk=team_id).first()
    if team and not is_admin(user):
        m = team.members.filter(user=user).first()
        if m is None or (lead and not m.is_leader):
            team = None
    if team is None:
        raise NotFound()
    return team


# --- users ----------------------------------------------------------------------------------------------------

PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no look-alikes (0/O, 1/l/I)


def generate_password(length=16):
    import secrets
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(length))


def user_data(u):
    return {"id": u.id, "username": u.username, "name": user_name(u), "first_name": u.first_name, "last_name": u.last_name,
            "email": u.email, "is_active": u.is_active, "is_superuser": u.is_superuser,
            "groups": [g.name for g in u.groups.all() if not g.name.startswith("Team ")],
            "teams": [{"id": m.team_id, "name": m.team.name, "leader": m.is_leader, "can_write": m.is_leader or m.can_write}
                      for m in u.team_memberships.all()],
            "can_download": getattr(getattr(u, "findus_settings", None), "can_download", True),
            "must_change_password": getattr(getattr(u, "findus_settings", None), "must_change_password", False),
            "last_login": u.last_login, "deleted_at": _deleted_at(u),
            "purge_at": (_deleted_at(u) + timedelta(days=IntegrationSettings.retention_days())) if _deleted_at(u) else None}


@api_view(["POST"])
def user_restore(request, user_id):
    """Inside the retention: the user AND their personal area come back together; the admin never sees the content."""
    need_admin(request)
    u = User.objects.filter(pk=user_id).first() or (_ for _ in ()).throw(NotFound())
    at = _deleted_at(u)
    if not at or at + timedelta(days=IntegrationSettings.retention_days()) <= timezone.now():
        raise NotFound()
    UserSettings.objects.filter(user=u).update(deleted_at=None)
    u.is_active = True
    u.save(update_fields=["is_active"])
    Node.objects.filter(owner=u).update(deleted_at=None)
    audit.log(request, "user", username=u.username, what="wiederhergestellt")
    return Response(user_data(User.objects.get(pk=u.pk)))


@api_view(["GET", "PUT"])
def retention(request):
    need_admin(request)
    if request.method == "PUT":
        days = request.data.get("user_retention_days")
        if not isinstance(days, int) or not 1 <= days <= 3650:
            raise ValidationError({"user_retention_days": "1 bis 3650 Tage."})
        IntegrationSettings.objects.update_or_create(pk=1, defaults={"user_retention_days": days})
        audit.log(request, "user", None, what=f"Aufbewahrungsfrist gelöschter Nutzer: {days} Tage")
    return Response({"user_retention_days": IntegrationSettings.retention_days()})


@api_view(["GET", "PUT"])
def idle_logout(request):
    """Admin: automatic sign-out after this many minutes of inactivity (0 = off)."""
    need_admin(request)
    if request.method == "PUT":
        minutes = request.data.get("minutes")
        if isinstance(minutes, bool) or not isinstance(minutes, int) or not 0 <= minutes <= 43200:
            raise ValidationError({"minutes": "0 (aus) bis 43200 Minuten (30 Tage)."})
        old = IntegrationSettings.idle_minutes()
        IntegrationSettings.objects.update_or_create(pk=1, defaults={"idle_logout_minutes": minutes})
        audit.log(request, "user", None, what="Automatische Abmeldung geändert", minuten=[old, minutes])
    return Response({"minutes": IntegrationSettings.idle_minutes()})


@api_view(["GET", "POST"])
def users(request):
    need_admin(request)
    if request.method == "POST":
        d = request.data
        name = str(d.get("username") or "").strip()
        if not name or User.objects.filter(username__iexact=name).exists():
            raise ValidationError({"username": "Benutzername fehlt oder ist vergeben."})
        generate = bool(d.get("generate_password"))
        password = generate_password() if generate else str(d.get("password") or "")
        if len(password) < 8:
            raise ValidationError({"password": "Mindestens 8 Zeichen."})
        u = User.objects.create_user(name, email=str(d.get("email") or ""), password=password,
                                     first_name=str(d.get("first_name") or "")[:150], last_name=str(d.get("last_name") or "")[:150])
        force = bool(d.get("must_change_password", generate))  # a generated password is meant to be replaced by default
        if force:
            UserSettings.objects.update_or_create(user=u, defaults={"must_change_password": True})
        audit.log(request, "user", username=name, what="angelegt", passwort="generiert" if generate else "gesetzt", wechsel_pflicht=force)
        out = user_data(User.objects.select_related("findus_settings").get(pk=u.pk))
        if generate:
            out["generated_password"] = password  # shown to the admin once, never stored in clear text
        return Response(out, status=201)
    qs = User.objects.prefetch_related("groups", "team_memberships__team").select_related("findus_settings").order_by("username")
    return Response({"users": [user_data(u) for u in qs],
                     "groups": [{"id": g.id, "name": g.name} for g in Group.objects.order_by("name") if not g.name.startswith("Team ")]})


def _deleted_at(u):
    return getattr(getattr(u, "findus_settings", None), "deleted_at", None)


@api_view(["PATCH", "DELETE"])
def user_edit(request, user_id):
    need_admin(request)
    u = User.objects.filter(pk=user_id).first() or (_ for _ in ()).throw(NotFound())
    if request.method == "DELETE":
        # Soft delete: inactive account, personal area hidden (and untouchable for everyone) until the retention is over.
        if u == request.user:
            raise ValidationError({"detail": "Das eigene Konto kann nicht gelöscht werden."})
        if _deleted_at(u):
            raise ValidationError({"detail": "Schon gelöscht."})
        now = timezone.now()
        UserSettings.objects.update_or_create(user=u, defaults={"deleted_at": now})
        u.is_active = False
        u.save(update_fields=["is_active"])
        Node.objects.filter(owner=u, deleted_at=None).update(deleted_at=now)
        audit.log(request, "user", username=u.username, what="gelöscht (Aufbewahrung %d Tage)" % IntegrationSettings.retention_days())
        return Response(user_data(User.objects.get(pk=u.pk)))
    if _deleted_at(u) and "is_active" in request.data:
        raise ValidationError({"is_active": "Gelöschte Nutzer werden über „Wiederherstellen“ zurückgeholt."})
    d, changed = request.data, {}
    for f in ("first_name", "last_name", "email"):
        if f in d:
            setattr(u, f, str(d[f])[:150])
            changed[f] = getattr(u, f)
    if "is_active" in d:
        if u == request.user and not d["is_active"]:
            raise ValidationError({"is_active": "Das eigene Konto kann nicht gesperrt werden."})
        u.is_active = bool(d["is_active"])
        changed["is_active"] = u.is_active
    if d.get("password"):
        if len(str(d["password"])) < 8:
            raise ValidationError({"password": "Mindestens 8 Zeichen."})
        u.set_password(d["password"])
        changed["password"] = "geändert"
    u.save()
    if "must_change_password" in d:  # only the flag; the password itself stays untouched
        UserSettings.objects.update_or_create(user=u, defaults={"must_change_password": bool(d["must_change_password"])})
        changed["wechsel_pflicht"] = bool(d["must_change_password"])
    if "can_download" in d:
        UserSettings.objects.update_or_create(user=u, defaults={"can_download": bool(d["can_download"])})
        changed["can_download"] = bool(d["can_download"])
    if "groups" in d:
        keep = list(u.groups.filter(name__startswith="Team "))
        wanted = list(Group.objects.filter(pk__in=d["groups"]).exclude(name__startswith="Team "))
        u.groups.set(keep + wanted)
        changed["groups"] = [g.name for g in wanted]
    audit.log(request, "user", username=u.username, **changed)
    u = User.objects.prefetch_related("groups", "team_memberships__team").select_related("findus_settings").get(pk=u.pk)
    return Response(user_data(u))


# --- teams ----------------------------------------------------------------------------------------------------

def team_data(team, viewer):
    admin = is_admin(viewer)
    leader = admin or team.members.filter(user=viewer, is_leader=True).exists()
    return {"id": team.id, "name": team.name, "area": team.area_id, "trash_days": team.trash_days, "share_by_members": team.share_by_members,
            "file_keep_versions": team.file_keep_versions, "file_keep_days": team.file_keep_days,
            "features": {k: k not in team.disabled_features for k in FEATURES},
            "can_manage": admin, "can_lead": leader,
            "members": [{"user": m.user_id, "username": m.user.username, "name": user_name(m.user),
                         "is_leader": m.is_leader, "can_write": m.is_leader or m.can_write}
                        for m in team.members.select_related("user").order_by("-is_leader", "user__username")]}


def set_members(team, rows, allow_empty=False):
    """Replace the members. A team may exist without members (admins add them later); with members it needs a leader."""
    clean = {}
    for r in rows:
        uid = r.get("user") if isinstance(r, dict) else None
        if not User.objects.filter(pk=uid).exists():
            raise ValidationError({"members": f"Unbekannter Benutzer {uid!r}."})
        leader = bool(r.get("is_leader"))
        clean[uid] = (leader, leader or bool(r.get("can_write")))
    if clean and not any(l for l, _ in clean.values()):
        raise ValidationError({"members": "Ein Team mit Mitgliedern braucht mindestens einen Teamleiter."})
    if not clean and not allow_empty:
        raise ValidationError({"members": "Nur Administratoren leeren ein Team ganz."})
    team.members.exclude(user_id__in=clean).delete()
    for uid, (leader, write) in clean.items():
        TeamMember.objects.update_or_create(team=team, user_id=uid, defaults={"is_leader": leader, "can_write": write})


@api_view(["GET", "POST"])
def team_list(request):
    need_login(request)
    if request.method == "POST":
        need_admin(request)
        name = str(request.data.get("name") or "").strip()[:100]
        if not name or Team.objects.filter(name__iexact=name).exists():
            raise ValidationError({"name": "Teamname fehlt oder ist vergeben."})
        with transaction.atomic():
            team = Team.objects.create(name=name)
            set_members(team, request.data.get("members") or [], allow_empty=True)
            teams.sync(team, request.user)
        audit.log(request, "team", team.area, team=team, what="angelegt", name=name)
        return Response(team_data(team, request.user), status=201)
    qs = Team.objects.all() if is_admin(request.user) else Team.objects.filter(members__user=request.user)
    return Response([team_data(t, request.user) for t in qs.distinct()])


@api_view(["PATCH", "DELETE"])
def team_edit(request, team_id):
    team = team_or_404(request.user, team_id, lead=True)
    admin = is_admin(request.user)
    if request.method == "DELETE":
        need_admin(request)
        audit.log(request, "team", team.area, team=team, what="gelöscht", name=team.name)
        teams.delete(team)
        return Response(status=204)
    d, changed = request.data, {}
    with transaction.atomic():
        if "trash_days" in d:
            days = d["trash_days"]
            if not isinstance(days, int) or not 1 <= days <= 3650:
                raise ValidationError({"trash_days": "1 bis 3650 Tage."})
            changed["trash_days"] = [team.trash_days, days]
            team.trash_days = days
        if "file_keep_versions" in d or "file_keep_days" in d:
            keep, age = d.get("file_keep_versions", team.file_keep_versions), d.get("file_keep_days", team.file_keep_days)
            if (keep is None) != (age is None):
                raise ValidationError({"file_keep_versions": "Anzahl und Alter nur zusammen setzen (beide leer = alles behalten)."})
            if keep is not None and not (isinstance(keep, int) and not isinstance(keep, bool) and 1 <= keep <= 1000):
                raise ValidationError({"file_keep_versions": "1 bis 1000 Versionen."})
            if age is not None and not (isinstance(age, int) and not isinstance(age, bool) and 1 <= age <= 3650):
                raise ValidationError({"file_keep_days": "1 bis 3650 Tage."})
            changed["dateiversionen"] = {"behalten": keep, "tage": age} if keep is not None else "alles behalten"
            team.file_keep_versions, team.file_keep_days = keep, age
        if "share_by_members" in d:
            if not isinstance(d["share_by_members"], bool):
                raise ValidationError({"share_by_members": "true oder false."})
            changed["share_by_members"] = [team.share_by_members, d["share_by_members"]]
            team.share_by_members = d["share_by_members"]
        if "features" in d:
            f = d["features"]
            if not isinstance(f, dict) or set(f) - set(FEATURES):
                raise ValidationError({"features": "Erlaubt sind " + ", ".join(FEATURES) + "."})
            if not admin:
                raise PermissionDenied("Funktionen schaltet nur ein Admin.")
            off = [k for k in FEATURES if not f.get(k, k not in team.disabled_features)]
            changed["features"] = {FEATURES[k]: k not in off for k in FEATURES}
            team.disabled_features = off
        if admin and "name" in d:
            name = str(d["name"]).strip()[:100]
            if not name or Team.objects.filter(name__iexact=name).exclude(pk=team.pk).exists():
                raise ValidationError({"name": "Teamname fehlt oder ist vergeben."})
            changed["name"] = [team.name, name]
            team.name = name
        if "members" in d:
            if admin:
                set_members(team, d["members"], allow_empty=True)
            else:
                # Leaders only change the write right of existing non-leader members.
                members = {m.user_id: m for m in team.members.all()}
                if {r.get("user") for r in d["members"] if isinstance(r, dict)} != set(members):
                    raise PermissionDenied("Mitglieder hinzufügen oder entfernen darf nur ein Admin.")
                for r in d["members"]:
                    m = members.get(r.get("user")) if isinstance(r, dict) else None
                    if m is None or m.is_leader != bool(r.get("is_leader")):
                        raise PermissionDenied("Mitglieder hinzufügen oder entfernen darf nur ein Admin.")
                    if not m.is_leader and m.can_write != bool(r.get("can_write")):
                        m.can_write = bool(r.get("can_write"))
                        m.save()
            changed["members"] = [(m.user.username, "Leiter" if m.is_leader else "schreiben" if m.can_write else "lesen")
                                  for m in team.members.select_related("user")]
        team.save()
        teams.sync(team, request.user)
    audit.log(request, "team", team.area, team=team, what="geändert", **changed)
    return Response(team_data(team, request.user))


# --- rights per folder -----------------------------------------------------------------------------------------

def _scope(user):
    """(is_admin, team ids the user leads) – leaders see only the areas of those teams; anyone else gets 403."""
    admin, ids = is_admin(user), set(led(user).values_list("id", flat=True))
    if not admin and not ids:
        raise PermissionDenied()
    return admin, ids


def _mode(request, body=None):
    """('faq', None) for the FAQ areas, ('team', Team) for one team's view, ('all', None) = every folder (admins)."""
    src = body if body is not None else request.query_params
    if str(src.get("faq") or "") in ("1", "true", "True"):
        need_admin(request)
        return "faq", None
    if src.get("team"):
        raise NotFound()  # the per-team folder matrix is gone: folders are shared with other teams (shares.py)
    need_admin(request)
    return "all", None


def _folders(user, mode="all", team=None):
    """Wiki areas and folders in tree order with depth. The FAQ (public areas) is its own list; team view: a leader gets
    the team's own area, an admin every non-public area."""
    admin, ids = _scope(user)
    nodes = list(Node.objects.filter(space=Node.WIKI, kind__in=Node.CONTAINERS, deleted_at=None).select_related("parent"))
    by_parent = {}
    for n in nodes:
        by_parent.setdefault(n.parent_id, []).append(n)
    for lst in by_parent.values():
        lst.sort(key=lambda n: (n.position, n.title.lower()))
    out = []

    def keep(root):
        if root.owner_id:
            return False  # personal areas are not part of any rights table
        if mode == "faq":
            return root.is_public
        if mode == "team":
            return not root.is_public and (admin or root.id == team.area_id)
        return admin

    def walk(parent, depth, path):
        for n in by_parent.get(parent, []):
            if parent is None and not keep(n):
                continue
            out.append((n, depth, path + [n.title]))
            walk(n.id, depth + 1, path + [n.title])
    walk(None, 0, [])
    return out


@api_view(["GET", "POST"])
def folders(request):
    if request.method == "POST":
        need_admin(request)
        title = str(request.data.get("title") or "").strip()[:255]
        if not title:
            raise ValidationError({"title": "Name fehlt."})
        last = Node.objects.filter(parent=None, space=Node.WIKI, deleted_at=None).order_by("-position").first()
        node = Node.objects.create(kind=Node.AREA, space=Node.WIKI, title=title, status=Node.PUBLISHED,
                                   position=(last.position + 1) if last else 0, created_by=request.user, updated_by=request.user)
        audit.log(request, "create", node, kind="area")
        return Response({"id": node.id}, status=201)
    mode, team = _mode(request)
    ctx = rights.Context()
    cols = [p for p in ctx.principals if mode == "all" or (mode == "team" and p["team"] == team.id)]
    rows = []
    for n, depth, path in _folders(request.user, mode, team):
        chain = [n, *reversed(n.ancestors())]
        n._findus_chain = chain
        root = chain[-1]
        row = {"id": n.id, "title": n.title, "path": " / ".join(path), "depth": depth, "kind": n.kind,
               "inherit": n.inherit_rights if n.parent_id else None, "public": is_public(n),
               # "Ohne Anmeldung" exists only inside the FAQ, and its root stays public.
               "public_editable": bool(n.parent_id) and root.is_public, "vis": ctx.visibility(n),
               "cells": {p["key"]: dict(zip(("see", "edit"), ctx.cell(n, p))) for p in cols}}
        rows.append(row)
    return Response({"principals": [{"key": p["key"], "label": p["label"], "team": p["team"]} for p in cols],
                     "rows": rows, "can_create": is_admin(request.user)})


@api_view(["PUT"])
def folders_save(request):
    mode, team = _mode(request, request.data)
    allowed = {n.id: n for n, _, _ in _folders(request.user, mode, team)}
    ctx = rights.Context()
    cols = {p["key"]: p for p in ctx.principals if mode == "all" or (mode == "team" and p["team"] == team.id)}
    changed = {}
    with transaction.atomic():
        for r in request.data.get("rows") or []:
            n = allowed.get(uuid.UUID(str(r.get("id")))) if isinstance(r, dict) and is_uuid(r.get("id")) else None
            if n is None:
                raise ValidationError({"rows": "Unbekannter Ordner."})
            n.__dict__.pop("_findus_chain", None)
            root = n if n.parent_id is None else [*reversed(n.ancestors())][-1]
            inherit = bool(r.get("inherit")) if n.parent_id else False
            public = bool(r.get("public")) and not inherit and bool(n.parent_id)
            if public and not root.is_public:
                raise ValidationError({"rows": "„Ohne Anmeldung“ gibt es nur im FAQ."})
            before = {"inherit": n.inherit_rights, "public": n.is_public}
            if n.parent_id and not inherit and n.inherit_rights:
                # Leaving "erben": first copy what the folder effectively grants now, so other teams keep their access.
                chain = _chain_of(n)
                eff_public = chain[governing(chain)].is_public
                for p in ctx.principals:
                    see, edit = ctx.cell(n, p)
                    rights.apply_cell(n, p, see, edit, ctx)
                n.is_public = eff_public
            if n.parent_id:
                n.inherit_rights = inherit
                n.is_public = False if inherit else (public if mode == "faq" else n.is_public)
            n.save(update_fields=["inherit_rights", "is_public"])
            if inherit:
                for p in ctx.principals:
                    NodePermission.objects.filter(node=n, group_id__in={p["see"], p["edit"]}).delete()
                    for gid in (p["see"], p["edit"]):
                        ctx.rows[n.pk].pop(gid, None)
            else:
                cells = r.get("cells") or {}
                for key, p in cols.items():
                    if key not in cells:
                        continue  # a principal that was not part of this view keeps its rows
                    c = cells[key] or {}
                    see = bool(c.get("see")) or (n.is_public and mode == "faq")
                    rights.apply_cell(n, p, see, bool(c.get("edit")), ctx)
            changed[n.title] = {"vorher": before, "nachher": {"inherit": n.inherit_rights, "public": n.is_public}}
    audit.log(request, "permissions", None, ordner=changed)
    return Response({"ok": True})


def _chain_of(n):
    n.__dict__.pop("_findus_chain", None)
    return _chain(n)


# --- trash ----------------------------------------------------------------------------------------------------

def _root_of(node):
    while node.parent_id:
        node = node.parent
    return node


def _team_for(node):
    return Team.objects.filter(area_id=_root_of(node).pk).first()


def _days(node):
    t = _team_for(node)
    return t.trash_days if t else DEFAULT_TRASH_DAYS


def _trash_roots():
    """Deleted nodes whose parent is alive (or none): what the user deleted; their children share the timestamp."""
    return Node.objects.exclude(deleted_at=None).filter(Q(parent=None) | Q(parent__deleted_at=None)).select_related("parent", "updated_by")


def trash_role(user, node):
    """'admin', 'leader', 'writer' or None for the user on a deleted node."""
    if is_private(node):
        return "writer" if _chain(node)[-1].owner_id == user.pk else None  # personal trash: the owner only, no admin
    if is_admin(user):
        return "admin"
    team = _team_for(node)
    if team is None:
        return "writer" if node.parent_id and can(user, WRITE, node.parent) else None
    m = team.members.filter(user=user).first()
    if m is None:
        return None
    return "leader" if m.is_leader else "writer" if m.can_write else None


@api_view(["GET"])
def trash(request):
    """Deleted items the user may restore: admins all (filter ?team=<id>|none), others those of their teams."""
    need_login(request)
    admin = is_admin(request.user)
    items = []
    for n in _trash_roots().order_by("-deleted_at"):
        role = trash_role(request.user, n)
        team = _team_for(n)
        want = request.query_params.get("team")
        if role is None or (want == "none" and team) or (want and want != "none" and (not team or str(team.id) != want)):
            continue
        items.append({"id": n.id, "title": n.title, "kind": n.kind, "team": team.name if team else None, "team_id": team.id if team else None,
                      "path": " / ".join(a.title for a in n.ancestors()), "deleted_at": n.deleted_at,
                      "deleted_by": user_name(n.updated_by), "purge_at": n.deleted_at + timedelta(days=_days(n)),
                      "can_purge": role in ("admin", "leader"), "can_restore": True})
    return Response({"items": items, "is_admin": admin})


def _trash_node(request, node_id):
    need_login(request)
    n = _trash_roots().filter(pk=node_id).first()
    role = trash_role(request.user, n) if n else None
    if role is None:
        raise NotFound()
    return n, role


@api_view(["POST"])
def trash_restore(request, node_id):
    n, _ = _trash_node(request, node_id)
    stamp = n.deleted_at
    with transaction.atomic():
        ids, todo = [], [n]
        while todo:
            x = todo.pop()
            ids.append(x.pk)
            todo.extend(x.children.filter(deleted_at=stamp))
        Node.objects.filter(pk__in=ids).update(deleted_at=None)
    n.deleted_at = None
    audit.log(request, "restore", n, aus="Papierkorb")
    return Response({"id": n.id})


def purge(node):
    """Delete a trashed node and everything below it for good, including the stored files."""
    ids, todo = [], [node]
    while todo:
        x = todo.pop()
        ids.append(x.pk)
        todo.extend(x.children.all())
    node.delete()  # the stored files go with their last FileVersion (post_delete in models.py; shared files stay while others use them)


@api_view(["DELETE"])
def trash_purge(request, node_id):
    n, role = _trash_node(request, node_id)
    if role == "writer":
        raise PermissionDenied("Endgültig löschen dürfen nur Teamleiter und Admins.")
    audit.log(request, "delete", n, endgueltig=True)
    purge(n)
    return Response(status=204)


# --- audit log ------------------------------------------------------------------------------------------------

@api_view(["GET", "DELETE"])
def audit_log(request):
    if request.method == "DELETE":
        return clear_audit(request)
    admin, ids = _scope(request.user)
    if not admin and not ids:
        raise PermissionDenied()
    q = AuditLog.objects.select_related("team")
    if not admin:
        q = q.filter(team_id__in=ids)
    p = request.query_params
    if p.get("team"):
        q = q.filter(team_id=None) if p["team"] == "none" else q.filter(team_id=p["team"])
    if p.get("user"):
        q = q.filter(username__icontains=p["user"])
    if p.get("action"):
        q = q.filter(action=p["action"])
    if p.get("q"):
        q = q.filter(Q(node_title__icontains=p["q"]) | Q(username__icontains=p["q"]))
    if parse_date(p.get("from") or ""):
        q = q.filter(created_at__date__gte=parse_date(p["from"]))
    if parse_date(p.get("to") or ""):
        q = q.filter(created_at__date__lte=parse_date(p["to"]))
    page = max(int(p.get("page") or 1) if (p.get("page") or "1").isdigit() else 1, 1)
    size = 50
    total = q.count()
    rows = q[(page - 1) * size: page * size]
    return Response({"total": total, "page": page, "size": size, "can_clear": admin,
                     "teams": [{"id": t.id, "name": t.name} for t in (Team.objects.all() if admin else led(request.user))],
                     "actions": [a for a, _ in AuditLog.ACTIONS],
                     "items": [{"id": a.id, "at": a.created_at, "username": a.username, "action": a.action, "node": a.node_id,
                                "title": a.node_title, "team": a.team.name if a.team else None, "details": a.details, "ip": a.ip}
                               for a in rows]})


def clear_audit(request):
    """Admin: delete the whole log; only one entry remains, saying who did it. Needs {"confirm": "PROTOKOLL LÖSCHEN"} in the body."""
    need_admin(request)
    if request.data.get("confirm") not in (AUDIT_CLEAR_PHRASE, "DELETE LOG"):  # the English interface asks for the English phrase
        raise ValidationError({"detail": f"Zur Bestätigung „{AUDIT_CLEAR_PHRASE}“ senden."})
    with transaction.atomic():
        count, _ = AuditLog.objects.all().delete()
        AuditLog.objects.create(user=request.user, username=request.user.get_username(), action="audit", node_title="Gesamtes Protokoll gelöscht",
                                details={"entries": count}, ip=audit.client_ip(request))
    return Response({"deleted": count})


# --- system ---------------------------------------------------------------------------------------------------

@api_view(["GET"])
def system(request):
    need_admin(request)
    import django
    import platform
    with connection.cursor() as cur:
        cur.execute("SELECT pg_database_size(current_database())")
        db = cur.fetchone()[0]
    media = shutil.disk_usage(settings.MEDIA_ROOT) if settings.MEDIA_ROOT else None
    return Response({
        "counts": {"users": User.objects.count(), "teams": Team.objects.count(),
                   "nodes": Node.objects.filter(deleted_at=None).count(), "trashed": _trash_roots().count(),
                   "files": FileVersion.objects.count(), "revisions": PageRevision.objects.count(),
                   "audit": AuditLog.objects.count()},
        "db_bytes": db, "files_bytes": sum(FileVersion.objects.values_list("size", flat=True)),
        "disk": {"total": media.total, "free": media.free} if media else None,
        "django": django.get_version(), "python": platform.python_version(),
        "now": timezone.now(), "default_trash_days": DEFAULT_TRASH_DAYS})
