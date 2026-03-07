# RelayMesh Simple Client Example

A minimal web-based client demonstrating RelayMesh video conferencing.

## Features

- Join/leave conferences
- Display local and remote video streams
- Show participant role (relay or regular)
- Real-time event logging
- Clean, responsive UI

## Running the Example

### 1. Build the Browser Bundle

```bash
# From the project root
npm run build:browser
```

This creates browser-compatible bundles in `dist/browser/`:
- `relay-mesh.esm.js` - ES module (used by this example)
- `relay-mesh.js` - IIFE bundle (for script tags)
- `relay-mesh.min.js` - Minified IIFE bundle

### 2. Start the Signaling Server

```bash
# From the project root
cd examples/server
node server.js
```

The server will start on `ws://localhost:8080`

### 3. Serve and Open the Client

```bash
# Serve from project root (so it can access dist/browser/)
npx http-server . -p 3000
```

Then open http://localhost:3000/examples/simple-client/ in your browser.

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

## Known Issues

### Participant Count Shows 1

When multiple participants join the same conference, the participant count may show as 1 for the first 2-3 seconds. This is because:

1. Each client needs to collect metrics (bandwidth, NAT type, etc.)
2. Bandwidth measurement takes ~2.5 seconds to complete
3. Until metrics are collected, participants don't broadcast their presence
4. The count updates automatically once metrics are exchanged

**Workaround**: Wait 3-5 seconds after joining for the participant count to update. The UI refreshes automatically every second.

**Future Fix**: This will be resolved by:
- Making bandwidth measurement faster or async
- Using fallback values immediately
- Showing "pending" participants before metrics are ready

### Role Shows "-" Initially

The role may show as "-" briefly when joining. This is normal - it updates to "REGULAR" once the client is fully connected, and may change to "RELAY" if the participant is selected as a relay node.

## Troubleshooting

### "Requested device not found" Error

This error means no camera/microphone is available. Solutions:

1. **Check if devices are connected**
   - Ensure your camera/microphone is plugged in
   - Check if the device appears in System Preferences/Settings

2. **Check if another app is using the devices**
   - Close other video conferencing apps (Zoom, Teams, etc.)
   - Close other browser tabs using camera/microphone
   - Restart your browser

3. **Check browser permissions**
   - Click the camera icon in the browser address bar
   - Allow camera and microphone access
   - Reload the page after granting permissions

4. **Test your devices**
   - Open your browser's settings and test camera/microphone
   - Try a different browser to isolate the issue

### Camera/microphone not working

- Check browser permissions
- Ensure HTTPS or localhost (required for WebRTC)
- Try a different browser
- Check if devices work in other applications

### Can't connect to server

- Verify server is running on the correct port
- Check server URL is correct (ws://localhost:8080)
- Check firewall settings
- Look at browser console for connection errors

### No remote video

- Ensure multiple participants have joined the same conference
- Check browser console for errors
- Verify WebRTC connections are established
- Check that both participants have working cameras

## Browser Support

- Chrome 74+
- Firefox 66+
- Safari 12.1+
- Edge 79+

## See Also

- [API Documentation](../../docs/API.md)
- [Configuration Guide](../../docs/CONFIGURATION.md)
- [Deployment Guide](../../docs/DEPLOYMENT.md)
