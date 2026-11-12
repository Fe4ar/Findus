from django.db import migrations, models


def color_to_auto(apps, schema_editor):
    apps.get_model("core", "UserSettings").objects.filter(theme="color").update(theme="auto")


class Migration(migrations.Migration):

    dependencies = [("core", "0035_theme_color_wiki_view")]

    operations = [
        migrations.RunPython(color_to_auto, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="usersettings",
            name="theme",
            field=models.CharField(choices=[("auto", "System"), ("light", "Hell"), ("dark", "Dunkel")], default="auto", max_length=5),
        ),
    ]
