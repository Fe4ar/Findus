import uuid

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models

User = settings.AUTH_USER_MODEL


class Node(models.Model):
    AREA, FOLDER, PAGE, FILE, MAP, LINK = "area", "folder", "page", "file", "map", "link"
    KINDS = [(AREA, "Bereich"), (FOLDER, "Ordner"), (PAGE, "Seite"), (FILE, "Datei"), (MAP, "Karte"), (LINK, "Verknüpfung")]
    CONTAINERS = (AREA, FOLDER)
    # Kinds whose content is versioned in PageRevision.content.
    REVISIONED = (PAGE, MAP)
    # Separate trees: the wiki and the network maps of the "Karte" tab.
    WIKI, KARTE = "wiki", "karte"
    SPACE_KINDS = {WIKI: (AREA, FOLDER, PAGE, FILE), KARTE: (AREA, FOLDER, MAP, LINK)}
    DRAFT, PUBLISHED = "draft", "published"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.CASCADE, related_name="children")
    kind = models.CharField(max_length=10, choices=KINDS)
    space = models.CharField(max_length=10, choices=[(WIKI, "Wiki"), (KARTE, "Karten")], default=WIKI)
    # Only on links: the referenced node (a .drawio file in the wiki), so plans exist once and show in both trees.
    target = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="links")
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    tags = ArrayField(models.CharField(max_length=50), default=list, blank=True)
    position = models.IntegerField(default=0)
    status = models.CharField(max_length=10, choices=[(DRAFT, "Entwurf"), (PUBLISHED, "Veröffentlicht")], default=PUBLISHED)
    # Only meaningful on areas: anonymous users may read its published content (see permissions.py).
    is_public = models.BooleanField(default=False)
    # Folders may override the rights of their parent: with inherit_rights=False the node's own rows (and its own
    # is_public) govern it and everything below, and the rows above are ignored (see permissions.py).
    inherit_rights = models.BooleanField(default=True)
    # Only on areas: "never without login" – is_public can no longer be set anywhere in this area (internal areas, team areas).
    never_public = models.BooleanField(default=False)
    # Files that came in inline (pasted image, embedded document): attachments of a page, kept out of tree and folder listings.
    hidden = models.BooleanField(default=False)
    # Only on root areas: the personal area of one user ("Mein Bereich"). Only this user may use it, nobody else, admins
    # included (permissions.can); PROTECT, so deleting the user can never turn it into an ordinary area.
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name="private_areas")
    version = models.IntegerField(default=1)
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    updated_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True)
    # Extracted plain text of the current page revision or file version (see search.py).
    search_text = models.TextField(blank=True, default="")
    # Maintained by a database trigger from title and search_text (migration 0003).
    search_vector = SearchVectorField(null=True, editable=False)

    class Meta:
        ordering = ["position", "title"]
        indexes = [models.Index(fields=["parent", "deleted_at"]), GinIndex(fields=["search_vector"], name="core_node_search_gin")]

    def __str__(self):
        return self.title

    def ancestors(self):
        """Root first, excluding self."""
        chain, node = [], self.parent
        while node is not None:
            chain.append(node)
            node = node.parent
        return chain[::-1]


class PageRevision(models.Model):
    node = models.ForeignKey(Node, on_delete=models.CASCADE, related_name="revisions")
    content = models.JSONField(default=dict)
    content_html = models.TextField(blank=True)
    user = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    comment = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]


def _upload_path(instance, filename):
    return f"files/{instance.id.hex[:2]}/{instance.id.hex}"


class FileVersion(models.Model):
    UPLOAD, ONLYOFFICE, RESTORE, COLLABORA = "upload", "onlyoffice", "restore", "collabora"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    node = models.ForeignKey(Node, on_delete=models.CASCADE, related_name="file_versions")
    file = models.FileField(upload_to=_upload_path)
    original_name = models.CharField(max_length=255)
    mime = models.CharField(max_length=127)
    size = models.BigIntegerField()
    sha256 = models.CharField(max_length=64)
    user = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    comment = models.CharField(max_length=255, blank=True)
    source = models.CharField(max_length=12, default=UPLOAD,
                              choices=[(UPLOAD, "Upload"), (ONLYOFFICE, "OnlyOffice"), (RESTORE, "Wiederhergestellt"),
                                       (COLLABORA, "Collabora")])
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class UserShare(models.Model):
    """A folder of someone's private area shared with one other user (look, or edit as well). Teams get private folders through
    NodePermission rows of their groups, like any shared folder; see core/shares.py and permissions.shared_actions."""
    node = models.ForeignKey("Node", on_delete=models.CASCADE, related_name="user_shares")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="+")
    can_write = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["node", "user"], name="core_usershare_unique")]


