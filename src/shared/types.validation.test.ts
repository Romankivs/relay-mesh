// Validation tests for Task 2 - Shared data models and types
import {
  NATType,
  BandwidthMetrics,
  LatencyMetrics,
  StabilityMetrics,
  DeviceMetrics,
  ParticipantMetrics,
  ParticipantGroup,
  ConnectionTopology,
  Participant,
  Conference,
  SelectionConfig,
  PeerConnectionConfig,
  SignalingMessage,
  JoinMessage,
  TopologyUpdateMessage,
  MetricsBroadcastMessage,
  WebRTCOfferMessage,
  WebRTCAnswerMessage,
  ICECandidateMessage,
  RelayAssignmentMessage,
} from './types';
import { DEFAULT_SELECTION_CONFIG, DEFAULT_PEER_CONNECTION_CONFIG } from './config';

describe('Task 2.1 - Metrics and Participant State Interfaces', () => {
  it('should create valid BandwidthMetrics', () => {
    const bandwidth: BandwidthMetrics = {
      uploadMbps: 10,
      downloadMbps: 50,
      measurementConfidence: 0.95,
    };
    expect(bandwidth.uploadMbps).toBe(10);
    expect(bandwidth.downloadMbps).toBe(50);
    expect(bandwidth.measurementConfidence).toBe(0.95);
  });

  it('should create valid NATType enum', () => {
    expect(NATType.OPEN).toBe(0);
    expect(NATType.FULL_CONE).toBe(1);
    expect(NATType.RESTRICTED).toBe(2);
    expect(NATType.PORT_RESTRICTED).toBe(3);
    expect(NATType.SYMMETRIC).toBe(4);
  });

  it('should create valid LatencyMetrics', () => {
    const latency: LatencyMetrics = {
      averageRttMs: 50,
      minRttMs: 30,
      maxRttMs: 100,
      measurements: new Map([
        ['participant1', 45],
        ['participant2', 55],
      ]),
    };
    expect(latency.averageRttMs).toBe(50);
    expect(latency.measurements.size).toBe(2);
  });

  it('should create valid StabilityMetrics', () => {
    const stability: StabilityMetrics = {
      packetLossPercent: 0.5,
      jitterMs: 10,
      connectionUptime: 300,
      reconnectionCount: 0,
    };
    expect(stability.packetLossPercent).toBe(0.5);
    expect(stability.connectionUptime).toBe(300);
  });

  it('should create valid DeviceMetrics', () => {
    const device: DeviceMetrics = {
      cpuUsagePercent: 30,
      availableMemoryMB: 2048,
      supportedCodecs: ['VP8', 'VP9', 'H264'],
      hardwareAcceleration: true,
    };
    expect(device.cpuUsagePercent).toBe(30);
    expect(device.supportedCodecs).toHaveLength(3);
  });

  it('should create valid ParticipantMetrics', () => {
    const metrics: ParticipantMetrics = {
      participantId: 'p1',
      timestamp: Date.now(),
      bandwidth: {
        uploadMbps: 10,
        downloadMbps: 50,
        measurementConfidence: 0.95,
      },
      natType: NATType.FULL_CONE,
      latency: {
        averageRttMs: 50,
        minRttMs: 30,
        maxRttMs: 100,
        measurements: new Map(),
      },
      stability: {
        packetLossPercent: 0.5,
        jitterMs: 10,
        connectionUptime: 300,
        reconnectionCount: 0,
      },
      device: {
        cpuUsagePercent: 30,
        availableMemoryMB: 2048,
        supportedCodecs: ['VP8'],
        hardwareAcceleration: true,
      },
    };
    expect(metrics.participantId).toBe('p1');
    expect(metrics.natType).toBe(NATType.FULL_CONE);
  });

  it('should create valid ParticipantGroup', () => {
    const group: ParticipantGroup = {
      relayNodeId: 'relay1',
      regularNodeIds: ['p1', 'p2', 'p3'],
    };
    expect(group.relayNodeId).toBe('relay1');
    expect(group.regularNodeIds).toHaveLength(3);
  });

  it('should create valid ConnectionTopology', () => {
    const topology: ConnectionTopology = {
      version: 1,
      timestamp: Date.now(),
      relayNodes: ['relay1', 'relay2'],
      groups: [
        { relayNodeId: 'relay1', regularNodeIds: ['p1', 'p2'] },
        { relayNodeId: 'relay2', regularNodeIds: ['p3', 'p4'] },
      ],
      relayConnections: [['relay1', 'relay2']],
    };
    expect(topology.version).toBe(1);
    expect(topology.relayNodes).toHaveLength(2);
    expect(topology.groups).toHaveLength(2);
  });

  it('should create valid Participant', () => {
    const participant: Participant = {
      id: 'p1',
      name: 'Alice',
      role: 'regular',
      metrics: {
        participantId: 'p1',
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 10, downloadMbps: 50, measurementConfidence: 0.95 },
        natType: NATType.OPEN,
        latency: { averageRttMs: 50, minRttMs: 30, maxRttMs: 100, measurements: new Map() },
        stability: { packetLossPercent: 0.5, jitterMs: 10, connectionUptime: 300, reconnectionCount: 0 },
        device: { cpuUsagePercent: 30, availableMemoryMB: 2048, supportedCodecs: ['VP8'], hardwareAcceleration: true },
      },
      connections: new Map(),
      assignedRelayId: 'relay1',
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    };
    expect(participant.id).toBe('p1');
    expect(participant.role).toBe('regular');
    expect(participant.assignedRelayId).toBe('relay1');
  });

  it('should create valid Conference', () => {
    const conference: Conference = {
      id: 'conf1',
      participants: new Map(),
      topology: {
        version: 1,
        timestamp: Date.now(),
        relayNodes: [],
        groups: [],
        relayConnections: [],
      },
      config: DEFAULT_SELECTION_CONFIG,
      createdAt: Date.now(),
      lastTopologyUpdate: Date.now(),
    };
    expect(conference.id).toBe('conf1');
    expect(conference.participants.size).toBe(0);
  });
});

