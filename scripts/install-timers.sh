#!/bin/sh
# Installs the daily backup and the trash-purge timers for the current user and this checkout (needs sudo).
# Another account runs the jobs: SERVICE_USER=name scripts/install-timers.sh
set -eu
dir=$(cd "$(dirname "$0")/.." && pwd)
user=${SERVICE_USER:-$(id -un)}
for n in backup purge; do
    for ext in service timer; do
        sed -e "s#@USER@#$user#g" -e "s#@DIR@#$dir#g" "$dir/scripts/systemd/findus-$n.$ext" \
            | sudo tee "/etc/systemd/system/findus-$n.$ext" >/dev/null
    done
done
sudo systemctl daemon-reload
sudo systemctl enable --now findus-backup.timer findus-purge.timer
systemctl list-timers 'findus-*'
