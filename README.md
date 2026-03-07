# RelayMesh

A decentralized WebRTC video conferencing system with dynamic relay node selection.

## Overview

RelayMesh eliminates the need for centralized media servers (SFU/MCU) by enabling clients to autonomously form connection topologies and dynamically select relay nodes. Participants establish peer-to-peer connections while selected clients with optimal characteristics act as relay nodes to retransmit media streams.

## Project Structure

```
relay-mesh/
├── src/
│   ├── client/          # Client-side components
│   ├── server/          # Server-side components (signaling)
│   ├── shared/          # Shared types and utilities
│   └── index.ts         # Main entry point
├── dist/                # Compiled output
├── coverage/            # Test coverage reports
└── node_modules/        # Dependencies
```

## Setup

Install dependencies:

```bash
npm install
```

## Development

Build the project:

```bash
npm run build          # Build Node.js/CommonJS version
npm run build:browser  # Build browser bundles
npm run build:all      # Build both
```

The browser build creates three bundles in `dist/browser/`:
- `relay-mesh.esm.js` - ES module for modern browsers
- `relay-mesh.js` - IIFE bundle for script tags
- `relay-mesh.min.js` - Minified IIFE bundle

Run tests:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

Lint code:

```bash
npm run lint
```

Format code:

```bash
npm run format
```

## Testing

The project uses Jest for unit testing and fast-check for property-based testing. Tests are located alongside source files with `.test.ts` or `.spec.ts` extensions.

## License

MIT