describe('Task 2.2 - Signaling Protocol Message Types', () => {
  it('should create valid JoinMessage', () => {
    const msg: JoinMessage = {
      type: 'join',
      from: 'p1',
      timestamp: Date.now(),
      conferenceId: 'conf1',
      participantInfo: {
        id: 'p1',
        name: 'Alice',
      },
    };
    expect(msg.type).toBe('join');
    expect(msg.participantInfo.name).toBe('Alice');
  });

  it('should create valid TopologyUpdateMessage', () => {
    const msg: TopologyUpdateMessage = {
      type: 'topology-update',
      from: 'server',
      timestamp: Date.now(),
      topology: {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [],
        relayConnections: [],
      },
      reason: 'relay-selection',
    };
    expect(msg.type).toBe('topology-update');
    expect(msg.reason).toBe('relay-selection');
  });

  it('should create valid MetricsBroadcastMessage', () => {
    const msg: MetricsBroadcastMessage = {
      type: 'metrics-broadcast',
      from: 'p1',
      timestamp: Date.now(),
      metrics: {
        participantId: 'p1',
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 10, downloadMbps: 50, measurementConfidence: 0.95 },
        natType: NATType.OPEN,
        latency: { averageRttMs: 50, minRttMs: 30, maxRttMs: 100, measurements: new Map() },
        stability: { packetLossPercent: 0.5, jitterMs: 10, connectionUptime: 300, reconnectionCount: 0 },
        device: { cpuUsagePercent: 30, availableMemoryMB: 2048, supportedCodecs: ['VP8'], hardwareAcceleration: true },
      },
    };
    expect(msg.type).toBe('metrics-broadcast');
    expect(msg.metrics.participantId).toBe('p1');
  });

  it('should create valid WebRTCOfferMessage', () => {
    const msg: WebRTCOfferMessage = {
      type: 'webrtc-offer',
      from: 'p1',
      to: 'p2',
      timestamp: Date.now(),
      offer: {
        type: 'offer',
        sdp: 'mock-sdp',
      },
    };
    expect(msg.type).toBe('webrtc-offer');
    expect(msg.to).toBe('p2');
  });

  it('should create valid WebRTCAnswerMessage', () => {
    const msg: WebRTCAnswerMessage = {
      type: 'webrtc-answer',
      from: 'p2',
      to: 'p1',
      timestamp: Date.now(),
      answer: {
        type: 'answer',
        sdp: 'mock-sdp',
      },
    };
    expect(msg.type).toBe('webrtc-answer');
    expect(msg.to).toBe('p1');
  });

  it('should create valid ICECandidateMessage', () => {
    const msg: ICECandidateMessage = {
      type: 'ice-candidate',
      from: 'p1',
      to: 'p2',
      timestamp: Date.now(),
      candidate: {
        candidate: 'mock-candidate',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    };
    expect(msg.type).toBe('ice-candidate');
    expect(msg.candidate.candidate).toBe('mock-candidate');
  });

  it('should create valid RelayAssignmentMessage', () => {
    const msg: RelayAssignmentMessage = {
      type: 'relay-assignment',
      from: 'server',
      timestamp: Date.now(),
      assignedRelayId: 'relay1',
      role: 'regular',
    };
    expect(msg.type).toBe('relay-assignment');
    expect(msg.role).toBe('regular');
  });
});