class NodePermission(models.Model):
    """Rights of a group on a node and everything below it; node=None grants them everywhere."""
    node = models.ForeignKey(Node, null=True, blank=True, on_delete=models.CASCADE, related_name="permissions")
    group = models.ForeignKey("auth.Group", on_delete=models.CASCADE, related_name="node_permissions")
    can_read = models.BooleanField(default=True)
    can_write = models.BooleanField(default=False)
    can_publish = models.BooleanField(default=False)
    can_manage = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["node", "group"], name="core_nodepermission_node_group"),
            models.UniqueConstraint(fields=["group"], condition=models.Q(node=None), name="core_nodepermission_global_group"),
        ]

    def __str__(self):
        flags = "".join(c for c, on in zip("RWPM", (self.can_read, self.can_write, self.can_publish, self.can_manage)) if on)
        return f"{self.group} auf {self.node or 'alles'}: {flags or '-'}"


class AuditLog(models.Model):
    ACTIONS = [(a, a) for a in ("create", "update", "delete", "move", "restore", "publish", "permissions",
                                "login", "login_failed", "login_locked", "logout", "team", "user")]

    user = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    # Kept as text so entries survive user deletion and record the name tried in failed logins.
    username = models.CharField(max_length=150, blank=True)
    action = models.CharField(max_length=20, choices=ACTIONS)
    node = models.ForeignKey(Node, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    node_title = models.CharField(max_length=255, blank=True)
    details = models.JSONField(default=dict, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    # The team whose area the entry concerns, so leaders see their team's log.
    team = models.ForeignKey("Team", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]


class LoginThrottle(models.Model):
    """Failed-login counter for one key ("user:<name>" or "ip:<address>"), see core/throttle.py."""
    key = models.CharField(max_length=200, unique=True)
    fails = models.PositiveIntegerField(default=0)
    last_fail = models.DateTimeField()
    locked_until = models.DateTimeField(null=True, blank=True)


class UserSettings(models.Model):
    """Per-user preferences that follow the account across devices."""
    THEMES = [("auto", "System"), ("light", "Hell"), ("dark", "Dunkel")]

    user = models.OneToOneField(User, on_delete=models.CASCADE, primary_key=True, related_name="findus_settings")
    theme = models.CharField(max_length=5, choices=THEMES, default="auto")
    # Set by admins: file download, PDF/Markdown export and OnlyOffice download/print (see permissions.can_download).
    can_download = models.BooleanField(default=True)
    # Set when an admin deleted the user: the account is inactive and its personal area soft-deleted until the
    # retention (IntegrationSettings.user_retention_days) has passed; then purge_trash removes both for good.
    deleted_at = models.DateTimeField(null=True, blank=True)
    # Only the start admin of a fresh installation (core/management/commands/ensure_start_admin.py): until the password
    # is changed the account can do nothing else (core/middleware.py).
    must_change_password = models.BooleanField(default=False)


OPT_IN_FEATURES = ("tasks", "network")


def default_disabled_features():
    return list(OPT_IN_FEATURES)


class Team(models.Model):
    """A team owns a knowledge area. Its members get rights on the area through two groups, so the normal
    NodePermission checks apply: "Team X · Lesen" (read) and "Team X · Schreiben" (read, write, publish)."""
    name = models.CharField(max_length=100, unique=True)
    area = models.OneToOneField(Node, null=True, on_delete=models.SET_NULL, related_name="team")
    read_group = models.OneToOneField("auth.Group", null=True, on_delete=models.SET_NULL, related_name="+")
    write_group = models.OneToOneField("auth.Group", null=True, on_delete=models.SET_NULL, related_name="+")
    # Deleted content stays this many days in the team's trash; leaders may change it.
    trash_days = models.PositiveIntegerField(default=40)
    # Who may share the team's folders with other teams: only the leaders (default) or every member (see shares.py).
    share_by_members = models.BooleanField(default=False)
    # Functions switched off for this team (keys of features.FEATURES). Aufgaben and Netzwerk are off until an admin
    # releases them (OPT_IN), everything else is on until an admin switches it off.
    disabled_features = ArrayField(models.CharField(max_length=20), default=default_disabled_features, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class TeamMember(models.Model):
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="members")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="team_memberships")
    is_leader = models.BooleanField(default=False)
    # Leaders always write; for everyone else this is the right per member.
    can_write = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["team", "user"], name="core_teammember_unique")]


class ShortcutCategory(models.Model):
    """Dashboard category. Owner: a user (private), a team (set by its leader) or nobody (global, set by admins)."""
    user = models.ForeignKey(User, null=True, blank=True, on_delete=models.CASCADE, related_name="shortcut_categories")
    team = models.ForeignKey(Team, null=True, blank=True, on_delete=models.CASCADE, related_name="shortcut_categories")
    name = models.CharField(max_length=100)
    position = models.IntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]


class Shortcut(models.Model):
    category = models.ForeignKey(ShortcutCategory, on_delete=models.CASCADE, related_name="shortcuts")
    name = models.CharField(max_length=100)
    url = models.CharField(max_length=500)
    # An emoji, or "favicon" to show the site's own icon.
    icon = models.CharField(max_length=40, default="🔗")
    description = models.CharField(max_length=300, blank=True)
    position = models.IntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]


