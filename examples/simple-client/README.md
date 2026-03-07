# RelayMesh Simple Client Example

A minimal web-based client demonstrating RelayMesh video conferencing.

## ⚠️ Current Status

**This example currently requires a browser build setup to work.** The project is built as CommonJS modules, but browsers need ES modules or a bundled script.

**TODO:** Add a bundler (webpack/rollup/esbuild) to create a browser-compatible build, or provide a pre-built UMD bundle.

For now, use the Node.js examples or the monitoring dashboard which uses a different approach.

## Features

- Join/leave conferences
- Display local and remote video streams
- Show participant role (relay or regular)
- Real-time event logging
- Clean, responsive UI

## Running the Example (When Build is Available)

### 1. Build the Project

```bash
# From the project root
npm run build
```

### 2. Start the Signaling Server

```bash
# From the project root
cd examples/server
node server.js
```

The server will start on `ws://localhost:8080`

### 3. Open the Client

```bash
# Serve the client (from project root)
npx http-server examples/simple-client -p 3000
```

Then open http://localhost:3000 in your browser.

### 3. Join a Conference

1. Enter your name
2. Enter a conference ID (e.g., "demo-conference")
3. Click "Join Conference"
4. Allow camera/microphone permissions when prompted

### 4. Test with Multiple Participants

Open the same URL in multiple browser tabs or windows to simulate multiple participants.

## Configuration

Edit the default values in `index.html`:

```javascript
serverUrl: 'ws://localhost:8080'  // Signaling server URL
userName: 'User'                   // Default participant name
conferenceId: 'demo-conference'    // Default conference ID
```

## Troubleshooting

**Camera/microphone not working:**
- Check browser permissions
- Ensure HTTPS or localhost (required for WebRTC)
- Try a different browser

**Can't connect to server:**
- Verify server is running
- Check server URL is correct
- Check firewall settings

**No remote video:**
- Ensure multiple participants have joined
- Check browser console for errors
- Verify WebRTC connections are established

## Browser Support

- Chrome 74+
- Firefox 66+
- Safari 12.1+
- Edge 79+

## See Also

- [API Documentation](../../docs/API.md)
- [Configuration Guide](../../docs/CONFIGURATION.md)
- [Deployment Guide](../../docs/DEPLOYMENT.md)
