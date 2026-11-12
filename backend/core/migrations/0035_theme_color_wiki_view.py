from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("core", "0034_shortcut_folder_parent")]

    operations = [
        migrations.AlterField(
            model_name="usersettings",
            name="theme",
            field=models.CharField(choices=[("auto", "System"), ("light", "Hell"), ("dark", "Dunkel"), ("color", "Farbig")], default="auto", max_length=5),
        ),
        migrations.AddField(
            model_name="usersettings",
            name="wiki_view",
            field=models.CharField(choices=[("tree", "Baum"), ("classic", "Klassisch")], default="tree", max_length=7),
        ),
    ]
