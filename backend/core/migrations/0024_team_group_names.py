import re

from django.db import migrations


def rename(apps, schema_editor):
    """Groups of teams whose name already starts with "Team" were called "Team Team IT · Lesen"."""
    Team, Group = apps.get_model("core", "Team"), apps.get_model("auth", "Group")
    for t in Team.objects.all():
        label = t.name if re.match(r"team\b", t.name, re.I) else f"Team {t.name}"
        for g, suffix in ((t.read_group, "Lesen"), (t.write_group, "Schreiben")):
            new = f"{label} · {suffix}"
            if g is not None and g.name != new and not Group.objects.filter(name=new).exists():
                g.name = new
                g.save(update_fields=["name"])


class Migration(migrations.Migration):
    dependencies = [("core", "0023_private_area")]
    operations = [migrations.RunPython(rename, migrations.RunPython.noop)]
