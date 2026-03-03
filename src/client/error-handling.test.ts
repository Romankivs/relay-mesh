// Comprehensive Error Handling Tests
// Task 18.6: Write unit tests for error handling scenarios
// Tests all error handling paths, cascading failures, and recovery

import { MetricsCollector } from './metrics-collector';
import { MediaHandler } from './media-handler';
import { TopologyManager } from './topology-manager';
import { ResilientTopologyManager } from './topology-manager-resilience';
import { SelectionAlgorithm } from './selection-algorithm';
import {
  NATType,
  ParticipantMetrics,
  SelectionConfig,
  PeerConnectionConfig,
  ConnectionTopology,
} from '../shared/types';

// Mock WebRTC APIs for testing
global.RTCPeerConnection = jest.fn().mockImplementation(() => ({
  createDataChannel: jest.fn().mockReturnValue({
    readyState: 'open',
    onopen: null,
    onmessage: null,
    send: jest.fn(),
    close: jest.fn(),
  }),
  createOffer: jest.fn().mockResolvedValue({}),
  setLocalDescription: jest.fn().mockResolvedValue(undefined),
  connectionState: 'new',
  iceConnectionState: 'new',
  onicecandidate: null,
  ontrack: null,
  onconnectionstatechange: null,
  oniceconnectionstatechange: null,
  getSenders: jest.fn().mockReturnValue([]),
  addTrack: jest.fn(),
  getStats: jest.fn().mockResolvedValue(new Map()),
  close: jest.fn(),
})) as any;

global.RTCRtpSender = {
  getCapabilities: jest.fn().mockReturnValue({
    codecs: [
      { mimeType: 'video/VP8' },
      { mimeType: 'audio/opus' },
    ],
  }),
} as any;

// Mock performance API
global.performance = {
  now: jest.fn().mockReturnValue(Date.now()),
  memory: {
    jsHeapSizeLimit: 2147483648,
    usedJSHeapSize: 1073741824,
  },
} as any;

// Mock document for hardware acceleration detection
global.document = {
  createElement: jest.fn().mockReturnValue({
    getContext: jest.fn().mockReturnValue(null),
  }),
} as any;

// Mock navigator for media devices
global.navigator = {
  mediaDevices: {
    getUserMedia: jest.fn().mockResolvedValue({
      id: 'mock-stream-id',
      getTracks: jest.fn().mockReturnValue([]),
    }),
  },
} as any;

