# RelayMesh Simple Server Example

A minimal signaling server for development and testing with built-in monitoring API.

## Features

- WebSocket signaling server for RelayMesh clients
- Built-in HTTP monitoring API on the same port
- Graceful shutdown handling
- Environment-based configuration
- Activity logging
- CORS support for dashboard

## Quick Start

```bash
# From the project root
node examples/server/server.js
```

The server will start on port 8080 with:
- **WebSocket Server**: ws://localhost:8080 (signaling)
- **Monitoring API**: http://localhost:8080/api/monitoring (metrics and topology)

## Configuration

Configure the server using environment variables:

```bash
# Basic configuration
PORT=8080 node server.js

# With TLS (production)
PORT=8443 \
TLS_ENABLED=true \
TLS_CERT_PATH=/path/to/cert.pem \
TLS_KEY_PATH=/path/to/key.pem \
node server.js

# With authentication
AUTH_REQUIRED=true node server.js

# Full configuration
PORT=8443 \
HOST=0.0.0.0 \
TLS_ENABLED=true \
TLS_CERT_PATH=/etc/ssl/certs/server.crt \
TLS_KEY_PATH=/etc/ssl/private/server.key \
AUTH_REQUIRED=true \
MAX_CONFERENCES=100 \
MAX_PARTICIPANTS=50 \
node server.js
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port (WebSocket + HTTP API) | `8080` |
| `HOST` | Server host | `0.0.0.0` |
| `TLS_ENABLED` | Enable TLS/SSL | `false` |
| `TLS_CERT_PATH` | Path to TLS certificate | - |
| `TLS_KEY_PATH` | Path to TLS private key | - |
| `AUTH_REQUIRED` | Require authentication | `false` |
| `MAX_CONFERENCES` | Maximum concurrent conferences | `100` |
| `MAX_PARTICIPANTS` | Maximum participants per conference | `50` |

## Monitoring API

The server exposes HTTP endpoints on the same port as the WebSocket server:

### GET /api/monitoring

Complete monitoring data including topology, metrics, and events.

```bash
curl http://localhost:8080/api/monitoring
```

### GET /api/server-info

Server information only.

```bash
curl http://localhost:8080/api/server-info
```

## Using with Example Client

1. Start the server:
```bash
node server.js
```

2. Open the simple client:
```bash
cd ../simple-client
npx http-server -p 3001
```

3. Open http://localhost:3001 in your browser

4. Enter server URL: `ws://localhost:8080`

## Using with Monitoring Dashboard

1. Start the server:
```bash
node server.js
```

2. Serve the dashboard:
```bash
cd ../monitoring-dashboard
npx http-server -p 3001
```

3. Open http://localhost:3001 in your browser

The dashboard will automatically connect to http://localhost:8080/api/monitoring

## Production Deployment

**⚠️ This example server is for development only!**

For production deployment:

1. Enable TLS
2. Enable authentication
3. Use a process manager (PM2, systemd)
4. Configure firewall
5. Set up monitoring
6. Use a reverse proxy (nginx)

See the [Deployment Guide](../../docs/DEPLOYMENT.md) for detailed instructions.

## Monitoring

The server logs activity every 30 seconds when there are active conferences:

```
[10:30:15] Active: 2 conferences, 8 participants
```

For detailed monitoring, use the [monitoring dashboard example](../monitoring-dashboard/).

## Troubleshooting

### Port Already in Use

```bash
# Find process using port 8080
lsof -i :8080

# Kill the process
kill -9 <PID>

# Or use a different port
PORT=8081 node server.js
```

### Permission Denied (Port < 1024)

```bash
# Use a port >= 1024
PORT=8080 node server.js

# Or run with sudo (not recommended)
sudo PORT=80 node server.js
```

### TLS Certificate Errors

```bash
# Verify certificate
openssl x509 -in cert.pem -text -noout

# Check certificate and key match
openssl x509 -noout -modulus -in cert.pem | openssl md5
openssl rsa -noout -modulus -in key.pem | openssl md5
```

### CORS Issues

The monitoring API includes CORS headers by default. All origins are allowed for development.

## Development Tips

### Auto-Restart on Changes

```bash
# Install nodemon
npm install -g nodemon

# Run with auto-restart
nodemon server.js
```

### Debug Mode

```bash
# Enable Node.js debugging
NODE_DEBUG=* node server.js

# Or use Chrome DevTools
node --inspect server.js
```

### Testing with Multiple Clients

Open multiple browser tabs or use different browsers to simulate multiple participants.

## See Also

- [API Documentation](../../docs/API.md)
- [Configuration Guide](../../docs/CONFIGURATION.md)
- [Deployment Guide](../../docs/DEPLOYMENT.md)
- [Simple Client Example](../simple-client/)
- [Monitoring Dashboard Example](../monitoring-dashboard/)
