#!/usr/bin/env bash
# Rebuild the Gemist Shopify app on the Ubuntu host that serves gemistapp.zooq.app
# Run on the server:
#   cd /var/www/Gemist_Shopiy_Anup && bash deploy/rebuild-app.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Pulling latest code (if git remote is configured)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only || true
fi

echo "==> Rebuilding app container (runs prisma migrate deploy on start)"
sudo docker compose up -d --build app

echo "==> Waiting for healthz"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:11027/healthz" >/dev/null 2>&1 \
    || curl -fsS "https://gemistapp.zooq.app/healthz" >/dev/null 2>&1; then
    echo "App is healthy."
    exit 0
  fi
  sleep 2
done

echo "WARNING: healthz did not respond yet. Check: sudo docker compose logs -f app"
exit 1
