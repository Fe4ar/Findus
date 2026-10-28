from django.db import migrations

LEGACY = ("IT-Team", "Leser")


def drop_empty(apps, schema_editor):
    """Teams replaced the global IT-Team/Leser groups; remove them (and their rights rows) unless someone is still a member."""
    Group = apps.get_model("auth", "Group")
    NodePermission = apps.get_model("core", "NodePermission")
    for g in Group.objects.filter(name__in=LEGACY):
        if g.user_set.exists():
            print(f"  kept group {g.name!r}: it still has members")
            continue
        NodePermission.objects.filter(group=g).delete()
        g.delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0014_faq_settings"),
    ]

    operations = [migrations.RunPython(drop_empty, migrations.RunPython.noop)]
