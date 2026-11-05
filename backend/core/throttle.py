"""Brute-force protection for the login: failed attempts are counted per user name and per client address.

After LIMITS[kind] failures inside WINDOW the key is locked for 30 s, doubling with every further failure up to 15 minutes;
while locked, even the right password gets 429 (no guessing oracle). A successful login clears the user's counter.
The counters live in the database, so all gunicorn workers share them and they survive restarts.
Known limit: locking by user name lets someone keep a known account locked by failing on purpose; the lock ends by itself
after at most 15 minutes and other accounts are unaffected.
"""
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from .audit import client_ip
from .models import LoginThrottle

WINDOW = timedelta(minutes=15)
BASE_LOCK, MAX_LOCK = 30, 900  # seconds
LIMITS = {"user": 5, "ip": 20}  # an office behind one address may fail more often than a single account


def keys(request, username):
    ks = [("user", f"user:{str(username or '').strip().lower()[:150]}")]
    if (ip := client_ip(request)):
        ks.append(("ip", f"ip:{ip}"))
    return ks


def locked_seconds(ks):
    """Seconds until the longest lock among the keys ends (0 = free to try)."""
    now = timezone.now()
    ends = [t.locked_until for t in LoginThrottle.objects.filter(key__in=[k for _, k in ks]) if t.locked_until and t.locked_until > now]
    return int((max(ends) - now).total_seconds()) + 1 if ends else 0


def record_failure(ks):
    """Counts one failed password check; returns the kinds that got locked by it."""
    now, locked = timezone.now(), []
    for kind, key in ks:
        with transaction.atomic():
            t, _ = LoginThrottle.objects.select_for_update().get_or_create(key=key, defaults={"last_fail": now})
            t.fails = 1 if now - t.last_fail > WINDOW else t.fails + 1
            t.last_fail = now
            if t.fails >= LIMITS[kind]:
                t.locked_until = now + timedelta(seconds=min(BASE_LOCK * 2 ** (t.fails - LIMITS[kind]), MAX_LOCK))
                locked.append(kind)
            t.save()
    return locked


def record_success(ks):
    LoginThrottle.objects.filter(key__in=[k for kind, k in ks if kind == "user"]).delete()
