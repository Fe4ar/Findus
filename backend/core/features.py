"""Functions per team: an admin switches Wiki, FAQ, Aufgaben, Netzwerk and Export on or off for each team.

A user has a function when at least one of their teams has it on. Admins always have all of them. Users without a team
only get the FAQ ("Alle Anwender", plus download of what they may read there), unless an admin gave their groups rights
outside every team (the old global or per-folder rights): those keep all functions until they join a team. Teams store only what is OFF. Aufgaben and
Netzwerk (OPT_IN) are off for every new team until an admin releases them; only an admin switches functions, leaders do not.
Without release the function is invisible and every route answers 403 (also for the legacy rights above). The checks sit in permissions.can() and
can_download(), so every view obeys them, not only the navigation.
"""
from .models import OPT_IN_FEATURES
from .permissions import _chain, _grants, is_admin

FEATURES = {"wiki": "Wiki", "faq": "FAQ", "tasks": "Aufgaben", "network": "Netzwerk", "export": "Export"}


def enabled(user):
    """Set of function keys the user may use (cached on the user object for the request)."""
    cached = getattr(user, "_findus_features", None)
    if cached is None:
        cached = set(FEATURES)
        if user.is_authenticated and not is_admin(user):
            teams = [m.team for m in user.team_memberships.select_related("team")]
            if teams:
                cached = set().union(*[set(FEATURES) - set(t.disabled_features) for t in teams])
            elif not _grants(user):
                cached = {"faq", "export"}
            else:
                cached -= set(OPT_IN_FEATURES)
        user._findus_features = cached
    return cached


def feature_of(node):
    """Function a node belongs to: public areas are the FAQ, the Karte space is Netzwerk, everything else Wiki."""
    root = _chain(node)[-1]
    return "faq" if root.is_public else "network" if root.space == root.KARTE else "wiki"
