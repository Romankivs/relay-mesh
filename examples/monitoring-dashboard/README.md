# RelayMesh Monitoring Dashboard Example

A web-based monitoring dashboard for visualizing RelayMesh server metrics and topology.

## Features

- Real-time server metrics (conferences, participants, uptime)
- Visual topology representation showing relay groups
- Participant metrics table with bandwidth, latency, and packet loss
- Event log for tracking system events
- Auto-refresh every 5 seconds
- Clean, responsive UI

## Running the Example

### Option 1: Standalone (Mock Data)

The dashboard includes mock data for demonstration:

```bash
# Serve the dashboard
npx http-server examples/monitoring-dashboard -p 3001
```

Open http://localhost:3001 in your browser.

### Option 2: Connected to Real Server

To connect to a real RelayMesh server, you'll need to implement a monitoring API endpoint.

#### 1. Add Monitoring Endpoint to Server

```javascript
// server.js
const express = require('express');
const { RelayMeshServer } = require('relay-mesh');

const app = express();
const server = new RelayMeshServer({ port: 8080 });

// Monitoring API
app.get('/api/metrics', (req, res) => {
  const info = server.getServerInfo();
  res.json({
    serverInfo: {
      activeConferences: info.activeConferences,
      totalParticipants: info.totalParticipants,
      uptime: info.uptime
    },
    // Add more data as needed
  });
});

app.listen(3000);
await server.start();
```

#### 2. Update Dashboard to Fetch Real Data

Replace the mock data in `index.html`:

```javascript
async function fetchMetrics() {
  const response = await fetch('http://localhost:3000/api/metrics');
  const data = await response.json();
  return data;
}

async function refreshData() {
  const data = await fetchMetrics();
  mockData = data;
  updateMetrics();
  renderTopology();
  renderParticipantMetrics();
  renderEventLog();
}
```

## Dashboard Sections

### Server Metrics

Displays key server statistics:
- **Active Conferences**: Number of ongoing conferences
- **Total Participants**: Total number of connected participants
- **Relay Nodes**: Number of participants acting as relays
- **Server Uptime**: How long the server has been running

### Connection Topology

Visual representation of the relay topology:
- Shows relay nodes and their assigned regular nodes
- Groups participants by their relay node
- Color-coded for easy identification

### Participant Metrics

Detailed table showing per-participant metrics:
- **Participant**: Name or ID
- **Role**: Relay or Regular
- **Bandwidth**: Upload bandwidth in Mbps
- **Latency**: Average round-trip time in ms
- **Packet Loss**: Percentage of lost packets
- **Connection**: Quality indicator (Good/Warning/Poor)

### Event Log

Chronological log of system events:
- Participant joins/leaves
- Relay promotions/demotions
- Topology updates
- Errors and warnings

## Customization

### Styling

Edit the CSS in `index.html` to customize colors, layout, and appearance.

### Metrics

Add custom metrics by extending the data structure:

```javascript
mockData.customMetrics = {
  cpuUsage: 45.2,
  memoryUsage: 62.8,
  networkThroughput: 125.5
};
```

### Refresh Interval

Change the auto-refresh interval:

```javascript
// Default: 5 seconds
setInterval(refreshData, 5000);

// Change to 10 seconds
setInterval(refreshData, 10000);
```

## Integration with Monitoring Tools

### Prometheus

Export metrics in Prometheus format:

```javascript
app.get('/metrics', (req, res) => {
  const info = server.getServerInfo();
  res.set('Content-Type', 'text/plain');
  res.send(`
# HELP relaymesh_active_conferences Number of active conferences
# TYPE relaymesh_active_conferences gauge
relaymesh_active_conferences ${info.activeConferences}

# HELP relaymesh_total_participants Total number of participants
# TYPE relaymesh_total_participants gauge
relaymesh_total_participants ${info.totalParticipants}
  `);
});
```

### Grafana

Create a Grafana dashboard using the Prometheus metrics:

1. Add Prometheus as a data source
2. Create panels for each metric
3. Set up alerts for critical thresholds

## Browser Support

- Chrome 74+
- Firefox 66+
- Safari 12.1+
- Edge 79+

## See Also

- [API Documentation](../../docs/API.md)
- [Configuration Guide](../../docs/CONFIGURATION.md)
- [Deployment Guide](../../docs/DEPLOYMENT.md)
