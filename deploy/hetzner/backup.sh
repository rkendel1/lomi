#!/bin/sh
# Nightly Postgres dump, 14 days kept. Installed in /etc/cron.d/lomi-backup by deploy.sh.
set -eu
dir=/opt/lomi/backups; mkdir -p "$dir"
docker exec lomi-postgres-1 pg_dump -U lomi -Fc lomi > "$dir/lomi-$(date +%F).dump"
find "$dir" -name 'lomi-*.dump' -mtime +14 -delete
