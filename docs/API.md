# RelayMesh API Documentation

## Overview

RelayMesh is a decentralized WebRTC video conferencing system that eliminates centralized media servers by enabling clients to autonomously form connection topologies with dynamically selected relay nodes. This document provides comprehensive API documentation for all public interfaces and classes.

## Table of Contents

- [Client API](#client-api)
  - [RelayMeshClient](#relaymeshclient)
  - [MetricsCollector](#metricscollector)
  - [SelectionAlgorithm](#selectionalgorithm)
  - [TopologyManager](#topologymanager)
  - [MediaHandler](#mediahandler)
  - [RelayEngine](#relayengine)
  - [SignalingClient](#signalingclient)
- [Server API](#server-api)
  - [RelayMeshServer](#relaymeshserver)
  - [SignalingServer](#signalingserver)
- [Shared Types](#shared-types)
  - [Data Models](#data-models)
  - [Configuration](#configuration)
  - [Signaling Messages](#signaling-messages)

---

## Client API

### RelayMeshClient

The main client class that orchestrates all RelayMesh components for conference participation.

#### Constructor

```typescript
constructor(config: RelayMeshClientConfig)
```

**Parameters:**
- `config.signalingServerUrl` (string): WebSocket URL of the signaling server
- `config.participantName` (string): Display name for this participant
- `config.selectionConfig` (Partial<SelectionConfig>, optional): Custom relay selection parameters
- `config.peerConnectionConfig` (Partial<PeerConnectionConfig>, optional): Custom WebRTC configuration
- `config.enforceSecureConnection` (boolean, optional): Require TLS for signaling (default: true)

**Example:**
```typescript
import { RelayMeshClient } from 'relay-mesh';

const client = new RelayMeshClient({
  signalingServerUrl: 'wss://signaling.example.com',
  participantName: 'Alice',
  selectionConfig: {
    minBandwidthMbps: 10,
    maxParticipantsPerRelay: 7
  }
});
```

#### Methods

##### joinConference(conferenceId: string): Promise<ConferenceInfo>


Joins a conference and establishes connections with other participants.

**Returns:** Promise resolving to conference information including participant ID and role

**Example:**
```typescript
const info = await client.joinConference('conference-123');
console.log(`Joined as ${info.role} with ID ${info.participantId}`);
```

##### leaveConference(): Promise<void>

Leaves the current conference and cleans up all connections.

**Example:**
```typescript
await client.leaveConference();
```

##### getCurrentState(): ConferenceState

Returns the current state of the conference state machine.

**Returns:** One of: `IDLE`, `JOINING`, `CONNECTED`, `LEAVING`

##### getConferenceInfo(): ConferenceInfo | null

Gets information about the current conference, or null if not in a conference.

**Returns:** Conference information or null

#### Events

The RelayMeshClient extends EventEmitter and emits the following events:

- `stateChange`: Fired when conference state changes
  ```typescript
  client.on('stateChange', (event: { from: ConferenceState, to: ConferenceState }) => {
    console.log(`State changed from ${event.from} to ${event.to}`);
  });
  ```

- `topologyUpdate`: Fired when the connection topology changes
  ```typescript
  client.on('topologyUpdate', (topology: ConnectionTopology) => {
    console.log(`New topology with ${topology.relayNodes.length} relay nodes`);
  });
  ```

- `roleChange`: Fired when participant role changes between relay and regular
  ```typescript
  client.on('roleChange', (role: 'relay' | 'regular') => {
    console.log(`Role changed to ${role}`);
  });
  ```

- `remoteStream`: Fired when a remote media stream is received
  ```typescript
  client.on('remoteStream', (stream: MediaStream) => {
    videoElement.srcObject = stream;
  });
  ```

---

### MetricsCollector

Collects and monitors network and device performance metrics for relay selection.


#### Constructor

```typescript
constructor(config: { participantId: string })
```

#### Methods

##### startCollection(): Promise<void>

Starts collecting metrics including bandwidth, NAT type, and device capabilities.

##### getCurrentMetrics(): ParticipantMetrics

Returns the current metrics snapshot.

**Returns:** Complete metrics object including bandwidth, NAT type, latency, stability, and device metrics

##### measureBandwidth(): Promise<BandwidthMetrics>

Measures current upload and download bandwidth using test packets.

**Returns:** Bandwidth metrics with confidence score

##### detectNATType(): Promise<NATType>

Detects the NAT type using STUN server interactions.

**Returns:** NAT type enum value (OPEN, FULL_CONE, RESTRICTED, PORT_RESTRICTED, or SYMMETRIC)

##### updateLatency(participantId: string, rtt: number): void

Updates latency measurements for a specific participant.

##### updateStability(stats: RTCStatsReport): void

Updates stability metrics from WebRTC connection statistics.

##### onMetricsUpdate(callback: (metrics: ParticipantMetrics) => void): void

Subscribes to periodic metrics updates.

**Example:**
```typescript
const collector = new MetricsCollector({ participantId: 'user-123' });
await collector.startCollection();

collector.onMetricsUpdate((metrics) => {
  console.log(`Bandwidth: ${metrics.bandwidth.uploadMbps} Mbps up`);
  console.log(`NAT Type: ${NATType[metrics.natType]}`);
});
```

---

### SelectionAlgorithm

Implements the relay node selection algorithm based on participant metrics.

#### Methods

##### calculateScore(metrics: ParticipantMetrics, config: SelectionConfig): RelayScore

Calculates a relay suitability score for a participant.

**Returns:** Score breakdown including total score and individual component scores

**Example:**
```typescript
const algorithm = new SelectionAlgorithm();
const score = algorithm.calculateScore(metrics, config);
console.log(`Total score: ${score.totalScore}`);
```


##### selectRelayNodes(allMetrics: Map<string, ParticipantMetrics>, config: SelectionConfig): string[]

Selects optimal relay nodes from all participants based on their metrics.

**Returns:** Array of participant IDs selected as relay nodes

**Example:**
```typescript
const relayIds = algorithm.selectRelayNodes(metricsMap, config);
console.log(`Selected ${relayIds.length} relay nodes`);
```

##### shouldDemote(relayId: string, currentMetrics: ParticipantMetrics, config: SelectionConfig): boolean

Determines if a relay node should be demoted based on degraded metrics.

**Returns:** true if relay should be demoted

##### calculateOptimalRelayCount(participantCount: number): number

Calculates the optimal number of relay nodes for a given participant count using sqrt formula.

**Returns:** Recommended number of relay nodes

---

### TopologyManager

Manages the formation and maintenance of connection topology.

#### Methods

##### formTopology(relayNodeIds: string[], allParticipants: string[], latencyMap: Map<string, Map<string, number>>): ConnectionTopology

Forms initial topology by organizing participants into groups around relay nodes.

**Returns:** Complete connection topology

**Example:**
```typescript
const manager = new TopologyManager();
const topology = manager.formTopology(
  ['relay1', 'relay2'],
  ['relay1', 'relay2', 'user1', 'user2', 'user3'],
  latencyMap
);
```

##### assignToRelay(participantId: string, relayNodeIds: string[], latencyMap: Map<string, number>, currentGroups: ParticipantGroup[]): string

Assigns a regular node to the optimal relay node based on latency and load.

**Returns:** ID of the assigned relay node

##### handleJoin(participantId: string, currentTopology: ConnectionTopology, metrics: ParticipantMetrics): ConnectionTopology

Integrates a new participant into the existing topology.

**Returns:** Updated topology

##### handleLeave(participantId: string, currentTopology: ConnectionTopology): ConnectionTopology

Removes a participant from the topology and updates connections.

**Returns:** Updated topology


##### handleRelayFailure(failedRelayId: string, currentTopology: ConnectionTopology, allMetrics: Map<string, ParticipantMetrics>): ConnectionTopology

Handles relay node failure by selecting a replacement or redistributing participants.

**Returns:** Updated topology with failover complete

##### balanceLoad(currentTopology: ConnectionTopology, latencyMap: Map<string, Map<string, number>>): ConnectionTopology

Balances participant load across relay nodes.

**Returns:** Rebalanced topology

---

### MediaHandler

Manages WebRTC peer connections and media streams.

#### Constructor

```typescript
constructor(participantId: string)
```

#### Methods

##### initializeLocalMedia(constraints: MediaStreamConstraints): Promise<MediaStream>

Initializes local camera and microphone capture.

**Example:**
```typescript
const handler = new MediaHandler('user-123');
const localStream = await handler.initializeLocalMedia({
  audio: true,
  video: { width: 1280, height: 720 }
});
```

##### createPeerConnection(remoteParticipantId: string, config: PeerConnectionConfig): Promise<RTCPeerConnection>

Creates a WebRTC peer connection to another participant.

**Returns:** The created peer connection

##### addLocalStream(peerConnection: RTCPeerConnection, stream: MediaStream): void

Adds local media stream to a peer connection.

##### onRemoteStream(callback: (stream: MediaStream) => void): void

Subscribes to remote stream events.

**Example:**
```typescript
handler.onRemoteStream((stream) => {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.play();
});
```

##### adaptBitrate(peerConnection: RTCPeerConnection, targetBitrate: number): Promise<void>

Adapts the encoding bitrate based on network conditions.


##### closePeerConnection(remoteParticipantId: string): void

Closes and cleans up a peer connection.

##### getConnectionStats(remoteParticipantId: string): Promise<RTCStatsReport>

Gets connection statistics for monitoring.

**Returns:** WebRTC statistics report

---

### RelayEngine

Handles media packet forwarding for relay nodes.

#### Methods

##### startRelay(): void

Starts relay functionality (only called on relay nodes).

##### stopRelay(): void

Stops relay functionality.

##### configureRoutes(incomingFromRegular: string[], outgoingToRelays: string[], incomingFromRelays: string[], outgoingToRegular: string[]): void

Configures routing table for media forwarding.

**Parameters:**
- `incomingFromRegular`: Regular nodes in this relay's group
- `outgoingToRelays`: Other relay nodes to forward to
- `incomingFromRelays`: Other relay nodes to receive from
- `outgoingToRegular`: Regular nodes in this relay's group to forward to

**Example:**
```typescript
const engine = new RelayEngine();
engine.startRelay();
engine.configureRoutes(
  ['user1', 'user2'],  // Regular nodes in my group
  ['relay2', 'relay3'], // Other relays
  ['relay2', 'relay3'], // Other relays
  ['user1', 'user2']    // Regular nodes in my group
);
```

##### getRelayStats(): RelayStats

Gets relay performance statistics.

**Returns:** Statistics including packets received, forwarded, dropped, and latency

---

### SignalingClient

Manages WebSocket connection to the signaling server.

#### Constructor

```typescript
constructor(config: {
  serverUrl: string;
  participantId: string;
  participantName: string;
  enforceSecureConnection?: boolean;
})
```


#### Methods

##### connect(): Promise<void>

Establishes WebSocket connection to the signaling server.

##### disconnect(): void

Closes the WebSocket connection.

##### sendJoin(conferenceId: string): Promise<void>

Sends a join message to join a conference.

##### sendLeave(participantId: string): Promise<void>

Sends a leave message to exit a conference.

##### broadcastMetrics(metrics: ParticipantMetrics): void

Broadcasts metrics to other participants.

##### sendTopologyUpdate(topology: ConnectionTopology, reason: string): void

Sends a topology update to all participants.

#### Events

- `connected`: Fired when WebSocket connection is established
- `disconnected`: Fired when WebSocket connection is closed
- `message`: Fired when a signaling message is received

---

## Server API

### RelayMeshServer

The main server class that manages signaling and conference coordination.

#### Constructor

```typescript
constructor(config?: RelayMeshServerConfig)
```

**Parameters:**
- `config.port` (number, optional): Server port (default: 8080)
- `config.host` (string, optional): Server host (default: '0.0.0.0')
- `config.tlsEnabled` (boolean, optional): Enable TLS (default: false)
- `config.tlsCertPath` (string, optional): Path to TLS certificate
- `config.tlsKeyPath` (string, optional): Path to TLS private key
- `config.authRequired` (boolean, optional): Require authentication (default: false)
- `config.authProvider` (AuthProvider, optional): Custom authentication provider
- `config.maxConferences` (number, optional): Maximum concurrent conferences (default: 100)
- `config.maxParticipantsPerConference` (number, optional): Maximum participants per conference (default: 50)

**Example:**
```typescript
import { RelayMeshServer } from 'relay-mesh';

const server = new RelayMeshServer({
  port: 8443,
  tlsEnabled: true,
  tlsCertPath: '/path/to/cert.pem',
  tlsKeyPath: '/path/to/key.pem',
  authRequired: true
});
```


#### Methods

##### start(): Promise<void>

Starts the signaling server.

**Example:**
```typescript
await server.start();
console.log('Server is running');
```

##### stop(): Promise<void>

Stops the signaling server.

**Example:**
```typescript
await server.stop();
```

##### getServerInfo(): ServerInfo

Gets server status information.

**Returns:** Object containing port, host, TLS status, active conferences, total participants, and uptime

**Example:**
```typescript
const info = server.getServerInfo();
console.log(`Server has ${info.activeConferences} active conferences`);
console.log(`Total participants: ${info.totalParticipants}`);
```

##### getConferenceInfo(conferenceId: string): { topology: ConnectionTopology | null, participants: string[] }

Gets information about a specific conference.

**Returns:** Conference topology and participant list

##### isParticipantConnected(participantId: string): boolean

Checks if a participant is currently connected.

##### isParticipantAuthenticated(participantId: string): boolean

Checks if a participant has been authenticated.

##### getStatus(): { running: boolean, uptime: number, conferences: number, participants: number }

Gets current server status.

#### Events

- `started`: Fired when server starts successfully
- `stopped`: Fired when server stops

#### Convenience Function

```typescript
async function createServer(config?: RelayMeshServerConfig): Promise<RelayMeshServer>
```

Creates and starts a server in one call.

**Example:**
```typescript
import { createServer } from 'relay-mesh';

const server = await createServer({ port: 8443 });
```

---


### SignalingServer

Low-level signaling server implementation (typically used via RelayMeshServer).

#### Constructor

```typescript
constructor(config: SignalingServerConfig)
```

**Parameters:**
- `config.port` (number): Server port
- `config.enforceTLS` (boolean, optional): Require TLS connections
- `config.tlsOptions` (object, optional): TLS certificate and key
- `config.requireAuth` (boolean, optional): Require authentication
- `config.authProvider` (AuthProvider, optional): Authentication provider

#### Methods

##### start(): Promise<void>

Starts the WebSocket server.

##### stop(): Promise<void>

Stops the WebSocket server.

##### getServerInfo(): { port: number, tlsEnabled: boolean, activeConnections: number, activeConferences: number }

Gets server information.

##### getConferenceTopology(conferenceId: string): ConnectionTopology | null

Gets the topology for a specific conference.

##### getConferenceParticipants(conferenceId: string): string[]

Gets the list of participants in a conference.

##### isParticipantConnected(participantId: string): boolean

Checks if a participant is connected.

##### isParticipantAuthenticated(participantId: string): boolean

Checks if a participant is authenticated.

---

## Shared Types

### Data Models

#### ParticipantMetrics

Complete metrics for a participant used in relay selection.

```typescript
interface ParticipantMetrics {
  participantId: string;
  timestamp: number;
  bandwidth: BandwidthMetrics;
  natType: NATType;
  latency: LatencyMetrics;
  stability: StabilityMetrics;
  device: DeviceMetrics;
}
```


#### BandwidthMetrics

```typescript
interface BandwidthMetrics {
  uploadMbps: number;          // Upload bandwidth in Mbps
  downloadMbps: number;        // Download bandwidth in Mbps
  measurementConfidence: number; // 0-1 confidence score
}
```

#### NATType

```typescript
enum NATType {
  OPEN = 0,           // No NAT, public IP
  FULL_CONE = 1,      // Most permissive NAT
  RESTRICTED = 2,     // Restricted cone NAT
  PORT_RESTRICTED = 3, // Port-restricted cone NAT
  SYMMETRIC = 4       // Most restrictive, requires TURN
}
```

#### LatencyMetrics

```typescript
interface LatencyMetrics {
  averageRttMs: number;                    // Average round-trip time
  minRttMs: number;                        // Minimum RTT observed
  maxRttMs: number;                        // Maximum RTT observed
  measurements: Map<string, number>;       // Per-participant RTT map
}
```

#### StabilityMetrics

```typescript
interface StabilityMetrics {
  packetLossPercent: number;  // Packet loss percentage
  jitterMs: number;           // Jitter in milliseconds
  connectionUptime: number;   // Connection uptime in seconds
  reconnectionCount: number;  // Number of reconnections
}
```

#### DeviceMetrics

```typescript
interface DeviceMetrics {
  cpuUsagePercent: number;           // CPU usage percentage
  availableMemoryMB: number;         // Available memory in MB
  supportedCodecs: string[];         // Supported video/audio codecs
  hardwareAcceleration: boolean;     // Hardware acceleration available
}
```

#### ConnectionTopology

```typescript
interface ConnectionTopology {
  version: number;                           // Topology version number
  timestamp: number;                         // Creation timestamp
  relayNodes: string[];                      // List of relay node IDs
  groups: ParticipantGroup[];                // Participant groups
  relayConnections: Array<[string, string]>; // Relay-to-relay connections
}
```


#### ParticipantGroup

```typescript
interface ParticipantGroup {
  relayNodeId: string;      // ID of the relay node for this group
  regularNodeIds: string[]; // IDs of regular nodes in this group
}
```

#### Participant

```typescript
interface Participant {
  id: string;
  name: string;
  role: 'relay' | 'regular';
  metrics: ParticipantMetrics;
  connections: Map<string, RTCPeerConnection>;
  assignedRelayId?: string;  // Only for regular nodes
  groupMembers?: string[];   // Only for relay nodes
  joinedAt: number;
  lastSeen: number;
}
```

#### Conference

```typescript
interface Conference {
  id: string;
  participants: Map<string, Participant>;
  topology: ConnectionTopology;
  config: SelectionConfig;
  createdAt: number;
  lastTopologyUpdate: number;
}
```

---

### Configuration

#### SelectionConfig

Configuration for relay node selection algorithm.

```typescript
interface SelectionConfig {
  bandwidthWeight: number;        // Weight for bandwidth score (default: 0.30)
  natWeight: number;              // Weight for NAT type score (default: 0.25)
  latencyWeight: number;          // Weight for latency score (default: 0.20)
  stabilityWeight: number;        // Weight for stability score (default: 0.15)
  deviceWeight: number;           // Weight for device score (default: 0.10)
  minBandwidthMbps: number;       // Minimum bandwidth for relay eligibility (default: 5)
  maxParticipantsPerRelay: number; // Maximum participants per relay (default: 5)
  reevaluationIntervalMs: number; // Metrics re-evaluation interval (default: 30000)
}
```

**Default Values:**
```typescript
const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  bandwidthWeight: 0.30,
  natWeight: 0.25,
  latencyWeight: 0.20,
  stabilityWeight: 0.15,
  deviceWeight: 0.10,
  minBandwidthMbps: 5,
  maxParticipantsPerRelay: 5,
  reevaluationIntervalMs: 30000
};
```


#### PeerConnectionConfig

Configuration for WebRTC peer connections.

```typescript
interface PeerConnectionConfig {
  iceServers: RTCIceServer[];           // STUN/TURN servers
  iceTransportPolicy: RTCIceTransportPolicy; // 'all' or 'relay'
  bundlePolicy?: RTCBundlePolicy;       // Bundle policy (default: 'max-bundle')
  rtcpMuxPolicy?: RTCRtcpMuxPolicy;     // RTCP mux policy (default: 'require')
}
```

**Default Values:**
```typescript
const DEFAULT_PEER_CONNECTION_CONFIG: PeerConnectionConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};
```

#### RelayMeshConfig

Complete configuration for the RelayMesh system.

```typescript
interface RelayMeshConfig {
  selection: SelectionConfig;
  peerConnection: PeerConnectionConfig;
  connectionTimeouts?: {
    iceGatheringTimeoutMs?: number;
    connectionEstablishmentTimeoutMs?: number;
    reconnectionTimeoutMs?: number;
  };
}
```

---

### Signaling Messages

All signaling messages extend the base SignalingMessage interface:

```typescript
interface SignalingMessage {
  type: string;
  from: string;
  timestamp: number;
}
```

#### JoinMessage

```typescript
interface JoinMessage extends SignalingMessage {
  type: 'join';
  conferenceId: string;
  participantInfo: {
    id: string;
    name: string;
  };
  auth?: {
    token: string;
    timestamp: number;
  };
}
```

#### TopologyUpdateMessage

```typescript
interface TopologyUpdateMessage extends SignalingMessage {
  type: 'topology-update';
  topology: ConnectionTopology;
  reason: 'relay-selection' | 'participant-join' | 'participant-leave' | 'relay-failure';
}
```


#### MetricsBroadcastMessage

```typescript
interface MetricsBroadcastMessage extends SignalingMessage {
  type: 'metrics-broadcast';
  metrics: ParticipantMetrics;
}
```

#### WebRTCOfferMessage

```typescript
interface WebRTCOfferMessage extends SignalingMessage {
  type: 'webrtc-offer';
  to: string;
  offer: RTCSessionDescriptionInit;
}
```

#### WebRTCAnswerMessage

```typescript
interface WebRTCAnswerMessage extends SignalingMessage {
  type: 'webrtc-answer';
  to: string;
  answer: RTCSessionDescriptionInit;
}
```

#### ICECandidateMessage

```typescript
interface ICECandidateMessage extends SignalingMessage {
  type: 'ice-candidate';
  to: string;
  candidate: RTCIceCandidateInit;
}
```

#### RelayAssignmentMessage

```typescript
interface RelayAssignmentMessage extends SignalingMessage {
  type: 'relay-assignment';
  assignedRelayId: string;
  role: 'relay' | 'regular';
}
```

---

## Configuration Management

### ConfigurationManager

Manages loading and validation of configuration from multiple sources.

#### Constructor

```typescript
constructor(configFilePath?: string)
```

Loads configuration with the following precedence (highest to lowest):
1. Environment variables
2. Configuration file (if provided)
3. Default values

#### Methods

##### getConfig(): RelayMeshConfig

Gets the complete merged configuration.

##### getSelectionConfig(): SelectionConfig

Gets the selection algorithm configuration.

##### getPeerConnectionConfig(): PeerConnectionConfig

Gets the peer connection configuration.

##### getConnectionTimeouts(): Required<RelayMeshConfig['connectionTimeouts']>

Gets the connection timeout configuration.


##### updateConfig(partial: PartialRelayMeshConfig): void

Updates configuration at runtime (useful for testing or dynamic adjustment).

#### Environment Variables

Configuration can be set via environment variables:

- `RELAYMESH_BANDWIDTH_WEIGHT`: Bandwidth weight (0-1)
- `RELAYMESH_NAT_WEIGHT`: NAT type weight (0-1)
- `RELAYMESH_LATENCY_WEIGHT`: Latency weight (0-1)
- `RELAYMESH_STABILITY_WEIGHT`: Stability weight (0-1)
- `RELAYMESH_DEVICE_WEIGHT`: Device weight (0-1)
- `RELAYMESH_MIN_BANDWIDTH_MBPS`: Minimum bandwidth in Mbps
- `RELAYMESH_MAX_PARTICIPANTS_PER_RELAY`: Maximum participants per relay
- `RELAYMESH_REEVALUATION_INTERVAL_MS`: Re-evaluation interval in milliseconds
- `RELAYMESH_ICE_GATHERING_TIMEOUT_MS`: ICE gathering timeout
- `RELAYMESH_CONNECTION_ESTABLISHMENT_TIMEOUT_MS`: Connection establishment timeout
- `RELAYMESH_RECONNECTION_TIMEOUT_MS`: Reconnection timeout

**Example:**
```bash
export RELAYMESH_MIN_BANDWIDTH_MBPS=10
export RELAYMESH_MAX_PARTICIPANTS_PER_RELAY=7
node server.js
```

#### Configuration File

Configuration can also be loaded from a JSON file:

```json
{
  "selection": {
    "bandwidthWeight": 0.35,
    "natWeight": 0.25,
    "latencyWeight": 0.20,
    "stabilityWeight": 0.10,
    "deviceWeight": 0.10,
    "minBandwidthMbps": 10,
    "maxParticipantsPerRelay": 7,
    "reevaluationIntervalMs": 20000
  },
  "connectionTimeouts": {
    "iceGatheringTimeoutMs": 15000,
    "connectionEstablishmentTimeoutMs": 45000,
    "reconnectionTimeoutMs": 10000
  }
}
```

**Usage:**
```typescript
import { createConfigurationManager } from 'relay-mesh';

const configManager = createConfigurationManager('./config.json');
const config = configManager.getConfig();
```

---

## Error Handling

### ConfigValidationError

Thrown when configuration validation fails.

```typescript
class ConfigValidationError extends Error {
  field: string;    // The configuration field that failed
  value: any;       // The invalid value
  reason: string;   // Why validation failed
}
```

**Example:**
```typescript
try {
  const config = new ConfigurationManager('./config.json');
} catch (error) {
  if (error instanceof ConfigValidationError) {
    console.error(`Invalid ${error.field}: ${error.reason}`);
  }
}
```

---

## Complete Examples

### Basic Client Usage

```typescript
import { RelayMeshClient } from 'relay-mesh';

// Create client
const client = new RelayMeshClient({
  signalingServerUrl: 'wss://signaling.example.com',
  participantName: 'Alice'
});

// Listen for events
client.on('stateChange', (event) => {
  console.log(`State: ${event.from} -> ${event.to}`);
});

client.on('remoteStream', (stream) => {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.play();
  document.body.appendChild(video);
});

client.on('roleChange', (role) => {
  console.log(`My role: ${role}`);
});

// Join conference
try {
  const info = await client.joinConference('my-conference');
  console.log(`Joined as ${info.role}`);
} catch (error) {
  console.error('Failed to join:', error);
}

// Later: leave conference
await client.leaveConference();
```

### Basic Server Usage

```typescript
import { createServer } from 'relay-mesh';

// Create and start server
const server = await createServer({
  port: 8443,
  tlsEnabled: true,
  tlsCertPath: './cert.pem',
  tlsKeyPath: './key.pem',
  authRequired: false
});

// Monitor server
setInterval(() => {
  const status = server.getStatus();
  console.log(`Conferences: ${status.conferences}, Participants: ${status.participants}`);
}, 10000);

// Graceful shutdown
process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});
```

### Custom Configuration

```typescript
import { RelayMeshClient, createConfigurationManager } from 'relay-mesh';

// Load custom configuration
const configManager = createConfigurationManager('./my-config.json');

// Create client with custom config
const client = new RelayMeshClient({
  signalingServerUrl: 'wss://signaling.example.com',
  participantName: 'Bob',
  selectionConfig: configManager.getSelectionConfig(),
  peerConnectionConfig: configManager.getPeerConnectionConfig()
});

await client.joinConference('conference-123');
```

---

## See Also

- [Configuration Guide](./CONFIGURATION.md) - Detailed configuration documentation
- [Deployment Guide](./DEPLOYMENT.md) - Server setup and deployment instructions
- [Examples](../examples/) - Complete example applications
