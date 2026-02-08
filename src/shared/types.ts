// Shared data models and types

// ============================================================================
// Metrics Interfaces (Task 2.1)
// ============================================================================

export enum NATType {
  OPEN = 0, // No NAT, public IP
  FULL_CONE = 1, // Most permissive NAT
  RESTRICTED = 2, // Restricted cone NAT
  PORT_RESTRICTED = 3, // Port-restricted cone NAT
  SYMMETRIC = 4, // Most restrictive, requires TURN
}

export interface BandwidthMetrics {
  uploadMbps: number;
  downloadMbps: number;
  measurementConfidence: number; // 0-1
}

export interface LatencyMetrics {
  averageRttMs: number;
  minRttMs: number;
  maxRttMs: number;
  measurements: Map<string, number>; // participantId -> RTT
}

export interface StabilityMetrics {
  packetLossPercent: number;
  jitterMs: number;
  connectionUptime: number; // seconds
  reconnectionCount: number;
}

export interface DeviceMetrics {
  cpuUsagePercent: number;
  availableMemoryMB: number;
  supportedCodecs: string[];
  hardwareAcceleration: boolean;
}

export interface ParticipantMetrics {
  participantId: string;
  timestamp: number;
  bandwidth: BandwidthMetrics;
  natType: NATType;
  latency: LatencyMetrics;
  stability: StabilityMetrics;
  device: DeviceMetrics;
}

// ============================================================================
// Topology Interfaces (Task 2.1)
// ============================================================================

export interface ParticipantGroup {
  relayNodeId: string;
  regularNodeIds: string[];
}

export interface ConnectionTopology {
  version: number;
  timestamp: number;
  relayNodes: string[];
  groups: ParticipantGroup[];
  relayConnections: Array<[string, string]>; // relay-to-relay connections
}

// ============================================================================
// Participant and Conference State (Task 2.1)
// ============================================================================

export interface Participant {
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

export interface Conference {
  id: string;
  participants: Map<string, Participant>;
  topology: ConnectionTopology;
  config: SelectionConfig;
  createdAt: number;
  lastTopologyUpdate: number;
}

// ============================================================================
// Configuration Interfaces (Task 2.3)
// ============================================================================

export interface SelectionConfig {
  bandwidthWeight: number; // default: 0.30
  natWeight: number; // default: 0.25
  latencyWeight: number; // default: 0.20
  stabilityWeight: number; // default: 0.15
  deviceWeight: number; // default: 0.10
  minBandwidthMbps: number; // default: 5
  maxParticipantsPerRelay: number; // default: 5
  reevaluationIntervalMs: number; // default: 30000
}

export interface PeerConnectionConfig {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
}

// ============================================================================
// Signaling Protocol Message Types (Task 2.2)
// ============================================================================

export interface SignalingMessage {
  type: string;
  from: string;
  timestamp: number;
}

export interface JoinMessage extends SignalingMessage {
  type: 'join';
  conferenceId: string;
  participantInfo: {
    id: string;
    name: string;
  };
}

export interface TopologyUpdateMessage extends SignalingMessage {
  type: 'topology-update';
  topology: ConnectionTopology;
  reason: 'relay-selection' | 'participant-join' | 'participant-leave' | 'relay-failure';
}

export interface MetricsBroadcastMessage extends SignalingMessage {
  type: 'metrics-broadcast';
  metrics: ParticipantMetrics;
}

export interface WebRTCOfferMessage extends SignalingMessage {
  type: 'webrtc-offer';
  to: string;
  offer: RTCSessionDescriptionInit;
}

export interface WebRTCAnswerMessage extends SignalingMessage {
  type: 'webrtc-answer';
  to: string;
  answer: RTCSessionDescriptionInit;
}

export interface ICECandidateMessage extends SignalingMessage {
  type: 'ice-candidate';
  to: string;
  candidate: RTCIceCandidateInit;
}

export interface RelayAssignmentMessage extends SignalingMessage {
  type: 'relay-assignment';
  assignedRelayId: string;
  role: 'relay' | 'regular';
}
