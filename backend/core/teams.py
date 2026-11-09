"""Teams: each team has a knowledge area and two groups that carry the members' NodePermission rights."""
import re

from django.contrib.auth.models import Group
from django.db import transaction

from .models import Node, NodePermission


def group_name(team_name, suffix):
    """"Team IT · Lesen", not "Team Team IT · Lesen" when the team's own name already starts with Team."""
    return f"{team_name if re.match(r'team\b', team_name, re.I) else f'Team {team_name}'} · {suffix}"


def _group(team, attr, suffix):
    g = getattr(team, attr)
    name = group_name(team.name, suffix)
    if g is None:
        g = Group.objects.create(name=name)
        setattr(team, attr, g)
    elif g.name != name:
        g.name = name
        g.save(update_fields=["name"])
    return g


@transaction.atomic
def sync(team, user=None):
    """Make area, groups, area rights and group membership match team and members (idempotent)."""
    if team.area is None:
        team.area = Node.objects.create(kind=Node.AREA, space=Node.WIKI, title=team.name, status=Node.PUBLISHED,
                                        never_public=True, created_by=user, updated_by=user)
    elif team.area.title != team.name:
        team.area.title = team.name
        team.area.save(update_fields=["title"])
    read, write = _group(team, "read_group", "Lesen"), _group(team, "write_group", "Schreiben")
    team.save()
    NodePermission.objects.update_or_create(node=team.area, group=read, defaults=dict(
        can_read=True, can_write=False, can_publish=False, can_manage=False))
    NodePermission.objects.update_or_create(node=team.area, group=write, defaults=dict(
        can_read=True, can_write=True, can_publish=True, can_manage=False))
    read.user_set.clear()
    write.user_set.clear()
    for m in team.members.select_related("user"):
        read.user_set.add(m.user)
        if m.is_leader or m.can_write:
            write.user_set.add(m.user)


def delete(team):
    """The area and its pages stay (admins still see them); only the team and its groups go."""
    with transaction.atomic():
        groups = [g for g in (team.read_group, team.write_group) if g]
        team.delete()
        for g in groups:
            g.delete()
