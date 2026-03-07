# Browser Build Setup

This document explains the browser build setup for RelayMesh.

## Overview

RelayMesh now supports browser usage through bundled JavaScript files. The project uses esbuild to create browser-compatible bundles from the TypeScript source.

## Build Process

### Quick Start

```bash
# Build browser bundles only
npm run build:browser

# Build both Node.js and browser versions
npm run build:all
```

### What Gets Built

The browser build creates three files in `dist/browser/`:

1. **relay-mesh.esm.js** - ES module format
   - For modern browsers with `<script type="module">`
   - Tree-shakeable
   - ~127KB unminified

2. **relay-mesh.js** - IIFE format
   - For direct `<script>` tag usage
   - Exposes `RelayMesh` global
   - ~136KB unminified

3. **relay-mesh.min.js** - Minified IIFE
   - Production-ready
   - ~53KB minified

All bundles include source maps for debugging.

## Usage Examples

### ES Module (Modern Browsers)

```html
<script type="module">
  import { RelayMeshClient } from './dist/browser/relay-mesh.esm.js';
  
  const client = new RelayMeshClient({
    signalingServerUrl: 'ws://localhost:8080',
    participantName: 'Alice'
  });
  
  await client.joinConference('demo');
</script>
```

### Script Tag (All Browsers)

```html
<script src="./dist/browser/relay-mesh.min.js"></script>
<script>
  const { RelayMeshClient } = RelayMesh;
  
  const client = new RelayMeshClient({
    signalingServerUrl: 'ws://localhost:8080',
    participantName: 'Bob'
  });
  
  client.joinConference('demo');
</script>
```

## Examples

See the working examples:

- **Simple Client**: `examples/simple-client/` - Basic video conferencing UI
- **Monitoring Dashboard**: `examples/monitoring-dashboard/` - Real-time topology visualization

## Technical Details

### Build Configuration

The build script (`build-browser.js`) uses esbuild with:

- **Entry point**: `src/client/index.ts`
- **Platform**: browser
- **Target**: ES2020
- **Bundle**: true (includes all dependencies)
- **Minification**: Optional (separate builds)

### Polyfills

The build includes browser polyfills for Node.js modules:

- `events` - EventEmitter polyfill for browser

### What's Excluded

The browser build only includes client-side code. Server components (`src/server/`) are not included in the bundle.

## Development

### Rebuilding

The browser build is separate from the TypeScript compilation:

```bash
npm run build          # TypeScript → CommonJS (Node.js)
npm run build:browser  # TypeScript → Browser bundles
npm run build:all      # Both
```

### Watching for Changes

For development, you can use a file watcher:

```bash
# Watch and rebuild on changes
npx nodemon --watch src --ext ts --exec "npm run build:browser"
```

### Testing Browser Build

1. Build the bundles:
   ```bash
   npm run build:browser
   ```

2. Start the signaling server:
   ```bash
   cd examples/server
   node server.js
   ```

3. Serve the examples:
   ```bash
   npx http-server . -p 3000
   ```

4. Open http://localhost:3000/examples/simple-client/

## Troubleshooting

### Module Not Found

If you see "Module not found" errors, ensure you've run the build:

```bash
npm run build:browser
```

### CORS Issues

When serving locally, make sure to serve from the project root so the browser can access `dist/browser/`:

```bash
# ✓ Correct - serve from root
npx http-server . -p 3000

# ✗ Wrong - can't access parent directories
npx http-server examples/simple-client -p 3000
```

### WebRTC Permissions

Browsers require HTTPS or localhost for WebRTC. If testing on a network:

1. Use a tool like `ngrok` to create an HTTPS tunnel
2. Or set up a local HTTPS server with self-signed certificates

## Browser Support

Minimum browser versions:

- Chrome 74+ (April 2019)
- Firefox 66+ (March 2019)
- Safari 12.1+ (March 2019)
- Edge 79+ (January 2020)

Requirements:
- WebRTC support (RTCPeerConnection, getUserMedia)
- ES2020 features
- WebSocket support

## Bundle Size Analysis

To analyze what's in the bundle:

```bash
# Install analyzer
npm install --save-dev esbuild-visualizer

# Add to build-browser.js:
# metafile: true
# Then use esbuild-visualizer to analyze
```

Current sizes (uncompressed):
- ESM: 127KB
- IIFE: 136KB
- Minified: 53KB

With gzip compression (typical for web servers):
- Minified + gzip: ~15-20KB (estimated)

## Future Improvements

Potential optimizations:

1. **Code splitting** - Separate core from optional features
2. **Tree shaking** - Better elimination of unused code
3. **Compression** - Pre-compress with Brotli
4. **CDN hosting** - Host bundles on CDN for faster loading
5. **Lazy loading** - Load features on demand
