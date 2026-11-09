import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]
DEBUG = os.environ.get("DJANGO_DEBUG") == "1"

WIKI_HOST = os.environ.get("WIKI_HOST", "localhost")
# Further names Findus answers to, e.g. a public name behind a reverse proxy.
WIKI_ALIASES = os.environ.get("WIKI_ALIASES", "").replace(",", " ").split()
# Own host name of the logged-out help portal (/hilfe), e.g. hilfe.example.org; only /hilfe and /api/public are served there.
PUBLIC_HOST = os.environ.get("PUBLIC_HOST", "").strip()
# Todoist tokens are stored encrypted: INTEGRATION_KEY is an optional Fernet key, otherwise one is derived from SECRET_KEY.
INTEGRATION_KEY = os.environ.get("INTEGRATION_KEY", "").strip()
# Address of Findus in links that leave it (e.g. from a Todoist task back to the Findus task).
FINDUS_URL = os.environ.get("FINDUS_URL", "").strip().rstrip("/") or f"https://{(os.environ.get('WIKI_ALIASES', '').replace(',', ' ').split() or [os.environ.get('WIKI_HOST', 'localhost')])[0]}"
WIKI_HOSTS = [WIKI_HOST, *WIKI_ALIASES, *([PUBLIC_HOST] if PUBLIC_HOST else [])]
# "web" is the compose service name OnlyOffice uses for internal callbacks.
ALLOWED_HOSTS = [*WIKI_HOSTS, "web", "localhost"]
CSRF_TRUSTED_ORIGINS = [f"https://{h}" for h in WIKI_HOSTS]
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.postgres",
    "rest_framework",
    "core",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "core.middleware.MustChangePasswordMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "wiki.urls"
WSGI_APPLICATION = "wiki.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("POSTGRES_DB", "wiki"),
        "USER": os.environ.get("POSTGRES_USER", "wiki"),
        "PASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),
        "HOST": os.environ.get("POSTGRES_HOST", "db"),
        "PORT": "5432",
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
]

LANGUAGE_CODE = "de-de"
TIME_ZONE = "Europe/Berlin"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT", BASE_DIR / "media"))
ONLYOFFICE_JWT_SECRET = os.environ.get("ONLYOFFICE_JWT_SECRET", "")
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "200"))
# Collabora Online (host:port reachable from this container); empty = Office files open in OnlyOffice only.
COLLABORA_UPSTREAM = os.environ.get("COLLABORA_UPSTREAM", "")
IMPORT_MAX_FILES_PER_HOUR = int(os.environ.get("IMPORT_MAX_FILES_PER_HOUR", "2000"))
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "DEFAULT_THROTTLE_RATES": {"public": "120/min"},
    "UNAUTHENTICATED_USER": "django.contrib.auth.models.AnonymousUser",
}
