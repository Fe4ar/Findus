from django.contrib import admin

from .models import AuditLog, FileVersion, Node, NodePermission, PageRevision


class NodePermissionInline(admin.TabularInline):
    model = NodePermission
    extra = 0


@admin.register(Node)
class NodeAdmin(admin.ModelAdmin):
    list_display = ("title", "kind", "parent", "status", "is_public", "updated_at", "deleted_at")
    list_filter = ("kind", "status", "is_public")
    search_fields = ("title",)
    inlines = [NodePermissionInline]


@admin.register(NodePermission)
class NodePermissionAdmin(admin.ModelAdmin):
    list_display = ("group", "node", "can_read", "can_write", "can_publish", "can_manage")
    list_filter = ("group",)


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ("created_at", "username", "action", "node_title", "ip")
    list_filter = ("action", "username")
    search_fields = ("username", "node_title", "ip")
    date_hierarchy = "created_at"

    # The log is evidence: readable in the admin, never editable there.
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


admin.site.register(PageRevision)
admin.site.register(FileVersion)
