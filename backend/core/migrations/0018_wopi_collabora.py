import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0017_task"),
    ]

    operations = [
        migrations.AlterField(
            model_name="fileversion",
            name="source",
            field=models.CharField(choices=[("upload", "Upload"), ("onlyoffice", "OnlyOffice"), ("restore", "Wiederhergestellt"), ("collabora", "Collabora")], default="upload", max_length=12),
        ),
        migrations.CreateModel(
            name="WopiLock",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("lock", models.CharField(max_length=1024)),
                ("expires", models.DateTimeField()),
                ("node", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="wopi_lock", to="core.node")),
            ],
        ),
    ]
