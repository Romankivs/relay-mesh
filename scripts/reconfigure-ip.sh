#!/bin/bash
# Run this after resuming the GCP instance to reconfigure everything for the new IP.
# Usage: bash ~/relay-mesh/scripts/reconfigure-ip.sh

set -e

NEW_IP=$(curl -s ifconfig.me)
echo "Detected external IP: $NEW_IP"
NEW_DOMAIN="${NEW_IP}.nip.io"

# Update nginx config
sudo sed -i "s/server_name .*/server_name ${NEW_DOMAIN};/" /etc/nginx/sites-available/relay-mesh
sudo sed -i "s|/etc/letsencrypt/live/[^/]*/fullchain.pem|/etc/letsencrypt/live/${NEW_DOMAIN}/fullchain.pem|" /etc/nginx/sites-available/relay-mesh
sudo sed -i "s|/etc/letsencrypt/live/[^/]*/privkey.pem|/etc/letsencrypt/live/${NEW_DOMAIN}/privkey.pem|" /etc/nginx/sites-available/relay-mesh

# Get new TLS cert
sudo certbot certonly --nginx -d "$NEW_DOMAIN" --non-interactive --agree-tos -m romankiv1771@gmail.com

# Reload nginx
sudo nginx -t && sudo systemctl reload nginx

# Update simple-client default signaling URL
sed -i "s|wss://[^'\"]*\.nip\.io/ws|wss://${NEW_DOMAIN}/ws|g" ~/relay-mesh/examples/simple-client/index.html

# Restart relay-mesh service
sudo systemctl restart relay-mesh

echo ""
echo "Done! Your URLs:"
echo "  Client:    https://${NEW_DOMAIN}/examples/simple-client/index.html"
echo "  Dashboard: https://${NEW_DOMAIN}/examples/monitoring-dashboard/"
echo "  Signaling: wss://${NEW_DOMAIN}/ws"
