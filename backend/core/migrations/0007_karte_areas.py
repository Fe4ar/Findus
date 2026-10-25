from django.db import migrations

AREA_TITLE = "Heimnetz"


def into_area(apps, schema_editor):
    """Areas above the folders in the network tree: existing top-level maps, folders and links move into "Heimnetz"."""
    Node = apps.get_model("core", "Node")
    top = Node.objects.filter(space="karte", parent=None).exclude(kind="area")
    if not top.exists():
        return
    area = Node.objects.create(space="karte", kind="area", title=AREA_TITLE, position=0, status="published")
    top.exclude(pk=area.pk).update(parent=area)


def out_of_area(apps, schema_editor):
    Node = apps.get_model("core", "Node")
    for area in Node.objects.filter(space="karte", kind="area", title=AREA_TITLE, parent=None):
        Node.objects.filter(parent=area).update(parent=None)
        area.delete()


class Migration(migrations.Migration):
    dependencies = [("core", "0006_user_settings")]
    operations = [migrations.RunPython(into_area, out_of_area)]
