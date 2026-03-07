# Monitoring Dashboard Setup Guide

Quick guide to get the monitoring dashboard running with real data.

## Prerequisites

- Node.js installed
- RelayMesh project built (`npm run build`)

## Step 1: Install Dependencies

```bash
# From project root
npm install express cors
```

## Step 2: Start the Server

```bash
# From project root
node examples/server/server.js
```

You should see:
```
🚀 Starting RelayMesh Signaling Server...
✅ Server started successfully!

Configuration:
  - Port: 8080
  - Host: 0.0.0.0
  - Monitoring Port: 3000

📡 Server URL: ws://0.0.0.0:8080
📊 Dashboard: http://localhost:3000/api/monitoring
```

## Step 3: Configure Dashboard for Real Data

Edit `examples/monitoring-dashboard/index.html` and change:

```javascript
const USE_MOCK_DATA = false; // Change from true to false
```

## Step 4: Serve the Dashboard

```bash
# From project root
npx http-server examples/monitoring-dashboard -p 3001
```

## Step 5: Open Dashboard

Open your browser to: http://localhost:3001

## Step 6: Connect Clients

To see real topology data, connect some clients:

```bash
# In another terminal
npx http-server examples/simple-client -p 3002
```

Then open multiple browser tabs to http://localhost:3002 and join the same conference.

## What You'll See

Once clients are connected, the dashboard will show:

1. **Server Metrics**: Active conferences, participants, relay nodes, uptime
2. **Interactive Topology Graph**: 
   - Blue nodes = Relay nodes
   - Green nodes = Regular nodes
   - Dashed lines = Relay-to-relay connections
   - Solid lines = Relay-to-regular connections
   - Drag nodes to reposition
   - Hover for detailed metrics
3. **Participant Metrics Table**: Bandwidth, latency, packet loss, quality
4. **Event Log**: Real-time system events

## Troubleshooting

### Dashboard shows "No active conferences"

- Make sure clients are connected to the server
- Check that `USE_MOCK_DATA = false` in the dashboard HTML
- Verify the monitoring API is accessible: `curl http://localhost:3000/api/monitoring`

### CORS errors in browser console

- Make sure the server is running with the monitoring API
- Check that express and cors are installed: `npm install express cors`

### Port conflicts

Change the ports if needed:

```bash
# Server
PORT=9000 MONITORING_PORT=4000 node examples/server/server.js

# Dashboard
npx http-server examples/monitoring-dashboard -p 5000
```

Then update the API URL in the dashboard:
```javascript
const API_BASE_URL = 'http://localhost:4000/api';
```

## Testing with Mock Data

To test the dashboard without a real server:

1. Keep `USE_MOCK_DATA = true` in the dashboard HTML
2. Serve the dashboard: `npx http-server examples/monitoring-dashboard -p 3001`
3. Open http://localhost:3001

The dashboard will show simulated data with 2 conferences and 8 participants.

## API Endpoints

Test the monitoring API directly:

```bash
# Complete monitoring data
curl http://localhost:3000/api/monitoring | jq

# Just topology
curl http://localhost:3000/api/topology | jq

# Just metrics
curl http://localhost:3000/api/metrics | jq

# Events (last 5 minutes)
curl http://localhost:3000/api/events | jq
```

## Next Steps

- Customize the graph layout in `renderTopology()` function
- Adjust refresh interval (default: 5 seconds)
- Add custom metrics to the monitoring API
- Integrate with Prometheus/Grafana for production monitoring

## See Also

- [Dashboard README](README.md)
- [Server README](../server/README.md)
- [API Documentation](../../docs/API.md)
