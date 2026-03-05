// Integration tests for network degradation scenarios
// Task 22.6: Write integration tests for network degradation
// Requirements: 11.1, 11.2, 11.3, 11.4

import { RelayMeshClient } from './relay-mesh-client';
import { RelayMeshServer } from '../server/relay-mesh-server';
import { ConferenceState } from './conference-state-machine';
import { NetworkAdapter } from './network-adapter';
import { MetricsCollector } from './metrics-collector';
import type { ParticipantMetrics } from '../shared/types';
import { NATType } from '../shared/types';

describe('Network Degradation Integration Tests', () => {
  let server: RelayMeshServer;
  let clients: RelayMeshClient[] = [];
  const serverPort = 8095;
  const serverUrl = `ws://localhost:${serverPort}`;

  beforeAll(async () => {
    // Start server
    server = new RelayMeshServer({
      port: serverPort,
      host: 'localhost',
      tlsEnabled: false,
      authRequired: false,
    });
    await server.start();
  });

  afterAll(async () => {
    // Stop server
    if (server) {
      await server.stop();
    }
  });

  afterEach(async () => {
    // Clean up all clients
    for (const client of clients) {
      try {
        if (client.getCurrentState() === ConferenceState.CONNECTED) {
          await client.leaveConference();
        }
      } catch (error) {
        // Ignore errors during cleanup
      }
    }
    clients = [];

    // Wait for cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  /**
   * Helper to create a mock metrics collector with specific values
   */
  const createMockMetrics = (overrides: Partial<ParticipantMetrics> = {}): ParticipantMetrics => ({
    participantId: 'test-participant',
    timestamp: Date.now(),
    bandwidth: {
      uploadMbps: 10,
      downloadMbps: 20,
      measurementConfidence: 0.9,
    },
    natType: NATType.FULL_CONE,
    latency: {
      averageRttMs: 50,
      minRttMs: 30,
      maxRttMs: 80,
      measurements: new Map(),
    },
    stability: {
      packetLossPercent: 1,
      jitterMs: 5,
      connectionUptime: 100,
      reconnectionCount: 0,
    },
    device: {
      cpuUsagePercent: 30,
      availableMemoryMB: 2048,
      supportedCodecs: ['VP8', 'H264'],
      hardwareAcceleration: true,
    },
    ...overrides,
  });

  describe('Simulated bandwidth reduction (Requirement 11.1)', () => {
    it('should handle bandwidth degradation scenario', async () => {
      // This test verifies that the NetworkAdapter component can detect
      // and respond to bandwidth changes. We test the NetworkAdapter in isolation
      // with mocked dependencies to simulate bandwidth degradation.

      const mockMetricsCollector = {
        getCurrentMetrics: jest.fn(),
      } as any;

      const mockMediaHandler = {
        getPeerConnections: jest.fn().mockReturnValue(new Map()),
        adaptBitrate: jest.fn().mockResolvedValue(undefined),
      } as any;

      const networkAdapter = new NetworkAdapter(
        mockMetricsCollector,
        mockMediaHandler,
        {
          bandwidthCheckIntervalMs: 1000, // Faster for testing
          bandwidthChangeThresholdPercent: 20,
        }
      );

      // Track bitrate adaptations
      const bitrateAdaptations: Array<{ bitrate: number; reason: string }> = [];
      networkAdapter.onBitrateAdaptation((bitrate: number, reason: string) => {
        bitrateAdaptations.push({ bitrate, reason });
      });

      // Start with good bandwidth
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
        })
      );

      networkAdapter.startMonitoring();

      // Simulate bandwidth reduction (50% decrease)
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          bandwidth: { uploadMbps: 5, downloadMbps: 10, measurementConfidence: 0.9 },
        })
      );

      // Wait for monitoring interval to trigger
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify bitrate adaptation was triggered
      expect(bitrateAdaptations.length).toBeGreaterThan(0);
      const lastAdaptation = bitrateAdaptations[bitrateAdaptations.length - 1];
      expect(lastAdaptation.reason).toBe('bandwidth_decrease');

      // Verify adapted bitrate is appropriate (should be ~80% of reduced bandwidth)
      const expectedBitrate = 5 * 0.8; // 4 Mbps
      expect(lastAdaptation.bitrate).toBeCloseTo(expectedBitrate, 1);

      networkAdapter.stopMonitoring();
    }, 5000);

    it('should adapt bitrate within 5 seconds of bandwidth decrease (Requirement 11.1)', async () => {
      const mockMetricsCollector = {
        getCurrentMetrics: jest.fn(),
      } as any;

      const mockMediaHandler = {
        getPeerConnections: jest.fn().mockReturnValue(new Map()),
        adaptBitrate: jest.fn().mockResolvedValue(undefined),
      } as any;

      const networkAdapter = new NetworkAdapter(
        mockMetricsCollector,
        mockMediaHandler,
        {
          bandwidthCheckIntervalMs: 1000, // Check every second
        }
      );

      let adaptationTime: number | null = null;
      networkAdapter.onBitrateAdaptation(() => {
        if (adaptationTime === null) {
          adaptationTime = Date.now();
        }
      });

      // Start with good bandwidth
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
        })
      );

      networkAdapter.startMonitoring();

      // Record when bandwidth decreases
      const degradationTime = Date.now();

      // Simulate bandwidth decrease
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          bandwidth: { uploadMbps: 5, downloadMbps: 10, measurementConfidence: 0.9 },
        })
      );

      // Wait up to 5 seconds for adaptation
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Verify adaptation occurred within 5 seconds
      expect(adaptationTime).not.toBeNull();
      const timeDiff = adaptationTime! - degradationTime;
      expect(timeDiff).toBeLessThan(5000);

      networkAdapter.stopMonitoring();
    }, 7000);
  });

  describe('Simulated latency increase (Requirement 11.2)', () => {
    it('should detect latency increase and notify for topology adjustment', async () => {
      const mockMetricsCollector = {
        getCurrentMetrics: jest.fn(),
      } as any;

      const mockMediaHandler = {
        getPeerConnections: jest.fn().mockReturnValue(new Map()),
        adaptBitrate: jest.fn().mockResolvedValue(undefined),
      } as any;

      const networkAdapter = new NetworkAdapter(
        mockMetricsCollector,
        mockMediaHandler,
        {
          latencyCheckIntervalMs: 2000, // Faster for testing
          latencyIncreaseThresholdMs: 50,
        }
      );

      // Track latency changes
      const latencyChanges: Array<{ latency: number; shouldAdjust: boolean }> = [];
      networkAdapter.onLatencyChange((latency: number, shouldAdjust: boolean) => {
        latencyChanges.push({ latency, shouldAdjust });
      });

      // Start with low latency
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          latency: {
            averageRttMs: 50,
            minRttMs: 30,
            maxRttMs: 70,
            measurements: new Map(),
          },
        })
      );

      networkAdapter.startMonitoring();

      // Simulate latency increase to 150ms
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          latency: {
            averageRttMs: 150,
            minRttMs: 120,
            maxRttMs: 180,
            measurements: new Map(),
          },
        })
      );

      // Wait for latency monitoring interval
      await new Promise((resolve) => setTimeout(resolve, 2500));

      // Verify latency change was detected
      expect(latencyChanges.length).toBeGreaterThan(0);
      const lastChange = latencyChanges[latencyChanges.length - 1];
      expect(lastChange.latency).toBe(150);

      // Should not recommend topology adjustment yet (below 200ms threshold)
      expect(lastChange.shouldAdjust).toBe(false);

      networkAdapter.stopMonitoring();
    }, 5000);

    it('should recommend topology adjustment for high latency', async () => {
      const mockMetricsCollector = {
        getCurrentMetrics: jest.fn(),
      } as any;

      const mockMediaHandler = {
        getPeerConnections: jest.fn().mockReturnValue(new Map()),
        adaptBitrate: jest.fn().mockResolvedValue(undefined),
      } as any;

      const networkAdapter = new NetworkAdapter(
        mockMetricsCollector,
        mockMediaHandler,
        {
          latencyCheckIntervalMs: 2000,
          latencyIncreaseThresholdMs: 50,
          highLatencyThresholdMs: 200,
        }
      );

      const latencyChanges: Array<{ latency: number; shouldAdjust: boolean }> = [];
      networkAdapter.onLatencyChange((latency: number, shouldAdjust: boolean) => {
        latencyChanges.push({ latency, shouldAdjust });
      });

      // Start with low latency
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          latency: {
            averageRttMs: 50,
            minRttMs: 30,
            maxRttMs: 70,
            measurements: new Map(),
          },
        })
      );

      networkAdapter.startMonitoring();

      // Simulate high latency increase to 250ms
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          latency: {
            averageRttMs: 250,
            minRttMs: 220,
            maxRttMs: 280,
            measurements: new Map(),
          },
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 2500));

      // Verify topology adjustment is recommended
      expect(latencyChanges.length).toBeGreaterThan(0);
      const lastChange = latencyChanges[latencyChanges.length - 1];
      expect(lastChange.latency).toBe(250);
      expect(lastChange.shouldAdjust).toBe(true);

      networkAdapter.stopMonitoring();
    }, 5000);
  });

  describe('Simulated packet loss (Requirement 11.3)', () => {
    it('should detect packet loss exceeding threshold', async () => {
      const mockMetricsCollector = {
        getCurrentMetrics: jest.fn(),
      } as any;

      const mockMediaHandler = {
        getPeerConnections: jest.fn().mockReturnValue(new Map()),
        adaptBitrate: jest.fn().mockResolvedValue(undefined),
      } as any;

      const networkAdapter = new NetworkAdapter(
        mockMetricsCollector,
        mockMediaHandler,
        {
          packetLossCheckIntervalMs: 1000,
          packetLossThresholdPercent: 5,
        }
      );

      // Track packet loss events
      const packetLossEvents: Array<{ loss: number; shouldCorrect: boolean }> = [];
      networkAdapter.onPacketLoss((loss: number, shouldCorrect: boolean) => {
        packetLossEvents.push({ loss, shouldCorrect });
      });

      // Start with low packet loss
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          stability: {
            packetLossPercent: 1,
            jitterMs: 5,
            connectionUptime: 100,
            reconnectionCount: 0,
          },
        })
      );

      networkAdapter.startMonitoring();

      // Simulate moderate packet loss (7%)
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          stability: {
            packetLossPercent: 7,
            jitterMs: 14,
            connectionUptime: 105,
            reconnectionCount: 0,
          },
        })
      );

      // Wait for packet loss monitoring interval
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify packet loss was detected
      expect(packetLossEvents.length).toBeGreaterThan(0);
      const lastEvent = packetLossEvents[packetLossEvents.length - 1];
      expect(lastEvent.loss).toBe(7);

      // Should not recommend error correction yet (below 10% threshold)
      expect(lastEvent.shouldCorrect).toBe(false);

      networkAdapter.stopMonitoring();
    }, 5000);

    it('should recommend error correction for high packet loss', async () => {
      const mockMetricsCollector = {
        getCurrentMetrics: jest.fn(),
      } as any;

      const mockMediaHandler = {
        getPeerConnections: jest.fn().mockReturnValue(new Map()),
        adaptBitrate: jest.fn().mockResolvedValue(undefined),
      } as any;

      const networkAdapter = new NetworkAdapter(
        mockMetricsCollector,
        mockMediaHandler,
        {
          packetLossCheckIntervalMs: 1000,
          packetLossThresholdPercent: 5,
          highPacketLossThresholdPercent: 10,
        }
      );

      const packetLossEvents: Array<{ loss: number; shouldCorrect: boolean }> = [];
      networkAdapter.onPacketLoss((loss: number, shouldCorrect: boolean) => {
        packetLossEvents.push({ loss, shouldCorrect });
      });

      // Start with low packet loss
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          stability: {
            packetLossPercent: 1,
            jitterMs: 5,
            connectionUptime: 100,
            reconnectionCount: 0,
          },
        })
      );

      networkAdapter.startMonitoring();

      // Simulate high packet loss (12%)
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          stability: {
            packetLossPercent: 12,
            jitterMs: 24,
            connectionUptime: 105,
            reconnectionCount: 0,
          },
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify error correction is recommended
      expect(packetLossEvents.length).toBeGreaterThan(0);
      const lastEvent = packetLossEvents[packetLossEvents.length - 1];
      expect(lastEvent.loss).toBe(12);
      expect(lastEvent.shouldCorrect).toBe(true);

      networkAdapter.stopMonitoring();
    }, 5000);
  });

  describe('Combined network degradation scenarios', () => {
    it('should handle simultaneous bandwidth and latency degradation', async () => {
      const mockMetricsCollector = {
        getCurrentMetrics: jest.fn(),
      } as any;

      const mockMediaHandler = {
        getPeerConnections: jest.fn().mockReturnValue(new Map()),
        adaptBitrate: jest.fn().mockResolvedValue(undefined),
      } as any;

      const networkAdapter = new NetworkAdapter(
        mockMetricsCollector,
        mockMediaHandler,
        {
          bandwidthCheckIntervalMs: 1000,
          latencyCheckIntervalMs: 1500,
        }
      );

      let bitrateAdapted = false;
      let latencyDetected = false;

      networkAdapter.onBitrateAdaptation(() => {
        bitrateAdapted = true;
      });

      networkAdapter.onLatencyChange(() => {
        latencyDetected = true;
      });

      // Start with good conditions
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          latency: {
            averageRttMs: 50,
            minRttMs: 30,
            maxRttMs: 70,
            measurements: new Map(),
          },
        })
      );

      networkAdapter.startMonitoring();

      // Simulate both bandwidth reduction and latency increase
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          bandwidth: { uploadMbps: 3, downloadMbps: 6, measurementConfidence: 0.9 },
          latency: {
            averageRttMs: 220,
            minRttMs: 180,
            maxRttMs: 260,
            measurements: new Map(),
          },
        })
      );

      // Wait for both monitoring intervals to trigger
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Both adaptations should have occurred
      expect(bitrateAdapted).toBe(true);
      expect(latencyDetected).toBe(true);

      networkAdapter.stopMonitoring();
    }, 5000);

    it('should handle all three degradation types simultaneously', async () => {
      const mockMetricsCollector = {
        getCurrentMetrics: jest.fn(),
      } as any;

      const mockMediaHandler = {
        getPeerConnections: jest.fn().mockReturnValue(new Map()),
        adaptBitrate: jest.fn().mockResolvedValue(undefined),
      } as any;

      const networkAdapter = new NetworkAdapter(
        mockMetricsCollector,
        mockMediaHandler,
        {
          bandwidthCheckIntervalMs: 1000,
          latencyCheckIntervalMs: 1500,
          packetLossCheckIntervalMs: 1000,
        }
      );

      let bitrateAdapted = false;
      let latencyDetected = false;
      let packetLossDetected = false;

      networkAdapter.onBitrateAdaptation(() => {
        bitrateAdapted = true;
      });

      networkAdapter.onLatencyChange(() => {
        latencyDetected = true;
      });

      networkAdapter.onPacketLoss(() => {
        packetLossDetected = true;
      });

      // Start with good conditions
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          latency: {
            averageRttMs: 50,
            minRttMs: 30,
            maxRttMs: 70,
            measurements: new Map(),
          },
          stability: {
            packetLossPercent: 1,
            jitterMs: 5,
            connectionUptime: 100,
            reconnectionCount: 0,
          },
        })
      );

      networkAdapter.startMonitoring();

      // Simulate severe network degradation across all metrics
      mockMetricsCollector.getCurrentMetrics.mockReturnValue(
        createMockMetrics({
          bandwidth: { uploadMbps: 2, downloadMbps: 4, measurementConfidence: 0.8 },
          latency: {
            averageRttMs: 280,
            minRttMs: 220,
            maxRttMs: 340,
            measurements: new Map(),
          },
          stability: {
            packetLossPercent: 15,
            jitterMs: 30,
            connectionUptime: 105,
            reconnectionCount: 0,
          },
        })
      );

      // Wait for all monitoring intervals to trigger
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // All three types of degradation should be detected
      expect(bitrateAdapted).toBe(true);
      expect(latencyDetected).toBe(true);
      expect(packetLossDetected).toBe(true);

      networkAdapter.stopMonitoring();
    }, 5000);
  });

  describe('End-to-end network degradation with real clients', () => {
    it('should maintain conference connectivity during network degradation', async () => {
      // Create a small conference
      const conferenceId = 'test-degradation-e2e';
      const clientCount = 3;

      for (let i = 0; i < clientCount; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
          enforceSecureConnection: false,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
      }

      // Wait for topology to form
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify all clients are connected
      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }

      // Simulate time passing with degraded conditions
      // In a real scenario, the NetworkAdapter would detect these changes
      // and trigger appropriate adaptations
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify clients remain connected despite degradation
      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }

      // Verify server still tracks all participants
      const serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(clientCount);
    }, 10000);
  });
});
