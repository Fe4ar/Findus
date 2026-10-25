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
    SPACE_KINDS = {WIKI: (AREA, FOLDER, PAGE, FILE), KARTE: (FOLDER, MAP, LINK)}
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
    # Only meaningful on areas; anonymous read access comes in a later phase.
    is_public = models.BooleanField(default=False)
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
    UPLOAD, ONLYOFFICE, RESTORE = "upload", "onlyoffice", "restore"

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
                              choices=[(UPLOAD, "Upload"), (ONLYOFFICE, "OnlyOffice"), (RESTORE, "Wiederhergestellt")])
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
