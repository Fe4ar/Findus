"""Single permission gate used by every view.

Rules (Bauanleitung Phase 1):
- Superusers may do everything.
- Logged-in users get the union of the NodePermission rows of their groups on the node, on any ancestor and the
  global rows (node=None). Drafts are readable only with write or publish rights.
- Anonymous users may only read published nodes below a public area (is_public), never anything else.
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


def granted(user, node):
    """Actions the user's groups grant on node (inherited and global included), drafts not considered."""
    grants = _grants(user)
    out = set(grants.get(None, ()))
    for n in ([] if node is None else _chain(node)):
        out |= grants.get(n.pk, set())
    return out


def can(user, action, node=None):
    assert action in ACTIONS, action
    if node is not None and any(n.deleted_at is not None for n in _chain(node)):
        return False
    if user is None or not user.is_authenticated:
        return action == READ and node is not None and is_public(node)
    if not user.is_active:
        return False
    if user.is_superuser:
        return True
    actions = granted(user, node)
    if action == READ and node is not None and node.status == node.DRAFT:
        return bool(actions & {WRITE, PUBLISH})
    return action in actions


def is_public(node):
    chain = _chain(node)
    return chain[-1].is_public and all(n.status == n.PUBLISHED for n in chain)


def effective(user, node):
    return {a: can(user, a, node) for a in ACTIONS}

