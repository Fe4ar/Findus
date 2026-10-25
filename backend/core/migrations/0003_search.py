import django.contrib.postgres.indexes
import django.contrib.postgres.search
from django.db import migrations, models

TRIGGER = """
CREATE FUNCTION core_node_search_vector() RETURNS trigger AS $$
BEGIN
    NEW.search_vector := setweight(to_tsvector('german', coalesce(NEW.title, '')), 'A')
                      || setweight(to_tsvector('german', coalesce(NEW.search_text, '')), 'B');
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER core_node_search_vector BEFORE INSERT OR UPDATE OF title, search_text ON core_node
    FOR EACH ROW EXECUTE FUNCTION core_node_search_vector();
"""
DROP = "DROP TRIGGER core_node_search_vector ON core_node; DROP FUNCTION core_node_search_vector();"


def backfill(apps, schema_editor):
    from core.search import file_text, revision_text
    Node = apps.get_model("core", "Node")
    for node in Node.objects.filter(kind__in=["page", "map", "file"]):
        text = ""
        if node.kind in ("page", "map"):
            rev = node.revisions.order_by("-created_at", "-id").first()
            text = revision_text(node.kind, rev.content, rev.content_html) if rev else ""
        else:
            fv = node.file_versions.order_by("-created_at").first()
            if fv:
                with fv.file.open("rb") as fh:
                    text = file_text(fv.original_name, fh)
        Node.objects.filter(pk=node.pk).update(search_text=text)
    # Fires the trigger for nodes without text, so their titles become searchable too.
    Node.objects.update(title=models.F("title"))


class Migration(migrations.Migration):
    dependencies = [("core", "0002_maps")]

    operations = [
        migrations.AddField("node", "search_text", models.TextField(blank=True, default="")),
        migrations.AddField("node", "search_vector",
                            django.contrib.postgres.search.SearchVectorField(editable=False, null=True)),
        migrations.AddIndex("node", django.contrib.postgres.indexes.GinIndex(fields=["search_vector"],
                                                                              name="core_node_search_gin")),
        migrations.RunSQL(TRIGGER, DROP),
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
