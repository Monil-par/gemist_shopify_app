#!/usr/bin/env bash
# Run on the Ubuntu host that serves gemistapp.zooq.app
# Fixes: Refused to display ... X-Frame-Options: deny (Shopify embedded iframe)

set -euo pipefail

echo "Searching nginx configs for X-Frame-Options DENY..."
matches=$(sudo grep -Rnl "X-Frame-Options" /etc/nginx 2>/dev/null || true)
if [[ -z "${matches}" ]]; then
  echo "No X-Frame-Options found under /etc/nginx"
else
  echo "$matches"
  echo
  echo "Edit those files and REMOVE or comment lines like:"
  echo "  add_header X-Frame-Options DENY;"
  echo "  add_header X-Frame-Options \"DENY\" always;"
  echo
  echo "For the gemistapp.zooq.app server block, add inside the location / proxy:"
  echo "  proxy_hide_header X-Frame-Options;"
fi

echo
echo "After editing:"
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo
echo "Then rebuild the app with the latest code:"
echo "  cd /var/www/Gemist_Shopiy_Anup"
echo "  sudo docker compose up -d --build"
echo
echo "Verify headers (must NOT say DENY):"
echo "  curl -sI https://gemistapp.zooq.app/healthz | grep -i frame"
