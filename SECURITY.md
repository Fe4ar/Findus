# Security policy

Please **do not** open public issues for security problems. Report them privately via the
"Report a vulnerability" button in the Security tab of this repository. We aim to answer within a week.

Findus is meant for internal networks. Recommended setup:
- run it behind HTTPS (built-in Caddy) and keep `DJANGO_DEBUG` unset;
- keep the Docker images up to date (`docker compose pull && docker compose up -d --build`);
- give users the least rights they need (groups and permissions per area);
- back up regularly with `scripts/backup.sh` and test restores in the isolated test stack.
