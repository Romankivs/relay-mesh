# Design Document: RelayMesh

## Overview

RelayMesh is a decentralized WebRTC video conferencing system that eliminates centralized media servers by enabling clients to autonomously form connection topologies with dynamically selected relay nodes. The system consists of client-side components for metrics collection, relay selection, topology management, and media handling, coordinated through a lightweight signaling server.

The architecture follows a hybrid approach: while signaling remains centralized for coordination, all media traffic flows peer-to-peer through a dynamically optimized topology. Selected participants with optimal characteristics (bandwidth, NAT type, latency, stability, device capabilities) act as relay nodes, retransmitting media streams to reduce per-participant connection counts and enable better scalability than traditional mesh architecture.

### Key Design Principles

1. **Decentralized Media Flow**: No central media server; all streams flow through peer connections
2. **Dynamic Adaptation**: Topology and relay assignments adapt to changing network conditions
3. **Autonomous Operation**: Clients collectively maintain topology without central control
4. **Graceful Degradation**: System continues operating when relay nodes fail
5. **Minimal Signaling**: Signaling server only coordinates; doesn't handle media

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Signaling Server                         │
│  - WebSocket connections to all participants                 │
│  - Topology state coordination                               │
│  - WebRTC signaling (offer/answer/ICE)                      │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ WebSocket (signaling only)
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
┌───────▼────────┐  ┌──────▼───────┐  ┌───────▼────────┐
│  Participant A  │  │ Participant B │  │ Participant C  │
│  (Relay Node)   │  │ (Regular)     │  │ (Relay Node)   │
├────────────────┤  ├──────────────┤  ├────────────────┤
│ • Metrics      │  │ • Metrics    │  │ • Metrics      │
│   Collector    │  │   Collector  │  │   Collector    │
│ • Selection    │  │ • Selection  │  │ • Selection    │
│   Algorithm    │  │   Algorithm  │  │   Algorithm    │
│ • Topology     │  │ • Topology   │  │ • Topology     │
│   Manager      │  │   Manager    │  │   Manager      │
│ • Media        │  │ • Media      │  │ • Media        │
│   Handler      │  │   Handler    │  │   Handler      │
│ • Relay        │  │              │  │ • Relay        │
│   Engine       │  │              │  │   Engine       │
└────────────────┘  └──────────────┘  └────────────────┘
        │                   │                   │
        └───────────────────┴───────────────────┘
              WebRTC Peer Connections (media)
```

### Component Responsibilities

**Signaling Server**:

- Maintains WebSocket connections to all participants
- Broadcasts topology updates to affected participants
- Facilitates WebRTC offer/answer/ICE candidate exchange
- Stores current topology state for new joiners
- Does NOT handle any media traffic

**Metrics Collector** (client-side):

- Measures available upload/download bandwidth using test packets
- Detects NAT type through STUN server interactions
- Monitors RTT (round-trip time) to other participants via RTCP
- Tracks packet loss and jitter for connection stability
- Assesses device CPU/memory usage and codec capabilities
- Periodically updates metrics (default: every 30 seconds)

**Selection Algorithm** (client-side, consensus-based):

- Runs on all participants to reach consensus on relay nodes
- Scores each participant based on weighted metrics
- Selects top N participants as relay nodes (N based on participant count)
- Re-evaluates periodically or when significant metric changes occur
- Uses deterministic algorithm so all clients reach same conclusion

**Topology Manager** (client-side, consensus-based):

- Forms participant groups around selected relay nodes
- Assigns regular nodes to relay nodes based on network proximity (latency)
- Balances load across relay nodes
- Establishes relay-to-relay connections for inter-group communication
- Handles topology updates when participants join/leave or relay nodes change

**Media Handler** (client-side):

- Manages WebRTC peer connections
- Handles local media capture (camera/microphone)
- Renders received media streams
- Adapts bitrate based on network conditions

**Relay Engine** (client-side, only on relay nodes):

- Receives media streams from regular nodes in assigned group
- Forwards streams to other relay nodes
- Receives streams from other relay nodes
- Forwards streams to regular nodes in assigned group
- Maintains packet forwarding tables for efficient routing

## Components and Interfaces

### Metrics Collector Interface

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

interface BandwidthMetrics {
  uploadMbps: number;
  downloadMbps: number;
  measurementConfidence: number; // 0-1
}

enum NATType {
  OPEN = 0, // No NAT, public IP
  FULL_CONE = 1, // Most permissive NAT
  RESTRICTED = 2, // Restricted cone NAT
  PORT_RESTRICTED = 3, // Port-restricted cone NAT
  SYMMETRIC = 4, // Most restrictive, requires TURN
}

interface LatencyMetrics {
  averageRttMs: number;
  minRttMs: number;
  maxRttMs: number;
  measurements: Map<string, number>; // participantId -> RTT
}

interface StabilityMetrics {
  packetLossPercent: number;
  jitterMs: number;
  connectionUptime: number; // seconds
  reconnectionCount: number;
}

interface DeviceMetrics {
  cpuUsagePercent: number;
  availableMemoryMB: number;
  supportedCodecs: string[];
  hardwareAcceleration: boolean;
}

interface MetricsCollector {
  // Start collecting metrics for this participant
  startCollection(): Promise<void>;

  // Get current metrics snapshot
  getCurrentMetrics(): ParticipantMetrics;

  // Measure bandwidth using test packets
  measureBandwidth(): Promise<BandwidthMetrics>;

  // Detect NAT type using STUN
  detectNATType(): Promise<NATType>;

  // Update latency measurements from RTCP reports
  updateLatency(participantId: string, rtt: number): void;

  // Update stability metrics from connection stats
  updateStability(stats: RTCStatsReport): void;

  // Subscribe to metrics updates
  onMetricsUpdate(callback: (metrics: ParticipantMetrics) => void): void;
}
```

