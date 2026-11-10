import re

from django.db import migrations, models

IMG = re.compile(r'src="[^"]*?/media-dl/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')
DOC = re.compile(r'data-docfile="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"')


def hide_inline_files(apps, schema_editor):
    """Files that a page's current content shows as an image or embeds as a document and that lie in the page's own folder
    were put there by the editor (it uploads into the page's folder): mark them as attachments. Anything else is left alone."""
    Node, Revision, Version = apps.get_model("core", "Node"), apps.get_model("core", "PageRevision"), apps.get_model("core", "FileVersion")
    for page in Node.objects.filter(kind="page", deleted_at=None):
        rev = Revision.objects.filter(node=page).order_by("-created_at", "-id").first()
        if rev is None or not rev.content_html:
            continue
        ids = {v.node_id for v in Version.objects.filter(pk__in=IMG.findall(rev.content_html))} | set(DOC.findall(rev.content_html))
        if ids:
            Node.objects.filter(pk__in=ids, kind="file", parent_id=page.parent_id, hidden=False).update(hidden=True)


class Migration(migrations.Migration):
    dependencies = [("core", "0026_must_change_password")]
    operations = [
        migrations.AddField(model_name="node", name="hidden", field=models.BooleanField(default=False)),
        migrations.RunPython(hide_inline_files, migrations.RunPython.noop),
    ]
