from django.db import migrations


def copy_global_rights(apps, schema_editor):
    """Global group rights used to reach every node; they now only answer node=None questions (create areas, dashboard).
    To keep today's access, each existing area gets a copy of the global rows of groups that do not manage everything,
    and areas that are not public become "never without login"."""
    Node, NodePermission = apps.get_model("core", "Node"), apps.get_model("core", "NodePermission")
    glob = NodePermission.objects.filter(node=None, can_manage=False)
    for area in Node.objects.filter(parent=None, kind="area"):
        for g in glob:
            NodePermission.objects.get_or_create(node=area, group_id=g.group_id, defaults=dict(
                can_read=g.can_read, can_write=g.can_write, can_publish=g.can_publish))
        if not area.is_public:
            area.never_public = True
            area.save(update_fields=["never_public"])


class Migration(migrations.Migration):
    dependencies = [("core", "0008_teams_rights")]
    operations = [migrations.RunPython(copy_global_rights, migrations.RunPython.noop)]
