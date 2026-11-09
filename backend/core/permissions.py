"""Single permission gate used by every view.

Rules (Bauanleitung Phase 1, extended in v0.6):
- Superusers may do everything.
- Logged-in users get the union of the NodePermission rows of their groups on the node and its ancestors, up to the
  nearest node with inherit_rights=False (that node and the ones below it govern; rows above it are ignored).
  Global rows (node=None) answer node=None questions (creating areas, reading the dashboard); they reach nodes only
  for groups that manage everything (Admin). Drafts are readable only with write or publish rights.
- Anyone, logged in or not, may read published nodes whose governing node is public (is_public) and whose area is not
  never_public.
- node=None asks for a global right, e.g. creating areas or reading the dashboard.
"""
READ, WRITE, PUBLISH, MANAGE = "read", "write", "publish", "manage"
ACTIONS = (READ, WRITE, PUBLISH, MANAGE)
FLAGS = {READ: "can_read", WRITE: "can_write", PUBLISH: "can_publish", MANAGE: "can_manage"}


def _grants(user):
    """{node id or None: set of actions} for the user's groups, cached on the user object for the request."""
    cache = getattr(user, "_findus_grants", None)
    if cache is None:
        from .models import NodePermission
        cache = {}
        for p in NodePermission.objects.filter(group__user=user).values("node_id", *FLAGS.values()):
            cache.setdefault(p["node_id"], set()).update(a for a, f in FLAGS.items() if p[f])
        user._findus_grants = cache
    return cache


def _chain(node):
    """[node, parent, …, root]; cached on the node because views ask several actions per node."""
    chain = getattr(node, "_findus_chain", None)
    if chain is None:
        chain = [node, *reversed(node.ancestors())]
        node._findus_chain = chain
    return chain


def governing(chain):
    """Index in chain (node first) of the node whose own rights apply: the nearest one that does not inherit."""
    for i, n in enumerate(chain):
        if not n.inherit_rights or n.parent_id is None:
            return i
    return len(chain) - 1


def is_private(node):
    """True inside someone's personal area (see Node.owner)."""
    return _chain(node)[-1].owner_id is not None


def is_admin(user):
    """Superuser or member of a group that manages everything (the Admin group)."""
    return bool(user and user.is_authenticated and user.is_active
                and (user.is_superuser or MANAGE in _grants(user).get(None, ())))


def granted(user, node):
    """Actions the user's groups grant on node (inherited included), drafts not considered."""
    grants = _grants(user)
    glob = grants.get(None, set())
    if node is None:
        return set(glob)
    chain = _chain(node)
    out = set(glob) if MANAGE in glob else set()
    for n in chain[:governing(chain) + 1]:
        out |= grants.get(n.pk, set())
    return out


def can(user, action, node=None):
    assert action in ACTIONS, action
    if node is not None and any(n.deleted_at is not None for n in _chain(node)):
        return False
    if node is not None and _chain(node)[-1].owner_id is not None:
        # Personal area: only its owner, with every right, before any admin or group rule can apply.
        return bool(user and user.is_authenticated and user.is_active and user.pk == _chain(node)[-1].owner_id)
    if user is None or not user.is_authenticated:
        return action == READ and node is not None and is_public(node)
    if not user.is_active:
        return False
    if user.is_superuser:
        return True
    if node is not None:
        from .features import enabled, feature_of
        if feature_of(node) not in enabled(user):
            return False  # the user's teams have this function (Wiki, FAQ, Netzwerk) switched off
    if action == READ and node is not None and is_public(node):
        return True
    actions = granted(user, node)
    if node is not None and _chain(node)[-1].is_public and _faq_named(user):
        actions = actions | {WRITE, PUBLISH}  # being named in the FAQ editors is itself the right to edit and publish there
    if action != READ and node is not None and _chain(node)[-1].is_public and not _faq_editor(user):
        return False  # the public FAQ is edited only by the people the admin named (when any are named)
    if action == READ and node is not None and node.status == node.DRAFT:
        return bool(actions & {WRITE, PUBLISH})
    return action in actions


def _faq_named(user):
    """True if FAQ editors are configured and the user is named (person, or member of a named team)."""
    from django.db.models import Q
    from .models import FaqEditor
    return FaqEditor.objects.filter(Q(user=user) | Q(user=None, team__members__user=user)).exists()


def _faq_editor(user):
    """True if no FAQ editors are configured, or the user is one of them (a whole team or named member)."""
    flag = getattr(user, "_findus_faq_editor", None)
    if flag is None:
        from django.db.models import Q
        from .models import FaqEditor
        if not FaqEditor.objects.exists():
            flag = True
        else:
            flag = FaqEditor.objects.filter(
                Q(user=user) | Q(user=None, team__members__user=user)).exists() or is_admin(user)
        user._findus_faq_editor = flag
    return flag


def can_download(user):
    """Download/export right set by admins per user. Superusers always; anonymous visitors keep what public areas allow."""
    if user is None or not user.is_authenticated:
        return True
    if user.is_superuser or is_admin(user):
        return True
    from .features import enabled
    return "export" in enabled(user) and getattr(getattr(user, "findus_settings", None), "can_download", True)


def is_public(node):
    chain = _chain(node)
    return (chain[governing(chain)].is_public and not chain[-1].never_public
            and all(n.status == n.PUBLISHED for n in chain))


def effective(user, node):
    return {a: can(user, a, node) for a in ACTIONS}
