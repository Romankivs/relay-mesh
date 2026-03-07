# RelayMesh Examples

This directory contains example applications demonstrating RelayMesh usage.

## Available Examples

### 1. Simple Server
**Location:** `examples/server/`

A minimal signaling server for development and testing.

**Features:**
- Easy configuration via environment variables
- Graceful shutdown handling
- Activity monitoring
- Development-friendly defaults

**Quick Start:**
```bash
cd examples/server
node server.js
```

[View Documentation](./server/README.md)

---

### 2. Simple Client
**Location:** `examples/simple-client/`

A web-based video conferencing client with a clean UI.

**Features:**
- Join/leave conferences
- Display local and remote video streams
- Show participant role (relay or regular)
- Real-time event logging
- Responsive design

**Quick Start:**
```bash
# Start server first
cd examples/server
node server.js

# In another terminal, serve the client
cd examples/simple-client
npx http-server -p 3000
```

Then open http://localhost:3000

[View Documentation](./simple-client/README.md)

---

### 3. Monitoring Dashboard
**Location:** `examples/monitoring-dashboard/`

A web-based dashboard for monitoring server metrics and topology.

**Features:**
- Real-time server metrics
- Visual topology representation
- Participant metrics table
- Event log
- Auto-refresh

**Quick Start:**
```bash
cd examples/monitoring-dashboard
npx http-server -p 3001
```

Then open http://localhost:3001

[View Documentation](./monitoring-dashboard/README.md)

---

## Complete Setup Guide

### Prerequisites

- Node.js 16+ or 18+
- npm or yarn
- Modern web browser (Chrome, Firefox, Safari, Edge)

### Step 1: Build the Project

```bash
# From project root
npm install
npm run build
```

### Step 2: Start the Server

```bash
cd examples/server
node server.js
```

You should see:
```
✅ Server started successfully!
📡 Server URL: ws://localhost:8080
```

### Step 3: Open the Client

In a new terminal:

```bash
cd examples/simple-client
npx http-server -p 3000
```

Open http://localhost:3000 in your browser.

### Step 4: Join a Conference

1. Enter your name (e.g., "Alice")
2. Enter a conference ID (e.g., "demo-conference")
3. Click "Join Conference"
4. Allow camera/microphone permissions

### Step 5: Test with Multiple Participants

Open the same URL in multiple browser tabs or windows to simulate multiple participants joining the same conference.

### Step 6: Monitor the System (Optional)

In a new terminal:

```bash
cd examples/monitoring-dashboard
npx http-server -p 3001
```

Open http://localhost:3001 to view the monitoring dashboard.

---

## Example Scenarios

### Scenario 1: Basic Video Conference

**Goal:** Test basic video conferencing with 3 participants

1. Start the server
2. Open 3 browser tabs with the simple client
3. Join the same conference ID in all tabs
4. Observe video streams and role assignments

**Expected Behavior:**
- All participants can see each other's video
- 1-2 participants become relay nodes
- Regular nodes connect only to their assigned relay

### Scenario 2: Relay Node Selection

**Goal:** Observe relay node selection and role changes

1. Start with 2 participants (both will be regular initially)
2. Add a 3rd participant with good network conditions
3. Observe relay node selection
4. Add more participants and watch topology adapt

**Expected Behavior:**
- System selects participants with best metrics as relays
- Topology updates as participants join
- Role changes are logged in the event log

### Scenario 3: Network Degradation

**Goal:** Test system behavior under poor network conditions

1. Join a conference with multiple participants
2. Use browser DevTools to throttle network (Network tab → Throttling)
3. Observe adaptive bitrate and potential relay demotion

**Expected Behavior:**
- Video quality adapts to available bandwidth
- Relay nodes with degraded metrics may be demoted
- System maintains connectivity despite poor conditions

### Scenario 4: Participant Leave/Join

**Goal:** Test dynamic participant management

1. Start a conference with 5 participants
2. Have participants leave one by one
3. Have new participants join
4. Observe topology updates

**Expected Behavior:**
- Topology updates when participants leave
- New participants are integrated smoothly
- Relay failover occurs if relay node leaves

---

## Customization

### Custom Configuration

Create a `config.json` file:

```json
{
  "selection": {
    "minBandwidthMbps": 10,
    "maxParticipantsPerRelay": 7,
    "reevaluationIntervalMs": 20000
  }
}
```

Use in client:

```javascript
import { createConfigurationManager } from 'relay-mesh';

const configManager = createConfigurationManager('./config.json');
const client = new RelayMeshClient({
  signalingServerUrl: 'ws://localhost:8080',
  participantName: 'User',
  selectionConfig: configManager.getSelectionConfig()
});
```

### Custom Styling

Edit the CSS in the example HTML files to match your brand:

```css
/* Change primary color */
button {
  background: #your-color;
}

/* Change layout */
.videos {
  grid-template-columns: repeat(3, 1fr);
}
```

### Custom Features

Extend the examples with additional features:

- Screen sharing
- Chat messages
- Recording
- Virtual backgrounds
- Noise suppression
- Custom layouts

---

## Troubleshooting

### Server Won't Start

**Problem:** Port already in use

**Solution:**
```bash
# Use a different port
PORT=8081 node server.js
```

### Client Can't Connect

**Problem:** Connection refused

**Solution:**
1. Verify server is running
2. Check server URL is correct
3. Check firewall settings
4. Try `ws://localhost:8080` instead of `ws://0.0.0.0:8080`

### No Video/Audio

**Problem:** Black screen or no audio

**Solution:**
1. Check browser permissions (camera/microphone)
2. Verify HTTPS or localhost (required for WebRTC)
3. Check browser console for errors
4. Try a different browser

### Poor Video Quality

**Problem:** Pixelated or choppy video

**Solution:**
1. Check network bandwidth
2. Reduce video resolution in constraints
3. Close other bandwidth-intensive applications
4. Check CPU usage

### Participants Can't See Each Other

**Problem:** Connected but no media streams

**Solution:**
1. Check WebRTC peer connections in browser DevTools
2. Verify STUN/TURN servers are accessible
3. Check firewall allows UDP traffic
4. Review browser console for WebRTC errors

---

## Next Steps

- Read the [API Documentation](../docs/API.md) for detailed API reference
- Review the [Configuration Guide](../docs/CONFIGURATION.md) for optimization
- Follow the [Deployment Guide](../docs/DEPLOYMENT.md) for production setup
- Explore the source code to understand implementation details

---

## Contributing

Found a bug or want to improve the examples? Contributions are welcome!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

## License

These examples are provided as-is for demonstration purposes.