### Selection Algorithm Interface

```typescript
interface RelayScore {
  participantId: string;
  totalScore: number;
  bandwidthScore: number;
  natScore: number;
  latencyScore: number;
  stabilityScore: number;
  deviceScore: number;
}

interface SelectionConfig {
  bandwidthWeight: number; // default: 0.30
  natWeight: number; // default: 0.25
  latencyWeight: number; // default: 0.20
  stabilityWeight: number; // default: 0.15
  deviceWeight: number; // default: 0.10
  minBandwidthMbps: number; // default: 5
  maxParticipantsPerRelay: number; // default: 5
  reevaluationIntervalMs: number; // default: 30000
}

interface SelectionAlgorithm {
  // Calculate relay score for a participant
  calculateScore(metrics: ParticipantMetrics, config: SelectionConfig): RelayScore;

  // Select optimal relay nodes from all participants
  selectRelayNodes(allMetrics: Map<string, ParticipantMetrics>, config: SelectionConfig): string[]; // Returns array of participant IDs

  // Determine if a relay node should be demoted
  shouldDemote(
    relayId: string,
    currentMetrics: ParticipantMetrics,
    config: SelectionConfig
  ): boolean;

  // Calculate optimal number of relay nodes for participant count
  calculateOptimalRelayCount(participantCount: number): number;
}
```

### Topology Manager Interface

```typescript
interface ParticipantGroup {
  relayNodeId: string;
  regularNodeIds: string[];
}

interface ConnectionTopology {
  version: number;
  timestamp: number;
  relayNodes: string[];
  groups: ParticipantGroup[];
  relayConnections: Array<[string, string]>; // relay-to-relay connections
}

interface TopologyManager {
  // Form initial topology from relay node selection
  formTopology(
    relayNodeIds: string[],
    allParticipants: string[],
    latencyMap: Map<string, Map<string, number>>
  ): ConnectionTopology;

  // Assign a regular node to optimal relay node
  assignToRelay(
    participantId: string,
    relayNodeIds: string[],
    latencyMap: Map<string, number>,
    currentGroups: ParticipantGroup[]
  ): string; // Returns relay node ID

  // Handle participant joining
  handleJoin(
    participantId: string,
    currentTopology: ConnectionTopology,
    metrics: ParticipantMetrics
  ): ConnectionTopology;

  // Handle participant leaving
  handleLeave(participantId: string, currentTopology: ConnectionTopology): ConnectionTopology;

  // Handle relay node failure
  handleRelayFailure(
    failedRelayId: string,
    currentTopology: ConnectionTopology,
    allMetrics: Map<string, ParticipantMetrics>
  ): ConnectionTopology;

  // Balance load across relay nodes
  balanceLoad(
    currentTopology: ConnectionTopology,
    latencyMap: Map<string, Map<string, number>>
  ): ConnectionTopology;
}
```

### Media Handler Interface

```typescript
interface MediaStream {
  streamId: string;
  participantId: string;
  tracks: MediaStreamTrack[];
  isLocal: boolean;
}

interface PeerConnectionConfig {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
}

interface MediaHandler {
  // Initialize local media capture
  initializeLocalMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;

  // Create peer connection to another participant
  createPeerConnection(
    remoteParticipantId: string,
    config: PeerConnectionConfig
  ): Promise<RTCPeerConnection>;

  // Add local stream to peer connection
  addLocalStream(peerConnection: RTCPeerConnection, stream: MediaStream): void;

  // Handle received remote stream
  onRemoteStream(callback: (stream: MediaStream) => void): void;

  // Adapt bitrate based on network conditions
  adaptBitrate(peerConnection: RTCPeerConnection, targetBitrate: number): Promise<void>;

  // Close peer connection
  closePeerConnection(remoteParticipantId: string): void;

  // Get connection statistics
  getConnectionStats(remoteParticipantId: string): Promise<RTCStatsReport>;
}
```

### Relay Engine Interface