class PageView(models.Model):
    """One view of a page (who, when); raw rows are purged after 90 days, PageCounter keeps the totals."""
    node = models.ForeignKey(Node, on_delete=models.CASCADE, related_name="views")
    user = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")  # null = anonymous
    at = models.DateTimeField(auto_now_add=True, db_index=True)


class PageCounter(models.Model):
    node = models.OneToOneField(Node, on_delete=models.CASCADE, related_name="counter")
    total = models.PositiveIntegerField(default=0)
    last_viewed = models.DateTimeField(null=True)


class FaqEditor(models.Model):
    """Who may edit the public FAQ: single people (team empty), whole teams (user empty). No rows = rights as before."""
    team = models.ForeignKey(Team, null=True, blank=True, on_delete=models.CASCADE, related_name="faq_editors")
    user = models.ForeignKey(User, null=True, blank=True, on_delete=models.CASCADE, related_name="+")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["team", "user"], name="core_faqeditor_unique")]


class FaqSettings(models.Model):
    """Single row (pk=1): where "Ticket erstellen" on the public FAQ leads; empty URL = no button."""
    ticket_url = models.CharField(max_length=500, blank=True)  # may contain {q}, replaced by the search term in the browser
    ticket_label = models.CharField(max_length=60, default="Ticket erstellen")


class WopiLock(models.Model):
    """WOPI lock of a file while Collabora has it open for editing; expires unless refreshed."""
    node = models.OneToOneField(Node, on_delete=models.CASCADE, related_name="wopi_lock")
    lock = models.CharField(max_length=1024)
    expires = models.DateTimeField()
class TaskSection(models.Model):
    """A named section of one user's task board (Findus only; Todoist does not know it)."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="task_sections")
    title = models.CharField(max_length=100)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]


class Task(models.Model):
    """A to-do item of one user. Others may have created it for them; private ones are hidden from teammates."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="tasks")
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    title = models.CharField(max_length=200)
    notes = models.TextField(blank=True)
    due = models.DateField(null=True, blank=True)
    private = models.BooleanField(default=False)
    section = models.ForeignKey(TaskSection, null=True, blank=True, on_delete=models.SET_NULL, related_name="tasks")  # null = "Ohne Bereich"
    position = models.PositiveIntegerField(default=0)  # order inside the section; ties fall back to the old order (due, newest)
    done_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)  # the later change wins when Findus and Todoist disagree


class TaskEvent(models.Model):
    """Notes in a task's history: what the Todoist sync did to it (taken over, conflicts, unlinked)."""
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="events")
    at = models.DateTimeField(auto_now_add=True)
    text = models.CharField(max_length=300)

    class Meta:
        ordering = ["-at", "-id"]


class IntegrationSettings(models.Model):
    """Single row (pk=1): global switches of the administration for the optional integrations."""
    todoist_allowed = models.BooleanField(default=True)
    # How long a deleted user and their personal area are kept before they are removed for good.
    user_retention_days = models.PositiveIntegerField(default=30)

    @classmethod
    def retention_days(cls):
        row = cls.objects.filter(pk=1).first()
        return row.user_retention_days if row else 30

    @classmethod
    def allowed(cls):
        row = cls.objects.filter(pk=1).first()
        return row.todoist_allowed if row else True


class TodoistLink(models.Model):
    """A user's connection to Todoist. The API token is stored encrypted (core/todoist.py) and never returned by the API."""
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="todoist")
    token_enc = models.TextField()
    connected_at = models.DateTimeField()
    project_id = models.CharField(max_length=40)
    project_name = models.CharField(max_length=200)
    sync_token = models.TextField(blank=True)  # Todoist's incremental sync token; empty = read everything once
    include_private = models.BooleanField(default=False)  # also mirror tasks marked private in Findus
    import_new = models.BooleanField(default=True)  # tasks created in the Todoist project become Findus tasks
    last_sync_at = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=300, blank=True)
    last_error_at = models.DateTimeField(null=True, blank=True)
    syncing = models.BooleanField(default=False)  # a run is going on (guards against two runs at once)
    sync_started_at = models.DateTimeField(null=True, blank=True)


class TodoistItem(models.Model):
    """Links one Findus task to one Todoist task of the project; state = values at the last sync (basis for the merge).
    Without a task (it was deleted in Findus) the row only stops the Todoist task from being imported again."""
    link = models.ForeignKey(TodoistLink, on_delete=models.CASCADE, related_name="items")
    todoist_id = models.CharField(max_length=40)
    task = models.OneToOneField(Task, null=True, blank=True, on_delete=models.SET_NULL, related_name="todoist_item")
    state = models.JSONField(default=dict)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["link", "todoist_id"], name="core_todoistitem_unique")]
