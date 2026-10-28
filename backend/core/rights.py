"""Rights per folder: who sees and edits which area/folder, and the plain-text "effective" visibility.

A principal is a column of the rights page: a team (see = its read group, edit = its write group) or a plain group such
as IT-Team or Leser (see = can_read, edit = can_write). Groups that manage everything (Admin) are not columns: they
always see and edit everything. The same Context feeds the rights page and the sidebar badges.
"""
from collections import defaultdict

from django.contrib.auth.models import Group
from django.db.models import Q

from .models import Node, NodePermission, Team
from .permissions import MANAGE, _chain, governing, is_public


class Context:
    def __init__(self):
        teams = list(Team.objects.select_related("area"))
        team_groups = {g for t in teams for g in (t.read_group_id, t.write_group_id)}
        manage_groups = set(NodePermission.objects.filter(node=None, can_manage=True).values_list("group_id", flat=True))
        self.principals = [{"key": f"t{t.id}", "label": t.name, "team": t.id, "see": t.read_group_id, "edit": t.write_group_id}
                           for t in teams if t.read_group_id and t.write_group_id]
        self.principals += [{"key": f"g{g.id}", "label": g.name, "team": None, "see": g.id, "edit": g.id}
                            for g in Group.objects.order_by("name") if g.id not in team_groups and g.id not in manage_groups]
        self.team_of_area = {t.area_id: t.name for t in teams if t.area_id}
        self.rows = defaultdict(dict)  # node id -> group id -> row
        for p in NodePermission.objects.exclude(node=None):
            self.rows[p.node_id][p.group_id] = p

    def cell(self, node, principal):
        """(see, edit) the principal gets on node from the rows of the governing chain (own rows when not inheriting)."""
        chain = _chain(node)
        see = edit = False
        for n in chain[:governing(chain) + 1]:
            r = self.rows[n.pk].get(principal["see"])
            see = see or bool(r and r.can_read)
            r = self.rows[n.pk].get(principal["edit"])
            edit = edit or bool(r and r.can_write)
        return see or edit, edit

    def visibility(self, node):
        chain = _chain(node)
        inherited = governing(chain) > 0
        suffix = " (geerbt)" if inherited else ""
        if is_public(node):
            return {"kind": "public", "badge": "Ohne Anmeldung", "text": "Alle (auch ohne Anmeldung)" + suffix}
        seeing = [p["label"] for p in self.principals if self.cell(node, p)[0]]
        if not seeing:
            return {"kind": "admin", "badge": "Nur Admin", "text": "Nur Admin" + suffix}
        names = ", ".join(seeing)
        return {"kind": "team", "badge": f"Nur {names}", "text": f"Nur {names} und Admin" + suffix}


def apply_cell(node, principal, see, edit, ctx):
    """Write the see/edit choice of one principal as NodePermission rows on node (edit implies see)."""
    see = see or edit
    for gid, want in ((principal["see"], see), (principal["edit"], edit)):
        row = ctx.rows[node.pk].get(gid)
        if principal["see"] == principal["edit"]:  # plain group: one row carries both
            if see:
                row = row or NodePermission(node=node, group_id=gid)
                row.can_read, row.can_write = True, edit
                row.can_publish = edit and (row.can_publish or True)
                row.save()
                ctx.rows[node.pk][gid] = row
            elif row:
                row.delete()
                ctx.rows[node.pk].pop(gid, None)
            return
        if want:
            row = row or NodePermission(node=node, group_id=gid)
            row.can_read = True
            row.can_write = row.can_publish = gid == principal["edit"]
            row.save()
            ctx.rows[node.pk][gid] = row
        elif row:
            row.delete()
            ctx.rows[node.pk].pop(gid, None)