```typescript
interface RelayRoute {
  sourceParticipantId: string;
  destinationParticipantIds: string[];
}

interface RelayEngine {
  // Start relay functionality
  startRelay(): void;

  // Stop relay functionality
  stopRelay(): void;

  // Configure routing table for media forwarding
  configureRoutes(
    incomingFromRegular: string[], // Regular nodes in my group
    outgoingToRelays: string[], // Other relay nodes
    incomingFromRelays: string[], // Other relay nodes
    outgoingToRegular: string[] // Regular nodes in my group
  ): void;

  // Forward media packet
  forwardPacket(packet: RTCRtpPacket, sourceId: string): void;

  // Get relay statistics
  getRelayStats(): RelayStats;
}

interface RelayStats {
  packetsReceived: number;
  packetsForwarded: number;
  packetsDropped: number;
  averageForwardingLatencyMs: number;
  currentLoad: number; // 0-1
}
```

### Signaling Protocol

```typescript
// Message types exchanged via WebSocket

interface SignalingMessage {
  type: string;
  from: string;
  timestamp: number;
}

interface JoinMessage extends SignalingMessage {
  type: 'join';
  conferenceId: string;
  participantInfo: {
    id: string;
    name: string;
  };
}

interface TopologyUpdateMessage extends SignalingMessage {
  type: 'topology-update';
  topology: ConnectionTopology;
  reason: 'relay-selection' | 'participant-join' | 'participant-leave' | 'relay-failure';
}

interface MetricsBroadcastMessage extends SignalingMessage {
  type: 'metrics-broadcast';
  metrics: ParticipantMetrics;
}

interface WebRTCOfferMessage extends SignalingMessage {
  type: 'webrtc-offer';
  to: string;
  offer: RTCSessionDescriptionInit;
}

interface WebRTCAnswerMessage extends SignalingMessage {
  type: 'webrtc-answer';
  to: string;
  answer: RTCSessionDescriptionInit;
}

interface ICECandidateMessage extends SignalingMessage {
  type: 'ice-candidate';
  to: string;
  candidate: RTCIceCandidateInit;
}

interface RelayAssignmentMessage extends SignalingMessage {
  type: 'relay-assignment';
  assignedRelayId: string;
  role: 'relay' | 'regular';
}
```

## Data Models

### Participant State

```typescript
interface Participant {
  id: string;
  name: string;
  role: 'relay' | 'regular';
  metrics: ParticipantMetrics;
  connections: Map<string, RTCPeerConnection>; // participantId -> connection
  assignedRelayId?: string; // Only for regular nodes
  groupMembers?: string[]; // Only for relay nodes
  joinedAt: number;
  lastSeen: number;
}
```

### Conference State

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

### Relay Selection Algorithm Details

The selection algorithm uses a weighted scoring system:

**Score Calculation**:

```
totalScore = (bandwidthScore * bandwidthWeight) +
             (natScore * natWeight) +
             (latencyScore * latencyWeight) +
             (stabilityScore * stabilityWeight) +
             (deviceScore * deviceWeight)
```

**Individual Score Components** (all normalized to 0-1):

1. **Bandwidth Score**:

   ```
   bandwidthScore = min(uploadMbps / 20, 1.0) * 0.7 +
                    min(downloadMbps / 50, 1.0) * 0.3
   ```

   - Prioritizes upload bandwidth (relay nodes send more than receive)
   - Caps at 20 Mbps upload, 50 Mbps download for normalization

2. **NAT Score**:

   ```
   natScore = (4 - natType) / 4
   ```

   - OPEN (0) → score 1.0
   - FULL_CONE (1) → score 0.75
   - RESTRICTED (2) → score 0.5
   - PORT_RESTRICTED (3) → score 0.25
   - SYMMETRIC (4) → score 0.0

3. **Latency Score**:

   ```
   averageLatency = mean(latencyMap.values())
   latencyScore = max(0, 1 - (averageLatency / 200))
   ```

   - Lower average latency to other participants = higher score
   - Normalizes around 200ms threshold

4. **Stability Score**:

   ```
   stabilityScore = (1 - packetLossPercent / 100) * 0.4 +
                    max(0, 1 - (jitterMs / 50)) * 0.3 +
                    min(connectionUptime / 300, 1.0) * 0.2 +
                    max(0, 1 - (reconnectionCount / 5)) * 0.1
   ```

   - Combines packet loss, jitter, uptime, and reconnection history
   - Favors stable, long-running connections

5. **Device Score**:
   ```
   deviceScore = (1 - cpuUsagePercent / 100) * 0.4 +
                 min(availableMemoryMB / 2048, 1.0) * 0.3 +
                 (supportedCodecs.length / 10) * 0.2 +
                 (hardwareAcceleration ? 1.0 : 0.5) * 0.1
   ```

   - Favors devices with available resources and capabilities

**Relay Count Calculation**:

```
optimalRelayCount = ceil(sqrt(participantCount))
```

- For 4 participants: 2 relays
- For 9 participants: 3 relays
- For 16 participants: 4 relays
- For 25 participants: 5 relays

