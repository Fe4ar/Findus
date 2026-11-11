from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("core", "0031_idle_logout")]

    operations = [
        migrations.AddField(model_name="usersettings", name="language", field=models.CharField(choices=[("de", "Deutsch"), ("en", "English")], default="de", max_length=5)),
    ]
