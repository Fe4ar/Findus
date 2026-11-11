import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("core", "0033_shortcut_folders")]

    operations = [
        migrations.AddField(
            model_name="shortcutfolder",
            name="parent",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE, related_name="children", to="core.shortcutfolder"),
        ),
    ]
