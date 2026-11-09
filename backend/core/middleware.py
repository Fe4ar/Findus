"""The start admin has to set a new password before it may do anything else."""
from django.http import JsonResponse

ALLOWED = ("/api/auth/me", "/api/auth/logout", "/api/auth/password", "/api/auth/login", "/api/health", "/static/")


class MustChangePasswordMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated and not request.path.startswith(ALLOWED):
            settings = getattr(user, "findus_settings", None)
            if settings is not None and settings.must_change_password:
                return JsonResponse({"detail": "Bitte zuerst ein neues Passwort festlegen.", "must_change_password": True}, status=403)
        return self.get_response(request)
