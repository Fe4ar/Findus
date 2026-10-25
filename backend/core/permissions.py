"""Single permission gate used by every view.

shortcut: test phase grants everything to any logged-in user and nothing to anonymous users;
upgrade to NodePermission with inherited group rights before real use.
"""

READ, WRITE, PUBLISH, MANAGE = "read", "write", "publish", "manage"
ACTIONS = (READ, WRITE, PUBLISH, MANAGE)


def can(user, action, node=None):
    assert action in ACTIONS, action
    if node is not None and node.deleted_at is not None:
        return False
    return bool(user and user.is_authenticated and user.is_active)


def effective(user, node):
    return {a: can(user, a, node) for a in ACTIONS}