**Eligibility Filter**:

- Participant must have uploadMbps >= minBandwidthMbps (default: 5)
- Participant must not be SYMMETRIC NAT (unless all participants are)
- Participant must have connectionUptime >= 30 seconds (prevents new joiners)

### Topology Formation Algorithm

**Group Assignment Process**:

1. **Initial Assignment**:
   - For each regular node, calculate latency to each relay node
   - Assign to relay with minimum latency
   - If relay is at capacity (maxParticipantsPerRelay), assign to next best

2. **Load Balancing**:
   - Calculate load factor for each relay: `currentMembers / maxParticipantsPerRelay`
   - If any relay has load > 0.8 and another has load < 0.5:
     - Find regular node with highest latency in overloaded relay
     - Reassign to underloaded relay if latency increase < 50ms

3. **Relay-to-Relay Connections**:
   - Form full mesh between all relay nodes
   - Each relay maintains connections to all other relays
   - Enables any-to-any media forwarding

**Topology Update Triggers**:

- Participant joins or leaves
- Relay node selection changes
- Relay node fails or becomes unavailable
- Manual rebalancing (periodic, every 5 minutes)

## Correctness Properties

_A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees._

### Property Reflection

After analyzing all acceptance criteria, I've identified several areas where properties can be consolidated:

**Metrics Collection (2.1-2.7)**: Properties 2.1, 2.2, 2.5 all test that specific metrics are collected on join. These can be combined into one property that verifies all required metrics are collected. Properties 2.3, 2.4, 2.6 test continuous monitoring and can be combined into one property about periodic updates.

**Selection Prioritization (3.2-3.6)**: These five properties all test that the scoring algorithm correctly prioritizes different metrics. They can be combined into comprehensive properties about monotonicity of the scoring function.

**Topology Formation (4.1-4.4)**: Properties about group formation, assignment, and relay connections can be consolidated into properties about topology invariants.

**Relay Forwarding (5.1-5.2)**: Both test forwarding behavior and can be combined into one property about correct routing.

**Regular Node Behavior (6.1-6.3)**: These test basic regular node operations and can be combined into properties about correct media flow.

**Configuration (13.1-13.6)**: All test configuration capabilities and can be consolidated into fewer properties about configuration application.

**Monitoring (14.1-14.6)**: All test observability and can be consolidated into properties about state exposure.

### Core Correctness Properties

Property 1: **Metrics Collection Completeness**
_For any_ participant that joins a conference, the Metrics_Collector SHALL collect all required metrics (bandwidth, NAT type, latency, stability, device capabilities) before the participant can be evaluated for relay selection.
**Validates: Requirements 2.1, 2.2, 2.5**

Property 2: **Metrics Continuous Update**
_For any_ connected participant, the Metrics_Collector SHALL update their metrics at intervals not exceeding the configured reevaluationIntervalMs, ensuring metrics remain current for selection decisions.
**Validates: Requirements 2.3, 2.4, 2.6, 2.7**

Property 3: **Connection Establishment Order**
_For any_ peer connection attempt, the system SHALL attempt direct peer-to-peer connection before attempting TURN relay, and SHALL only use TURN if direct connection fails.
**Validates: Requirements 1.2, 1.3**

Property 4: **Bidirectional Media Capability**
_For any_ successfully established peer connection, the connection SHALL support bidirectional transmission of both audio and video streams simultaneously.
**Validates: Requirements 1.4, 1.5**

Property 5: **Scoring Monotonicity - Bandwidth**
_For any_ two participants A and B where A has strictly higher bandwidth than B and all other metrics are equal, the Selection_Algorithm SHALL assign A a higher total score than B.
**Validates: Requirements 3.2**

Property 6: **Scoring Monotonicity - NAT Type**
_For any_ two participants A and B where A has a less restrictive NAT type than B and all other metrics are equal, the Selection_Algorithm SHALL assign A a higher total score than B.
**Validates: Requirements 3.3**

Property 7: **Scoring Monotonicity - Latency**
_For any_ two participants A and B where A has lower average latency than B and all other metrics are equal, the Selection_Algorithm SHALL assign A a higher total score than B.
**Validates: Requirements 3.4**

Property 8: **Scoring Monotonicity - Stability**
_For any_ two participants A and B where A has better stability metrics than B and all other metrics are equal, the Selection_Algorithm SHALL assign A a higher total score than B.
**Validates: Requirements 3.5**

Property 9: **Scoring Monotonicity - Device Capabilities**
_For any_ two participants A and B where A has better device capabilities than B and all other metrics are equal, the Selection_Algorithm SHALL assign A a higher total score than B.
**Validates: Requirements 3.6**

Property 10: **Relay Selection Determinism**
_For any_ set of participants with identical metrics across all clients, the Selection_Algorithm SHALL select the same set of relay nodes on all clients, ensuring consensus without central coordination.
**Validates: Requirements 3.1, 3.7**

