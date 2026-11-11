import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("core", "0032_user_language")]

    operations = [
        migrations.CreateModel(
            name="ShortcutFolder",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=100)),
                ("icon", models.CharField(default="📁", max_length=40)),
                ("position", models.IntegerField(default=0)),
                ("category", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="folders", to="core.shortcutcategory")),
            ],
            options={"ordering": ["position", "id"]},
        ),
        migrations.AddField(
            model_name="shortcut",
            name="folder",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="shortcuts", to="core.shortcutfolder"),
        ),
    ]
