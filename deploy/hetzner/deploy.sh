#!/bin/sh
# Usage: deploy/hetzner/deploy.sh root@host   (from the repo root). Idempotent; safe to re-run to update.
set -eu
HOST=${1:?usage: deploy.sh user@host}
DOMAIN=${LOMI_DOMAIN:-lomi.trythissoftware.com}
rsync -az --delete --exclude-from=.dockerignore --exclude .git ./ "$HOST:/opt/lomi/src/"
ssh "$HOST" "DOMAIN=$DOMAIN sh -s" <<'REMOTE'
set -eu
cd /opt/lomi/src/deploy/hetzner
if [ ! -f /opt/lomi/.env ]; then
  umask 077
  printf 'POSTGRES_PASSWORD=%s\nLOMI_WEB_PORT=8095\nANTHROPIC_API_KEY=\n' "$(openssl rand -hex 24)" > /opt/lomi/.env
fi
ln -sf /opt/lomi/.env .env
docker compose build
docker compose up -d --remove-orphans
install -m 755 backup.sh /opt/lomi/backup.sh
echo '17 3 * * * root /opt/lomi/backup.sh' > /etc/cron.d/lomi-backup
if ! grep -q "BEGIN lomi" /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date -u +%Y%m%dT%H%M%SZ)
  cat >> /etc/caddy/Caddyfile <<CADDY

# BEGIN lomi (managed by deploy/hetzner/deploy.sh)
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 30MB
	}
	reverse_proxy 127.0.0.1:8095
}
# END lomi
CADDY
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
fi
REMOTE
