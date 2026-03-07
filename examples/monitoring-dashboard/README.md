# RelayMesh Monitoring Dashboard Example

A real-time web-based monitoring dashboard for visualizing RelayMesh server metrics and topology using interactive graphs.

## Features

- Interactive force-directed graph visualization of conference topology
- Real-time server metrics (conferences, participants, uptime)
- Visual representation of relay nodes and their connections
- Participant metrics table with bandwidth, latency, and packet loss
- Event log for tracking system events
- Auto-refresh every 5 seconds
- Drag-and-drop node positioning
- Hover tooltips with detailed participant information
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

To connect to a real RelayMesh server:

#### 1. Install Dependencies

```bash
npm install express cors
```

#### 2. Start the Server with Monitoring API

```bash
# Start the signaling server with monitoring API
node examples/server/server.js
```

This will start:
- WebSocket signaling server on port 8080
- Monitoring API on port 3000

#### 3. Update Dashboard Configuration

Edit `examples/monitoring-dashboard/index.html`:

```javascript
// Change this line
const USE_MOCK_DATA = false; // Use real API
```

#### 4. Open the Dashboard

```bash
# Serve the dashboard
npx http-server examples/monitoring-dashboard -p 3001
```

Open http://localhost:3001 in your browser.

## Dashboard Sections

### Server Metrics

Displays key server statistics:
- **Active Conferences**: Number of ongoing conferences
- **Total Participants**: Total number of connected participants
- **Relay Nodes**: Number of participants acting as relays
- **Server Uptime**: How long the server has been running

### Connection Topology (Interactive Graph)

Interactive force-directed graph showing the relay mesh topology:
- **Blue nodes**: Relay nodes (larger circles)
- **Green nodes**: Regular nodes (smaller circles)
- **Dashed blue lines**: Relay-to-relay connections
- **Solid green lines**: Relay-to-regular connections
- **Drag nodes**: Click and drag to reposition
- **Hover**: View detailed metrics for each participant

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

## Monitoring API Endpoints

The monitoring API provides several endpoints:

### GET /api/monitoring

Returns complete monitoring data:

```json
{
  "serverInfo": {
    "activeConferences": 2,
    "totalParticipants": 8,
    "uptime": 3600000
  },
  "conferences": [...],
  "participants": [...],
  "events": [...]
}
```

### GET /api/topology

Returns just the topology snapshot:

```json
{
  "topology": {
    "version": 5,
    "timestamp": 1234567890,
    "relayNodes": ["user-1", "user-2"],
    "groups": [...],
    "relayConnections": [["user-1", "user-2"]]
  },
  "relayNodeAssignments": [...]
}
```

### GET /api/metrics

Returns server and participant metrics:

```json
{
  "serverInfo": {...},
  "participants": [...]
}
```

### GET /api/events

Returns event log with optional filtering:

Query parameters:
- `type`: Filter by event type
- `conferenceId`: Filter by conference
- `startTime`: Unix timestamp (ms)
- `endTime`: Unix timestamp (ms)

## Customization

### Styling

Edit the CSS in `index.html` to customize colors, layout, and appearance.

### Graph Layout

Adjust force simulation parameters in the `renderTopology` function:

```javascript
simulation = d3.forceSimulation(nodes)
  .force('link', d3.forceLink(links).id(d => d.id).distance(150)) // Link distance
  .force('charge', d3.forceManyBody().strength(-300)) // Repulsion strength
  .force('center', d3.forceCenter(width / 2, height / 2))
  .force('collision', d3.forceCollide().radius(40)); // Collision radius
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

Export metrics in Prometheus format by adding an endpoint:

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

## Technology Stack

- **D3.js v7**: Force-directed graph visualization
- **Express**: Monitoring API server
- **WebSocket**: Real-time signaling
- **Vanilla JavaScript**: No framework dependencies

## Browser Support

- Chrome 74+
- Firefox 66+
- Safari 12.1+
- Edge 79+

## See Also

- [API Documentation](../../docs/API.md)
- [Configuration Guide](../../docs/CONFIGURATION.md)
- [Deployment Guide](../../docs/DEPLOYMENT.md)
- [Server Example](../server/README.md)
