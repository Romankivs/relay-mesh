#!/bin/bash
# Run this after resuming the GCP instance to reconfigure everything for the new IP.
# Usage: bash ~/relay-mesh/scripts/reconfigure-ip.sh

set -e

NEW_IP=$(curl -s ifconfig.me)
echo "Detected external IP: $NEW_IP"
NEW_DOMAIN="${NEW_IP}.nip.io"

# Write temporary HTTP-only nginx config so certbot can complete the HTTP challenge
sudo tee /etc/nginx/sites-enabled/relay-mesh > /dev/null <<EOF
server {
    listen 80;
    server_name ${NEW_DOMAIN};
    root /home/sviatoslavromankiv/relay-mesh;
    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF
sudo nginx -t && sudo systemctl reload nginx

# Get new TLS cert
sudo certbot certonly --nginx -d "$NEW_DOMAIN" --non-interactive --agree-tos -m romankiv1771@gmail.com

# Write full HTTPS nginx config now that the cert exists
sudo tee /etc/nginx/sites-enabled/relay-mesh > /dev/null <<EOF
server {
    listen 443 ssl;
    server_name ${NEW_DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${NEW_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${NEW_DOMAIN}/privkey.pem;

    root /home/sviatoslavromankiv/relay-mesh;
    index examples/simple-client/index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    # Proxy REST API (monitoring dashboard)
    location /api {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }

    # Proxy WebSocket signaling
    location /ws {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name ${NEW_DOMAIN};
    return 301 https://\$host\$request_uri;
}
EOF
sudo nginx -t && sudo systemctl reload nginx

# Update simple-client default signaling URL (handles both localhost default and previous nip.io)
sed -i "s|ws://localhost:8080|wss://${NEW_DOMAIN}/ws|g" ~/relay-mesh/examples/simple-client/index.html
sed -i "s|wss://[^'\"]*\.nip\.io/ws|wss://${NEW_DOMAIN}/ws|g" ~/relay-mesh/examples/simple-client/index.html

# Restart relay-mesh service
sudo systemctl restart relay-mesh

echo ""
echo "Done! Your URLs:"
echo "  Client:    https://${NEW_DOMAIN}/examples/simple-client/index.html"
echo "  Dashboard: https://${NEW_DOMAIN}/examples/monitoring-dashboard/"
echo "  Signaling: wss://${NEW_DOMAIN}/ws"