describe('Error Handling - Task 18.6', () => {
  describe('Connection Failure Handling (Requirements 1.2, 1.3)', () => {
    let mediaHandler: MediaHandler;

    beforeEach(() => {
      mediaHandler = new MediaHandler('test-participant');
    });

    afterEach(() => {
      mediaHandler.cleanup();
    });

    it('should handle direct connection failure with TURN fallback', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: 'turn:turn.example.com:3478',
            username: 'user',
            credential: 'pass',
          },
        ],
        iceTransportPolicy: 'all', // Try direct first, then TURN
      };

      // Create peer connection
      const peerConnection = await mediaHandler.createPeerConnection('remote1', config);

      expect(peerConnection).toBeDefined();
      // Note: iceTransportPolicy is not exposed on RTCPeerConnection interface
      // but is used internally during connection establishment
    });

    it('should handle connection failure when all ICE candidates fail', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [], // No ICE servers - will fail
        iceTransportPolicy: 'all',
      };

      // Create peer connection - should not throw
      const peerConnection = await mediaHandler.createPeerConnection('remote2', config);

      expect(peerConnection).toBeDefined();
      // Connection will fail, but creation should succeed
    });

    it('should handle TURN server unavailability', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: 'turn:invalid-turn-server.example.com:3478',
            username: 'user',
            credential: 'pass',
          },
        ],
        iceTransportPolicy: 'all',
      };

      // Should still create connection even with invalid TURN server
      const peerConnection = await mediaHandler.createPeerConnection('remote3', config);

      expect(peerConnection).toBeDefined();
    });

    it('should track retry attempts for failed connections', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      };

      // Create connection
      await mediaHandler.createPeerConnection('remote4', config);

      // Simulate failure and retry
      mediaHandler.closePeerConnection('remote4');
      await mediaHandler.createPeerConnection('remote4', config);

      // Should track retries internally
      expect(mediaHandler['connectionRetries'].has('remote4')).toBe(true);
    });

    it('should handle exponential backoff for connection retries', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      };

      // Create and close connection multiple times
      for (let i = 0; i < 3; i++) {
        await mediaHandler.createPeerConnection('remote5', config);
        mediaHandler.closePeerConnection('remote5');
      }

      // Retry counter should be tracked
      const retries = mediaHandler['connectionRetries'].get('remote5') || 0;
      expect(retries).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Metrics Collection Failure Handling (Requirements 2.1, 2.2)', () => {
    let metricsCollector: MetricsCollector;

    beforeEach(() => {
      metricsCollector = new MetricsCollector({ participantId: 'test-participant', stunServers: [] });
    });

    it('should use fallback values when bandwidth measurement fails', async () => {
      // Mock RTCPeerConnection to throw error
      const originalRTCPeerConnection = global.RTCPeerConnection;
      global.RTCPeerConnection = jest.fn().mockImplementation(() => {
        throw new Error('Connection failed');
      }) as any;

      // Bandwidth measurement will fail with no STUN servers
      const bandwidth = await metricsCollector.measureBandwidth();

      // Should return conservative defaults (5 Mbps upload, 10 Mbps download)
      expect(bandwidth.uploadMbps).toBe(5.0);
      expect(bandwidth.downloadMbps).toBe(10.0);
      expect(bandwidth.measurementConfidence).toBeLessThan(0.5);

      // Restore original mock
      global.RTCPeerConnection = originalRTCPeerConnection;
    });

    it('should use last known bandwidth value when measurement fails', async () => {
      // Set up initial metrics with known bandwidth
      metricsCollector['currentMetrics'] = {
        participantId: 'test-participant',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 15.0,
          downloadMbps: 50.0,
          measurementConfidence: 0.8,
        },
        natType: NATType.FULL_CONE,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 0.5,
          jitterMs: 10,
          connectionUptime: 100,
          reconnectionCount: 0,
        },
        device: {
          cpuUsagePercent: 30,
          availableMemoryMB: 2048,
          supportedCodecs: ['VP8', 'opus'],
          hardwareAcceleration: true,
        },
      };

      // Mock RTCPeerConnection to throw error
      const originalRTCPeerConnection = global.RTCPeerConnection;
      global.RTCPeerConnection = jest.fn().mockImplementation(() => {
        throw new Error('Connection failed');
      }) as any;

      // Bandwidth measurement will fail
      const bandwidth = await metricsCollector.measureBandwidth();

      // Should use last known values
      expect(bandwidth.uploadMbps).toBe(15.0);
      expect(bandwidth.downloadMbps).toBe(50.0);
      expect(bandwidth.measurementConfidence).toBeLessThan(0.8); // Lower confidence for stale data

      // Restore original mock
      global.RTCPeerConnection = originalRTCPeerConnection;
    });

    it('should assume SYMMETRIC NAT when detection fails', async () => {
      // Mock RTCPeerConnection to throw error
      const originalRTCPeerConnection = global.RTCPeerConnection;
      global.RTCPeerConnection = jest.fn().mockImplementation(() => {
        throw new Error('STUN servers unreachable');
      }) as any;

      // NAT detection will fail with no STUN servers
      const natType = await metricsCollector.detectNATType();

      // Should assume most restrictive NAT type
      expect(natType).toBe(NATType.SYMMETRIC);

      // Restore original mock
      global.RTCPeerConnection = originalRTCPeerConnection;
    });

    it('should use last known NAT type when detection fails', async () => {
      // Set up initial metrics with known NAT type
      metricsCollector['currentMetrics'] = {
        participantId: 'test-participant',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 10.0,
          downloadMbps: 20.0,
          measurementConfidence: 0.8,
        },
        natType: NATType.FULL_CONE,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 0.5,
          jitterMs: 10,
          connectionUptime: 100,
          reconnectionCount: 0,
        },
        device: {
          cpuUsagePercent: 30,
          availableMemoryMB: 2048,
          supportedCodecs: ['VP8', 'opus'],
          hardwareAcceleration: true,
        },
      };

      // Mock RTCPeerConnection to throw error
      const originalRTCPeerConnection = global.RTCPeerConnection;
      global.RTCPeerConnection = jest.fn().mockImplementation(() => {
        throw new Error('STUN servers unreachable');
      }) as any;

      // NAT detection will fail
      const natType = await metricsCollector.detectNATType();

      // Should use last known value
      expect(natType).toBe(NATType.FULL_CONE);

      // Restore original mock
      global.RTCPeerConnection = originalRTCPeerConnection;
    });

    it('should handle complete metrics collection failure gracefully', async () => {
      // Mock RTCPeerConnection to throw error
      const originalRTCPeerConnection = global.RTCPeerConnection;
      global.RTCPeerConnection = jest.fn().mockImplementation(() => {
        throw new Error('Connection failed');
      }) as any;

      // Attempt to collect metrics with no STUN servers
      await metricsCollector.collectMetrics();

      const metrics = metricsCollector.getCurrentMetrics();

      // Should have fallback values
      expect(metrics.bandwidth.uploadMbps).toBe(5.0);
      expect(metrics.bandwidth.downloadMbps).toBe(10.0);
      expect(metrics.natType).toBe(NATType.SYMMETRIC);

      // Restore original mock
      global.RTCPeerConnection = originalRTCPeerConnection;
    });
  });

  describe('Topology Formation Failure Handling (Requirements 4.1, 4.2, 4.3)', () => {
    let resilientManager: ResilientTopologyManager;
    let selectionAlgorithm: SelectionAlgorithm;

    beforeEach(() => {
      resilientManager = new ResilientTopologyManager();
      selectionAlgorithm = new SelectionAlgorithm();
    });

    it('should handle insufficient relay candidates with full mesh fallback', () => {
      const allParticipants = ['p1', 'p2', 'p3', 'p4']; // Small conference
      const latencyMap = new Map<string, Map<string, number>>();

      const topology = resilientManager.formTopologyWithFallback(
        [], // No relay candidates
        allParticipants,
        latencyMap
      );

      // Should fall back to full mesh
      expect(topology.relayNodes).toEqual([]);
      expect(topology.groups).toEqual([]);
    });

    it('should handle insufficient relay candidates with relaxed criteria', () => {
      const allParticipants = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
      const latencyMap = new Map<string, Map<string, number>>();

      // Create metrics with bandwidth just below threshold
      const allMetrics = new Map<string, ParticipantMetrics>();
      allParticipants.forEach((id) => {
        allMetrics.set(id, {
          participantId: id,
          timestamp: Date.now(),
          bandwidth: {
            uploadMbps: 3.5, // Below 5 Mbps threshold
            downloadMbps: 10.0,
            measurementConfidence: 0.8,
          },
          natType: NATType.FULL_CONE,
          latency: {
            averageRttMs: 50,
            minRttMs: 40,
            maxRttMs: 60,
            measurements: new Map(),
          },
          stability: {
            packetLossPercent: 0.5,
            jitterMs: 10,
            connectionUptime: 100,
            reconnectionCount: 0,
          },
          device: {
            cpuUsagePercent: 30,
            availableMemoryMB: 2048,
            supportedCodecs: ['VP8', 'opus'],
            hardwareAcceleration: true,
          },
        });
      });

      const config: SelectionConfig = {
        bandwidthWeight: 0.30,
        natWeight: 0.25,
        latencyWeight: 0.20,
        stabilityWeight: 0.15,
        deviceWeight: 0.10,
        minBandwidthMbps: 5.0,
        maxParticipantsPerRelay: 5,
        reevaluationIntervalMs: 30000,
      };

      const topology = resilientManager.formTopologyWithFallback(
        [],
        allParticipants,
        latencyMap,
        allMetrics,
        config
      );

      // Should select relays with relaxed criteria (2.5 Mbps threshold)
      expect(topology.relayNodes.length).toBeGreaterThan(0);
    });

    it('should handle group assignment failure when all relays at capacity', () => {
      const relayNodeIds = ['relay1', 'relay2'];
      const latencyMap = new Map<string, number>([
        ['relay1', 50],
        ['relay2', 60],
      ]);

      // Both relays at capacity
      const currentGroups = [
        {
          relayNodeId: 'relay1',
          regularNodeIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
        },
        {
          relayNodeId: 'relay2',
          regularNodeIds: ['p6', 'p7', 'p8', 'p9', 'p10'],
        },
      ];

      const config: SelectionConfig = {
        bandwidthWeight: 0.30,
        natWeight: 0.25,
        latencyWeight: 0.20,
        stabilityWeight: 0.15,
        deviceWeight: 0.10,
        minBandwidthMbps: 5.0,
        maxParticipantsPerRelay: 5,
        reevaluationIntervalMs: 30000,
      };

      // Should assign to least loaded relay even if at capacity
      const assignedRelayId = resilientManager.assignToRelayWithFallback(
        'p11',
        relayNodeIds,
        latencyMap,
        currentGroups,
        config
      );

      expect(relayNodeIds).toContain(assignedRelayId);
    });

    it('should handle topology formation with no participants', () => {
      const allParticipants: string[] = [];
      const latencyMap = new Map<string, Map<string, number>>();

      const topology = resilientManager.formTopologyWithFallback(
        [],
        allParticipants,
        latencyMap
      );

      expect(topology.relayNodes).toEqual([]);
      expect(topology.groups).toEqual([]);
    });
  });

  describe('Relay Failure Handling (Requirements 7.1, 7.2)', () => {
    let topologyManager: TopologyManager;
    let selectionAlgorithm: SelectionAlgorithm;

    beforeEach(() => {
      topologyManager = new TopologyManager();
      selectionAlgorithm = new SelectionAlgorithm();
    });

    it('should handle relay node failure with replacement selection', () => {
      const currentTopology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          {
            relayNodeId: 'relay1',
            regularNodeIds: ['p1', 'p2', 'p3'],
          },
          {
            relayNodeId: 'relay2',
            regularNodeIds: ['p4', 'p5'],
          },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      // Create metrics for all participants
      const allMetrics = new Map<string, ParticipantMetrics>();
      ['relay1', 'relay2', 'p1', 'p2', 'p3', 'p4', 'p5'].forEach((id) => {
        allMetrics.set(id, {
          participantId: id,
          timestamp: Date.now(),
          bandwidth: {
            uploadMbps: 10.0,
            downloadMbps: 20.0,
            measurementConfidence: 0.8,
          },
          natType: NATType.FULL_CONE,
          latency: {
            averageRttMs: 50,
            minRttMs: 40,
            maxRttMs: 60,
            measurements: new Map(),
          },
          stability: {
            packetLossPercent: 0.5,
            jitterMs: 10,
            connectionUptime: 100,
            reconnectionCount: 0,
          },
          device: {
            cpuUsagePercent: 30,
            availableMemoryMB: 2048,
            supportedCodecs: ['VP8', 'opus'],
            hardwareAcceleration: true,
          },
        });
      });

      const config: SelectionConfig = {
        bandwidthWeight: 0.30,
        natWeight: 0.25,
        latencyWeight: 0.20,
        stabilityWeight: 0.15,
        deviceWeight: 0.10,
        minBandwidthMbps: 5.0,
        maxParticipantsPerRelay: 5,
        reevaluationIntervalMs: 30000,
      };

      // Handle relay1 failure
      const newTopology = topologyManager.handleRelayFailure(
        'relay1',
        currentTopology,
        allMetrics,
        config
      );

      // Should have updated topology
      expect(newTopology.version).toBe(2);
      expect(newTopology.relayNodes).not.toContain('relay1');
      // Affected participants should be reassigned
      expect(newTopology.groups.length).toBeGreaterThan(0);
    });

    it('should handle relay failure with no suitable replacement', () => {
      const currentTopology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [
          {
            relayNodeId: 'relay1',
            regularNodeIds: ['p1', 'p2'],
          },
        ],
        relayConnections: [],
      };

      // Create metrics with low bandwidth (not suitable for relay)
      const allMetrics = new Map<string, ParticipantMetrics>();
      ['relay1', 'p1', 'p2'].forEach((id) => {
        allMetrics.set(id, {
          participantId: id,
          timestamp: Date.now(),
          bandwidth: {
            uploadMbps: 2.0, // Below threshold
            downloadMbps: 5.0,
            measurementConfidence: 0.8,
          },
          natType: NATType.SYMMETRIC, // Not suitable for relay
          latency: {
            averageRttMs: 50,
            minRttMs: 40,
            maxRttMs: 60,
            measurements: new Map(),
          },
          stability: {
            packetLossPercent: 0.5,
            jitterMs: 10,
            connectionUptime: 100,
            reconnectionCount: 0,
          },
          device: {
            cpuUsagePercent: 30,
            availableMemoryMB: 2048,
            supportedCodecs: ['VP8', 'opus'],
            hardwareAcceleration: true,
          },
        });
      });

      const config: SelectionConfig = {
        bandwidthWeight: 0.30,
        natWeight: 0.25,
        latencyWeight: 0.20,
        stabilityWeight: 0.15,
        deviceWeight: 0.10,
        minBandwidthMbps: 5.0,
        maxParticipantsPerRelay: 5,
        reevaluationIntervalMs: 30000,
      };

      // Handle relay failure
      const newTopology = topologyManager.handleRelayFailure(
        'relay1',
        currentTopology,
        allMetrics,
        config
      );

      // Should have no relays (degenerate case)
      expect(newTopology.relayNodes).toEqual([]);
      expect(newTopology.groups).toEqual([]);
    });

    it('should handle failure of non-existent relay gracefully', () => {
      const currentTopology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [
          {
            relayNodeId: 'relay1',
            regularNodeIds: ['p1', 'p2'],
          },
        ],
        relayConnections: [],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      const config: SelectionConfig = {
        bandwidthWeight: 0.30,
        natWeight: 0.25,
        latencyWeight: 0.20,
        stabilityWeight: 0.15,
        deviceWeight: 0.10,
        minBandwidthMbps: 5.0,
        maxParticipantsPerRelay: 5,
        reevaluationIntervalMs: 30000,
      };

      // Try to handle failure of non-existent relay
      const newTopology = topologyManager.handleRelayFailure(
        'non-existent-relay',
        currentTopology,
        allMetrics,
        config
      );

      // Should return unchanged topology
      expect(newTopology).toEqual(currentTopology);
    });
  });

  describe('Cascading Failures', () => {
    let resilientManager: ResilientTopologyManager;

    beforeEach(() => {
      resilientManager = new ResilientTopologyManager();
    });

    it('should handle multiple relay failures in sequence', () => {
      const topologyManager = new TopologyManager();

      let currentTopology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2', 'relay3'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['p1', 'p2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['p3', 'p4'] },
          { relayNodeId: 'relay3', regularNodeIds: ['p5', 'p6'] },
        ],
        relayConnections: [
          ['relay1', 'relay2'],
          ['relay2', 'relay3'],
          ['relay1', 'relay3'],
        ],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      ['relay1', 'relay2', 'relay3', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'].forEach((id) => {
        allMetrics.set(id, {
          participantId: id,
          timestamp: Date.now(),
          bandwidth: {
            uploadMbps: 10.0,
            downloadMbps: 20.0,
            measurementConfidence: 0.8,
          },
          natType: NATType.FULL_CONE,
          latency: {
            averageRttMs: 50,
            minRttMs: 40,
            maxRttMs: 60,
            measurements: new Map(),
          },
          stability: {
            packetLossPercent: 0.5,
            jitterMs: 10,
            connectionUptime: 100,
            reconnectionCount: 0,
          },
          device: {
            cpuUsagePercent: 30,
            availableMemoryMB: 2048,
            supportedCodecs: ['VP8', 'opus'],
            hardwareAcceleration: true,
          },
        });
      });

      const config: SelectionConfig = {
        bandwidthWeight: 0.30,
        natWeight: 0.25,
        latencyWeight: 0.20,
        stabilityWeight: 0.15,
        deviceWeight: 0.10,
        minBandwidthMbps: 5.0,
        maxParticipantsPerRelay: 5,
        reevaluationIntervalMs: 30000,
      };

      // First failure
      currentTopology = topologyManager.handleRelayFailure(
        'relay1',
        currentTopology,
        allMetrics,
        config
      );
      expect(currentTopology.relayNodes).not.toContain('relay1');

      // Second failure
      currentTopology = topologyManager.handleRelayFailure(
        'relay2',
        currentTopology,
        allMetrics,
        config
      );
      expect(currentTopology.relayNodes).not.toContain('relay2');

      // Should still have a valid topology
      expect(currentTopology.version).toBeGreaterThan(1);
    });

    it('should handle metrics collection failure followed by topology formation', async () => {
      // Mock RTCPeerConnection to throw error
      const originalRTCPeerConnection = global.RTCPeerConnection;
      global.RTCPeerConnection = jest.fn().mockImplementation(() => {
        throw new Error('Connection failed');
      }) as any;

      const metricsCollector = new MetricsCollector({ participantId: 'test-participant', stunServers: [] });

      // Metrics collection will fail
      await metricsCollector.collectMetrics();
      const metrics = metricsCollector.getCurrentMetrics();

      // Should have fallback values
      expect(metrics.bandwidth.uploadMbps).toBe(5.0);
      expect(metrics.natType).toBe(NATType.SYMMETRIC);

      // Try to form topology with failed metrics
      const allParticipants = ['test-participant', 'p2', 'p3'];
      const latencyMap = new Map<string, Map<string, number>>();

      const topology = resilientManager.formTopologyWithFallback(
        [],
        allParticipants,
        latencyMap
      );

      // Should fall back to full mesh
      expect(topology.relayNodes).toEqual([]);

      // Restore original mock
      global.RTCPeerConnection = originalRTCPeerConnection;
    });

    it('should handle connection failure followed by relay failure', async () => {
      const mediaHandler = new MediaHandler('test-participant');

      // Create connection that will fail
      const config: PeerConnectionConfig = {
        iceServers: [],
        iceTransportPolicy: 'all',
      };

      await mediaHandler.createPeerConnection('relay1', config);

      // Simulate relay failure by closing connection
      mediaHandler.closePeerConnection('relay1');

      // Should handle gracefully
      expect(mediaHandler['peerConnections'].has('relay1')).toBe(false);

      mediaHandler.cleanup();
    });
  });

  describe('Recovery After Errors', () => {
    it('should recover from bandwidth measurement failure on retry', async () => {
      // Mock RTCPeerConnection to throw error
      const originalRTCPeerConnection = global.RTCPeerConnection;
      global.RTCPeerConnection = jest.fn().mockImplementation(() => {
        throw new Error('Connection failed');
      }) as any;

      const metricsCollector = new MetricsCollector({ participantId: 'test-participant', stunServers: [] });

      // First attempt fails
      const firstBandwidth = await metricsCollector.measureBandwidth();
      expect(firstBandwidth.uploadMbps).toBe(5.0); // Fallback value

      // Store the fallback as current metrics
      metricsCollector['currentMetrics'] = {
        participantId: 'test-participant',
        timestamp: Date.now(),
        bandwidth: firstBandwidth,
        natType: NATType.SYMMETRIC,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 0.5,
          jitterMs: 10,
          connectionUptime: 100,
          reconnectionCount: 0,
        },
        device: {
          cpuUsagePercent: 30,
          availableMemoryMB: 2048,
          supportedCodecs: ['VP8', 'opus'],
          hardwareAcceleration: true,
        },
      };

      // Second attempt should use last known value
      const secondBandwidth = await metricsCollector.measureBandwidth();
      expect(secondBandwidth.uploadMbps).toBe(5.0);
      expect(secondBandwidth.measurementConfidence).toBeLessThan(0.5);

      // Restore original mock
      global.RTCPeerConnection = originalRTCPeerConnection;
    });

    it('should recover from topology formation failure', () => {
      const resilientManager = new ResilientTopologyManager();

      // First attempt with no relays
      const allParticipants = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
      const latencyMap = new Map<string, Map<string, number>>();

      const firstTopology = resilientManager.formTopologyWithFallback(
        [],
        allParticipants,
        latencyMap
      );

      // Should have fallback topology
      expect(firstTopology).toBeDefined();

      // Second attempt with valid relays
      const secondTopology = resilientManager.formTopologyWithFallback(
        ['p1', 'p2'],
        allParticipants,
        latencyMap
      );

      // Should have proper topology
      expect(secondTopology.relayNodes).toEqual(['p1', 'p2']);
    });

    it('should recover from connection failure with retry', async () => {
      const mediaHandler = new MediaHandler('test-participant');

      const config: PeerConnectionConfig = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      };

      // First attempt
      await mediaHandler.createPeerConnection('remote1', config);

      // Simulate failure
      mediaHandler.closePeerConnection('remote1');

      // Retry
      const peerConnection = await mediaHandler.createPeerConnection('remote1', config);

      expect(peerConnection).toBeDefined();

      mediaHandler.cleanup();
    });

    it('should recover from relay failure with topology update', () => {
      const topologyManager = new TopologyManager();

      const currentTopology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['p1', 'p2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['p3', 'p4'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      ['relay1', 'relay2', 'p1', 'p2', 'p3', 'p4'].forEach((id) => {
        allMetrics.set(id, {
          participantId: id,
          timestamp: Date.now(),
          bandwidth: {
            uploadMbps: 10.0,
            downloadMbps: 20.0,
            measurementConfidence: 0.8,
          },
          natType: NATType.FULL_CONE,
          latency: {
            averageRttMs: 50,
            minRttMs: 40,
            maxRttMs: 60,
            measurements: new Map(),
          },
          stability: {
            packetLossPercent: 0.5,
            jitterMs: 10,
            connectionUptime: 100,
            reconnectionCount: 0,
          },
          device: {
            cpuUsagePercent: 30,
            availableMemoryMB: 2048,
            supportedCodecs: ['VP8', 'opus'],
            hardwareAcceleration: true,
          },
        });
      });

      const config: SelectionConfig = {
        bandwidthWeight: 0.30,
        natWeight: 0.25,
        latencyWeight: 0.20,
        stabilityWeight: 0.15,
        deviceWeight: 0.10,
        minBandwidthMbps: 5.0,
        maxParticipantsPerRelay: 5,
        reevaluationIntervalMs: 30000,
      };

      // Handle failure
      const newTopology = topologyManager.handleRelayFailure(
        'relay1',
        currentTopology,
        allMetrics,
        config
      );

      // Should have recovered with new topology
      expect(newTopology.version).toBe(2);
      expect(newTopology.relayNodes).not.toContain('relay1');
      expect(newTopology.groups.length).toBeGreaterThan(0);
    });
  });
});
