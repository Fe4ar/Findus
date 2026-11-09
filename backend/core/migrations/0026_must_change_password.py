from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0025_team_share_by_members'),
    ]

    operations = [
        migrations.AddField(
            model_name='usersettings',
            name='must_change_password',
            field=models.BooleanField(default=False),
        ),
    ]