Property 11: **Topology Connectivity**
_For any_ valid topology, there SHALL exist a path of peer connections between any two participants, ensuring all participants can exchange media streams.
**Validates: Requirements 4.6**

Property 12: **Regular Node Connection Minimization**
_For any_ regular node in a valid topology, that node SHALL have exactly one peer connection (to its assigned relay node), minimizing connection overhead.
**Validates: Requirements 9.1, 9.2**

Property 13: **Relay Node Connection Pattern**
_For any_ relay node in a valid topology with N total relay nodes and M assigned regular nodes, that relay node SHALL have exactly (N-1 + M) peer connections (all other relays plus all assigned regular nodes).
**Validates: Requirements 9.3, 4.4**

Property 14: **Load Balancing Fairness**
_For any_ topology with multiple relay nodes, the difference between the maximum and minimum group sizes SHALL not exceed maxParticipantsPerRelay \* 0.3, ensuring balanced load distribution.
**Validates: Requirements 4.3**

Property 15: **Latency-Based Assignment**
_For any_ regular node assigned to a relay node, that relay SHALL be among the relays with lowest latency to that regular node (within top 50% if multiple relays available), ensuring network proximity.
**Validates: Requirements 4.2**

Property 16: **Media Forwarding Correctness**
_For any_ media packet received by a relay node from participant A, the relay SHALL forward that packet to all other relay nodes and to all regular nodes in its group except A, ensuring complete media distribution.
**Validates: Requirements 5.1, 5.2**

Property 17: **Media Forwarding Integrity**
_For any_ media packet forwarded by a relay node, the packet payload SHALL be identical to the received packet payload (no transcoding), maintaining media quality.
**Validates: Requirements 5.3**

Property 18: **Regular Node Media Flow**
_For any_ active regular node, that node SHALL transmit its media stream to exactly its assigned relay node and SHALL receive media streams from exactly its assigned relay node.
**Validates: Requirements 6.1, 6.2**

Property 19: **Media Rendering Completeness**
_For any_ regular node in a conference with N total participants, that node SHALL render N-1 media streams (all participants except itself).
**Validates: Requirements 6.3**

Property 20: **Relay Failure Detection Timeliness**
_For any_ relay node that disconnects, the system SHALL detect the disconnection and initiate failover procedures within 5 seconds.
**Validates: Requirements 7.2**

Property 21: **Relay Failover Completeness**
_For any_ relay node failure, the system SHALL either select a replacement relay from the affected group or redistribute all affected regular nodes to other existing relays, ensuring no participant is left without a relay.
**Validates: Requirements 7.3, 7.4, 7.6**

Property 22: **Join Integration Timeliness**
_For any_ participant joining a conference, the system SHALL complete topology integration (metrics collection, group assignment, connection establishment) within 10 seconds.
**Validates: Requirements 8.1, 8.2, 8.3**

Property 23: **Regular Node Leave Stability**
_For any_ regular node that leaves a conference, the topology SHALL remain unchanged for all other participants (no relay reselection or group reassignment triggered).
**Validates: Requirements 8.5**

Property 24: **Relay Node Leave Triggers Failover**
_For any_ relay node that leaves a conference, the system SHALL immediately trigger relay node failure handling procedures as if the relay had failed.
**Validates: Requirements 8.6**

Property 25: **Topology Cleanup on Leave**
_For any_ participant that leaves, all peer connections involving that participant SHALL be closed and removed from the topology within 2 seconds.
**Validates: Requirements 8.4**

Property 26: **Scalability Through Relay Addition**
_For any_ conference where participant count increases from N to N+K, if the increase requires additional relay capacity, the system SHALL add new relay nodes rather than increasing connections per existing regular node beyond maxParticipantsPerRelay.
**Validates: Requirements 9.5**

Property 27: **Topology Update Broadcast**
_For any_ topology change, the Signaling_Server SHALL broadcast the updated topology to all affected participants (those whose connections or assignments changed).
**Validates: Requirements 10.1**

Property 28: **Join Topology Provision**
_For any_ participant joining a conference, the Signaling_Server SHALL provide the current topology as part of the join response before connection establishment begins.
**Validates: Requirements 10.2**

Property 29: **Signaling Message Delivery**
_For any_ signaling message sent to a specific participant, if that participant is connected, the message SHALL be delivered to that participant.
**Validates: Requirements 10.6**

Property 30: **WebRTC Signaling Facilitation**
_For any_ peer connection establishment between participants A and B, the Signaling_Server SHALL successfully deliver the offer from A to B, the answer from B to A, and all ICE candidates in both directions.
**Validates: Requirements 10.4, 10.5**

Property 31: **Adaptive Bitrate Reduction**
_For any_ participant whose available bandwidth decreases by more than 20%, the system SHALL reduce that participant's media stream bitrate to match the new available bandwidth within 5 seconds.
**Validates: Requirements 11.1**