describe('Task 2.3 - Configuration Interfaces', () => {
  it('should create valid SelectionConfig', () => {
    const config: SelectionConfig = {
      bandwidthWeight: 0.30,
      natWeight: 0.25,
      latencyWeight: 0.20,
      stabilityWeight: 0.15,
      deviceWeight: 0.10,
      minBandwidthMbps: 5,
      maxParticipantsPerRelay: 5,
      reevaluationIntervalMs: 30000,
    };
    expect(config.bandwidthWeight).toBe(0.30);
    expect(config.minBandwidthMbps).toBe(5);
  });

  it('should have valid DEFAULT_SELECTION_CONFIG', () => {
    expect(DEFAULT_SELECTION_CONFIG.bandwidthWeight).toBe(0.30);
    expect(DEFAULT_SELECTION_CONFIG.natWeight).toBe(0.25);
    expect(DEFAULT_SELECTION_CONFIG.latencyWeight).toBe(0.20);
    expect(DEFAULT_SELECTION_CONFIG.stabilityWeight).toBe(0.15);
    expect(DEFAULT_SELECTION_CONFIG.deviceWeight).toBe(0.10);
    expect(DEFAULT_SELECTION_CONFIG.minBandwidthMbps).toBe(5);
    expect(DEFAULT_SELECTION_CONFIG.maxParticipantsPerRelay).toBe(5);
    expect(DEFAULT_SELECTION_CONFIG.reevaluationIntervalMs).toBe(30000);
  });

  it('should create valid PeerConnectionConfig', () => {
    const config: PeerConnectionConfig = {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      iceTransportPolicy: 'all',
    };
    expect(config.iceServers).toHaveLength(1);
    expect(config.iceTransportPolicy).toBe('all');
  });

  it('should have valid DEFAULT_PEER_CONNECTION_CONFIG', () => {
    expect(DEFAULT_PEER_CONNECTION_CONFIG.iceServers).toHaveLength(2);
    expect(DEFAULT_PEER_CONNECTION_CONFIG.iceTransportPolicy).toBe('all');
    expect(DEFAULT_PEER_CONNECTION_CONFIG.iceServers[0].urls).toBe('stun:stun.l.google.com:19302');
  });
});