Property 32: **Metric-Based Relay Demotion**
_For any_ relay node whose metrics degrade such that its relay score falls below the minimum threshold (lower than the lowest non-relay participant's score), the Selection_Algorithm SHALL demote that relay node at the next re-evaluation.
**Validates: Requirements 11.4**

Property 33: **Media Encryption**
_For any_ media stream transmitted between participants, the stream SHALL be encrypted using DTLS-SRTP end-to-end encryption.
**Validates: Requirements 12.1**

Property 34: **Signaling Encryption**
_For any_ signaling message transmitted between a participant and the Signaling_Server, the message SHALL be encrypted using TLS.
**Validates: Requirements 12.2**

Property 35: **Relay Forwarding Preserves Encryption**
_For any_ encrypted media packet forwarded by a relay node, the packet SHALL remain encrypted (relay SHALL NOT decrypt the payload).
**Validates: Requirements 12.3**

Property 36: **Authentication Required**
_For any_ participant attempting to join a conference, the system SHALL authenticate that participant before allowing any conference operations (metrics collection, topology integration, connection establishment).
**Validates: Requirements 12.4**

Property 37: **Configuration Application**
_For any_ configuration parameter (minBandwidthMbps, maxParticipantsPerRelay, metric weights, reevaluationIntervalMs, connection timeouts), when set to a custom value, the system SHALL use that value in all relevant operations.
**Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5**

Property 38: **Configuration Defaults**
_For any_ configuration parameter that is not explicitly set, the system SHALL use a predefined default value that enables functional operation.
**Validates: Requirements 13.6**

Property 39: **Topology Observability**
_For any_ point in time during a conference, the system SHALL expose the current topology structure (relay nodes, groups, connections) and all relay node metrics through a monitoring interface.
**Validates: Requirements 14.1, 14.2, 14.5**

Property 40: **Event Logging Completeness**
_For any_ topology change, relay selection, relay demotion, or error event, the system SHALL create a log entry with timestamp and relevant details.
**Validates: Requirements 14.3, 14.4, 14.6**

## Error Handling

### Connection Failures

**Direct Connection Failure**:

- Attempt direct peer-to-peer connection using ICE
- If all ICE candidates fail, fall back to TURN relay
- If TURN also fails, notify user and mark participant as unreachable
- Retry connection with exponential backoff (1s, 2s, 4s, 8s, max 30s)

**TURN Server Unavailability**:

- Maintain list of multiple TURN servers for redundancy
- If primary TURN fails, try secondary TURN servers
- If all TURN servers fail, log error and notify administrator
- Continue attempting direct connections for new peers

### Relay Node Failures

**Relay Disconnection**:

1. Detect disconnection through WebRTC connection state monitoring
2. Mark relay as failed in local topology state
3. Trigger Selection_Algorithm to choose replacement from affected group
4. If suitable replacement found:
   - Promote replacement to relay role
   - Reassign all group members to new relay
   - Establish new peer connections
5. If no suitable replacement:
   - Redistribute group members to other existing relays
   - Update topology and broadcast changes

**Relay Performance Degradation**:

- Monitor relay metrics continuously
- If metrics fall below thresholds (bandwidth < minBandwidthMbps, packet loss > 5%, latency > 200ms):
  - Mark relay for demotion at next re-evaluation
  - If degradation is severe (packet loss > 15%), trigger immediate failover
  - Select replacement and perform graceful handover

### Signaling Failures

**WebSocket Disconnection**:

- Detect disconnection through WebSocket close event
- Attempt reconnection with exponential backoff
- While disconnected, buffer outgoing signaling messages
- On reconnection, resync topology state with server
- If reconnection fails after 5 attempts, notify user and exit conference

**Message Delivery Failure**:

- Implement message acknowledgment system
- If message not acknowledged within 5 seconds, retry up to 3 times
- If all retries fail, log error and notify affected operation
- For critical messages (topology updates), ensure delivery before proceeding

### Metrics Collection Failures

**Bandwidth Measurement Failure**:

- If bandwidth test fails, use last known value
- If no previous value, use conservative default (5 Mbps upload, 10 Mbps download)
- Mark measurement confidence as low
- Retry measurement at next interval

**NAT Detection Failure**:

- If STUN servers unreachable, assume SYMMETRIC NAT (most restrictive)
- Participant will not be eligible for relay role
- Log warning for administrator review

### Topology Formation Failures

**Insufficient Relay Candidates**:

- If no participants meet relay eligibility criteria:
  - Lower minBandwidthMbps threshold by 50%
  - Retry selection with relaxed criteria
  - If still insufficient, fall back to full mesh topology for small conferences (<5 participants)
  - For larger conferences, use best available candidates even if below ideal thresholds

**Group Assignment Failure**:

- If a regular node cannot be assigned to any relay (all at capacity):
  - Temporarily exceed maxParticipantsPerRelay for least loaded relay
  - Trigger immediate relay re-evaluation to add more relays
  - Log warning about overloaded topology

## Testing Strategy

### Dual Testing Approach

The RelayMesh system requires both unit testing and property-based testing for comprehensive validation:

**Unit Tests** focus on:

- Specific examples of metrics calculation (e.g., scoring a participant with known metrics)
- Edge cases (e.g., single participant conference, all participants behind symmetric NAT)
- Error conditions (e.g., relay disconnection during media transmission)
- Integration points (e.g., signaling message serialization/deserialization)
- Specific topology scenarios (e.g., 3 participants with 1 relay, 10 participants with 3 relays)

**Property-Based Tests** focus on:

- Universal properties that hold for all inputs (e.g., scoring monotonicity)
- Topology invariants (e.g., connectivity, connection counts)
- Consensus properties (e.g., all clients select same relays)
- Scalability properties (e.g., connection count growth)
- Comprehensive input coverage through randomization

### Property-Based Testing Configuration

**Testing Library**: Use fast-check (JavaScript/TypeScript), Hypothesis (Python), or QuickCheck (Haskell) depending on implementation language.

**Test Configuration**:

- Minimum 100 iterations per property test (due to randomization)
- Increase to 1000 iterations for critical properties (scoring, topology formation)
- Use shrinking to find minimal failing examples
- Seed tests for reproducibility in CI/CD

**Property Test Tagging**:
Each property-based test MUST include a comment tag referencing the design property:

```typescript
// Feature: relay-mesh, Property 5: Scoring Monotonicity - Bandwidth
test('higher bandwidth yields higher score', () => {
  fc.assert(
    fc.property(participantMetricsArbitrary(), (metrics) => {
      // Test implementation
    }),
    { numRuns: 100 }
  );
});
```

### Test Data Generators

**Participant Metrics Generator**:

- Generate random but realistic metrics
- Bandwidth: 1-100 Mbps upload, 5-500 Mbps download
- NAT type: uniform distribution across all types
- Latency: 10-300ms with normal distribution around 50ms
- Packet loss: 0-10% with exponential distribution (most near 0%)
- Device capabilities: varied CPU/memory/codec combinations

**Topology Generator**:

- Generate random valid topologies for testing
- Vary participant count (2-50)
- Vary relay count based on participant count
- Ensure all topology invariants hold

**Conference State Generator**:

- Generate random conference states with participants, connections, metrics
- Use for testing join/leave operations and topology updates

### Integration Testing

**End-to-End Scenarios**:

1. Conference lifecycle: create → participants join → media flows → participants leave → conference ends
2. Relay failover: establish conference → relay disconnects → failover completes → media resumes
3. Network degradation: establish conference → simulate bandwidth reduction → adaptive bitrate activates
4. Scaling: start with 3 participants → gradually add up to 20 → verify topology adapts

**WebRTC Testing**:

- Use mock WebRTC implementations for unit tests
- Use real WebRTC with loopback for integration tests
- Test with various network conditions (latency, packet loss, bandwidth limits)

### Performance Testing

**Metrics to Measure**:

- Connection establishment time
- Relay failover time
- Topology formation time
- Media forwarding latency (relay nodes)
- Signaling message latency
- CPU/memory usage per participant
- Bandwidth usage per participant

**Load Testing**:

- Test with increasing participant counts (5, 10, 20, 30, 50)
- Measure scalability metrics at each level
- Identify bottlenecks and resource limits

### Security Testing

**Encryption Verification**:

- Verify DTLS-SRTP is used for all media streams
- Verify TLS is used for all signaling
- Verify relay nodes cannot decrypt media packets

**Authentication Testing**:

- Verify unauthenticated participants are rejected
- Test with invalid credentials
- Test with expired credentials

**Message Integrity Testing**:

- Attempt to tamper with signaling messages
- Verify tampered messages are rejected
- Test replay attack prevention

## Future Extensions

### MCU-Style Media Mixing Support

While the current design uses SFU-style forwarding (relay nodes forward individual streams without processing), future versions could support MCU-style media mixing as an optional mode.

#### Overview

MCU-style mixing allows relay nodes to decode, mix, and re-encode media streams, sending each participant a single composite stream instead of multiple individual streams. This significantly reduces bandwidth requirements for clients at the cost of increased CPU usage on relay nodes.

#### Configuration Extension

```typescript
enum RelayMode {
  SFU = 'sfu', // Forward individual streams (current implementation)
  MCU = 'mcu', // Mix streams into composite
  ADAPTIVE = 'adaptive', // Automatically choose based on conditions
}

interface SelectionConfig {
  // ... existing parameters
  relayMode: RelayMode; // default: 'sfu'
  mcuMinCpuPercent: number; // default: 40 (minimum available CPU for MCU mode)
  mcuMinMemoryMB: number; // default: 1024 (minimum available memory for MCU mode)
  mcuMaxStreamsToMix: number; // default: 9 (maximum streams in composite)
  adaptiveBandwidthThresholdMbps: number; // default: 3 (switch to MCU if client bandwidth below this)
}
```

#### Relay Engine Extension

```typescript
interface RelayEngine {
  // ... existing methods

  // MCU-specific methods
  setRelayMode(mode: RelayMode): void;

  // Configure mixing layout (grid, speaker-focus, etc.)
  configureMixingLayout(layout: MixingLayout): void;

  // Mix multiple streams into composite
  mixStreams(streams: MediaStream[], layout: MixingLayout): MediaStream;
}

interface MixingLayout {
  type: 'grid' | 'speaker-focus' | 'custom';
  gridSize?: { rows: number; cols: number };
  speakerPosition?: 'top' | 'bottom' | 'left' | 'right';
  customPositions?: Array<{ x: number; y: number; width: number; height: number }>;
}
```

#### Selection Algorithm Extension

When MCU mode is enabled, the selection algorithm would need to prioritize different metrics:

**MCU-Specific Scoring Adjustments**:

```typescript
// For MCU mode, adjust weights to prioritize CPU/memory over bandwidth
const mcuWeights = {
  bandwidthWeight: 0.15, // Less important (sending one stream instead of many)
  natWeight: 0.2,
  latencyWeight: 0.15,
  stabilityWeight: 0.15,
  deviceWeight: 0.35, // Much more important (CPU-intensive mixing)
};

// Additional eligibility criteria for MCU relay nodes
const mcuEligibility = {
  minAvailableCpuPercent: 40,
  minAvailableMemoryMB: 1024,
  requiresHardwareAcceleration: true, // Strongly recommended for video encoding
};
```

#### Adaptive Mode Logic

The adaptive mode would automatically choose between SFU and MCU based on real-time conditions:

```typescript
function determineOptimalRelayMode(
  relayMetrics: ParticipantMetrics,
  groupMembers: Participant[],
  config: SelectionConfig
): RelayMode {
  // Check if relay has sufficient resources for MCU
  const canSupportMCU =
    relayMetrics.device.cpuUsagePercent <= 100 - config.mcuMinCpuPercent &&
    relayMetrics.device.availableMemoryMB >= config.mcuMinMemoryMB &&
    relayMetrics.device.hardwareAcceleration;

  if (!canSupportMCU) {
    return RelayMode.SFU;
  }

  // Count how many group members have limited bandwidth
  const lowBandwidthMembers = groupMembers.filter(
    (p) => p.metrics.bandwidth.downloadMbps < config.adaptiveBandwidthThresholdMbps
  );

  // If majority of group has limited bandwidth, use MCU to help them
  if (lowBandwidthMembers.length > groupMembers.length / 2) {
    return RelayMode.MCU;
  }

  // Otherwise use SFU for better quality and lower relay CPU usage
  return RelayMode.SFU;
}
```

#### Trade-offs

**MCU Mode Advantages**:

- Significantly reduced bandwidth for clients (receive 1 stream instead of N-1)
- Better support for low-bandwidth participants
- Consistent quality across all participants
- Simplified client-side rendering

**MCU Mode Disadvantages**:

- Breaks end-to-end encryption (relay must decrypt to mix)
- High CPU usage on relay nodes (encoding/decoding)
- Potential quality loss from transcoding
- Increased latency from processing time
- More complex relay node implementation

**SFU Mode Advantages** (current implementation):

- Preserves end-to-end encryption
- Minimal relay CPU usage (just forwarding)
- No quality loss from transcoding
- Lower latency (no processing delay)
- Simpler implementation

**SFU Mode Disadvantages**:

- Higher bandwidth for clients (receive N-1 streams)
- May not scale well for very low-bandwidth clients

#### Implementation Considerations

1. **Encryption Handling**: MCU mode requires relay nodes to decrypt media for mixing, then re-encrypt. This means:
   - End-to-end encryption is broken (relay can see content)
   - Need to clearly communicate this to users
   - Consider hybrid approach: audio mixing only, video forwarding

2. **Codec Support**: MCU requires relay nodes to support encoding/decoding:
   - Need to verify codec support during relay selection
   - May need to transcode between different codecs
   - Hardware acceleration becomes critical

3. **Layout Management**: MCU needs to decide how to arrange participants:
   - Active speaker detection for speaker-focus layouts
   - Dynamic layout updates when participants join/leave
   - Signaling layout changes to participants

4. **Backward Compatibility**: System should support mixed deployments:
   - Some relays in SFU mode, others in MCU mode
   - Clients should handle both composite and individual streams
   - Graceful fallback if MCU relay fails

#### Migration Path

To add MCU support to the existing system:

1. **Phase 1**: Implement MCU relay engine as separate module
2. **Phase 2**: Add mode selection to configuration
3. **Phase 3**: Implement adaptive mode logic
4. **Phase 4**: Add layout management and active speaker detection
5. **Phase 5**: Optimize performance with hardware acceleration

This extension would be particularly valuable for:

- Conferences with many participants on mobile/limited networks
- Scenarios where bandwidth is more constrained than CPU
- Use cases where end-to-end encryption is not required
- Integration with existing MCU-based systems
