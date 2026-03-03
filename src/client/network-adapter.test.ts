import {
  NetworkAdapter,
  NetworkAdapterConfig,
  DEFAULT_NETWORK_ADAPTER_CONFIG,
} from './network-adapter';
import { MetricsCollector } from './metrics-collector';
import { MediaHandler } from './media-handler';
import { TopologyManager } from './topology-manager';
import {
  ParticipantMetrics,
  BandwidthMetrics,
  LatencyMetrics,
  StabilityMetrics,
  DeviceMetrics,
  NATType,
} from '../shared/types';

// Mock dependencies
jest.mock('./metrics-collector');
jest.mock('./media-handler');
jest.mock('./topology-manager');

describe('NetworkAdapter', () => {
  let networkAdapter: NetworkAdapter;
  let mockMetricsCollector: jest.Mocked<MetricsCollector>;
  let mockMediaHandler: jest.Mocked<MediaHandler>;
  let mockTopologyManager: jest.Mocked<TopologyManager>;

  const createMockMetrics = (
    overrides: Partial<ParticipantMetrics> = {}
  ): ParticipantMetrics => ({
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

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockMetricsCollector = new MetricsCollector({
      participantId: 'test',
      stunServers: [],
    }) as jest.Mocked<MetricsCollector>;

    mockMediaHandler = new MediaHandler(
      'test-participant'
    ) as jest.Mocked<MediaHandler>;

    mockTopologyManager = new TopologyManager() as jest.Mocked<TopologyManager>;

    // Setup default mock implementations
    mockMetricsCollector.getCurrentMetrics = jest
      .fn()
      .mockReturnValue(createMockMetrics());

    mockMediaHandler.getPeerConnections = jest
      .fn()
      .mockReturnValue(new Map());

    mockMediaHandler.adaptBitrate = jest.fn().mockResolvedValue(undefined);

    networkAdapter = new NetworkAdapter(mockMetricsCollector, mockMediaHandler);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Bandwidth Monitoring and Adaptation (Task 19.1)', () => {
    describe('startMonitoring', () => {
      it('should start monitoring network conditions', () => {
        networkAdapter.startMonitoring();

        expect(networkAdapter.isActive()).toBe(true);
      });

      it('should not start monitoring twice', () => {
        networkAdapter.startMonitoring();
        networkAdapter.startMonitoring();

        expect(networkAdapter.isActive()).toBe(true);
      });

      it('should initialize baseline bandwidth values', () => {
        const initialMetrics = createMockMetrics({
          bandwidth: { uploadMbps: 15, downloadMbps: 30, measurementConfidence: 0.9 },
        });
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(initialMetrics);

        networkAdapter.startMonitoring();

        const conditions = networkAdapter.getCurrentConditions();
        expect(conditions.bandwidthMbps).toBe(15);
      });
    });

    describe('stopMonitoring', () => {
      it('should stop monitoring network conditions', () => {
        networkAdapter.startMonitoring();
        networkAdapter.stopMonitoring();

        expect(networkAdapter.isActive()).toBe(false);
      });

      it('should clear all monitoring intervals', () => {
        networkAdapter.startMonitoring();
        networkAdapter.stopMonitoring();

        // Advance timers to ensure intervals don't fire
        jest.advanceTimersByTime(10000);

        // Metrics should not be checked after stopping
        const callCountBefore = mockMetricsCollector.getCurrentMetrics.mock.calls.length;
        jest.advanceTimersByTime(10000);
        const callCountAfter = mockMetricsCollector.getCurrentMetrics.mock.calls.length;

        expect(callCountAfter).toBe(callCountBefore);
      });
    });

    describe('bandwidth change detection', () => {
      it('should detect bandwidth decrease exceeding threshold', async () => {
        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Decrease to 7 Mbps (30% decrease, exceeds 20% threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 7, downloadMbps: 14, measurementConfidence: 0.9 },
          })
        );

        // Advance time to trigger bandwidth check
        await jest.advanceTimersByTimeAsync(5000);

        expect(bitrateCallback).toHaveBeenCalledWith(
          expect.any(Number),
          'bandwidth_decrease'
        );
      });

      it('should detect bandwidth increase exceeding threshold', async () => {
        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Increase to 15 Mbps (50% increase, exceeds 20% threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 15, downloadMbps: 30, measurementConfidence: 0.9 },
          })
        );

        // Advance time to trigger bandwidth check
        await jest.advanceTimersByTimeAsync(5000);

        expect(bitrateCallback).toHaveBeenCalledWith(
          expect.any(Number),
          'bandwidth_increase'
        );
      });

      it('should not trigger adaptation for small bandwidth changes', async () => {
        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Small change to 10.5 Mbps (5% change, below 20% threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10.5, downloadMbps: 21, measurementConfidence: 0.9 },
          })
        );

        // Advance time to trigger bandwidth check
        await jest.advanceTimersByTimeAsync(5000);

        expect(bitrateCallback).not.toHaveBeenCalled();
      });
    });

    describe('bitrate adaptation', () => {
      it('should adapt bitrate for all peer connections', async () => {
        const mockPeerConnection1 = {} as RTCPeerConnection;
        const mockPeerConnection2 = {} as RTCPeerConnection;

        mockMediaHandler.getPeerConnections.mockReturnValue(
          new Map([
            ['peer1', mockPeerConnection1],
            ['peer2', mockPeerConnection2],
          ])
        );

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Decrease to 5 Mbps (50% decrease)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 5, downloadMbps: 10, measurementConfidence: 0.9 },
          })
        );

        // Advance time to trigger bandwidth check
        await jest.advanceTimersByTimeAsync(5000);

        // Should adapt bitrate for both connections
        expect(mockMediaHandler.adaptBitrate).toHaveBeenCalledTimes(2);
        expect(mockMediaHandler.adaptBitrate).toHaveBeenCalledWith(
          mockPeerConnection1,
          expect.any(Number)
        );
        expect(mockMediaHandler.adaptBitrate).toHaveBeenCalledWith(
          mockPeerConnection2,
          expect.any(Number)
        );
      });

      it('should use 80% of available bandwidth as target bitrate', async () => {
        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Change to 5 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 5, downloadMbps: 10, measurementConfidence: 0.9 },
          })
        );

        // Advance time to trigger bandwidth check
        await jest.advanceTimersByTimeAsync(5000);

        // Target should be 5 * 0.8 = 4 Mbps
        expect(bitrateCallback).toHaveBeenCalledWith(4, 'bandwidth_decrease');
      });

      it('should respect minimum bitrate limit', async () => {
        const config: Partial<NetworkAdapterConfig> = {
          minBitrateMbps: 1.0,
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with 2 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 2, downloadMbps: 4, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Drop to 0.5 Mbps (would result in 0.4 Mbps target)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 0.5, downloadMbps: 1, measurementConfidence: 0.9 },
          })
        );

        // Advance time to trigger bandwidth check
        await jest.advanceTimersByTimeAsync(5000);

        // Should use minimum bitrate of 1.0 Mbps
        expect(bitrateCallback).toHaveBeenCalledWith(1.0, 'bandwidth_decrease');
      });

      it('should respect maximum bitrate limit', async () => {
        const config: Partial<NetworkAdapterConfig> = {
          maxBitrateMbps: 8.0,
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Increase to 20 Mbps (would result in 16 Mbps target)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 20, downloadMbps: 40, measurementConfidence: 0.9 },
          })
        );

        // Advance time to trigger bandwidth check
        await jest.advanceTimersByTimeAsync(5000);

        // Should use maximum bitrate of 8.0 Mbps
        expect(bitrateCallback).toHaveBeenCalledWith(8.0, 'bandwidth_increase');
      });

      it('should handle adaptation errors gracefully', async () => {
        const mockPeerConnection = {} as RTCPeerConnection;
        mockMediaHandler.getPeerConnections.mockReturnValue(
          new Map([['peer1', mockPeerConnection]])
        );

        // Make adaptation fail
        mockMediaHandler.adaptBitrate.mockRejectedValue(
          new Error('Adaptation failed')
        );

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Trigger bandwidth change
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 5, downloadMbps: 10, measurementConfidence: 0.9 },
          })
        );

        // Advance time to trigger bandwidth check
        await jest.advanceTimersByTimeAsync(5000);

        // Should not throw error
        expect(mockMediaHandler.adaptBitrate).toHaveBeenCalled();
      });
    });

    describe('configuration', () => {
      it('should use custom bandwidth check interval', () => {
        const config: Partial<NetworkAdapterConfig> = {
          bandwidthCheckIntervalMs: 10000,
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        networkAdapter.startMonitoring();

        // Should not check at 5 seconds
        jest.advanceTimersByTime(5000);
        const callsAt5s = mockMetricsCollector.getCurrentMetrics.mock.calls.length;

        // Should check at 10 seconds
        jest.advanceTimersByTime(5000);
        const callsAt10s = mockMetricsCollector.getCurrentMetrics.mock.calls.length;

        expect(callsAt10s).toBeGreaterThan(callsAt5s);
      });

      it('should use custom bandwidth change threshold', async () => {
        const config: Partial<NetworkAdapterConfig> = {
          bandwidthChangeThresholdPercent: 50, // Require 50% change
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // 30% change (below 50% threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 7, downloadMbps: 14, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);

        // Should not trigger adaptation
        expect(bitrateCallback).not.toHaveBeenCalled();

        // 60% change (exceeds 50% threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 4, downloadMbps: 8, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);

        // Should trigger adaptation
        expect(bitrateCallback).toHaveBeenCalled();
      });
    });
  });

  describe('getCurrentConditions', () => {
    it('should return current network conditions', () => {
      const metrics = createMockMetrics({
        bandwidth: { uploadMbps: 12, downloadMbps: 24, measurementConfidence: 0.9 },
        latency: {
          averageRttMs: 75,
          minRttMs: 50,
          maxRttMs: 100,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 3,
          jitterMs: 10,
          connectionUptime: 200,
          reconnectionCount: 1,
        },
      });

      mockMetricsCollector.getCurrentMetrics.mockReturnValue(metrics);

      const conditions = networkAdapter.getCurrentConditions();

      expect(conditions).toEqual({
        bandwidthMbps: 12,
        averageLatencyMs: 75,
        packetLossPercent: 3,
      });
    });
  });

  describe('Latency Monitoring and Topology Adjustment (Task 19.2)', () => {
    describe('latency change detection', () => {
      it('should detect latency increase exceeding threshold', async () => {
        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with 50ms latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 50,
              minRttMs: 30,
              maxRttMs: 80,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Increase to 120ms (70ms increase, exceeds 50ms threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 120,
              minRttMs: 90,
              maxRttMs: 150,
              measurements: new Map(),
            },
          })
        );

        // Advance time to trigger latency check (10 seconds)
        await jest.advanceTimersByTimeAsync(10000);

        expect(latencyCallback).toHaveBeenCalledWith(120, false);
      });

      it('should recommend topology adjustment for high latency', async () => {
        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with 50ms latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 50,
              minRttMs: 30,
              maxRttMs: 80,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Increase to 250ms (200ms increase, exceeds threshold and high latency threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 250,
              minRttMs: 200,
              maxRttMs: 300,
              measurements: new Map(),
            },
          })
        );

        // Advance time to trigger latency check
        await jest.advanceTimersByTimeAsync(10000);

        // Should recommend topology adjustment (shouldAdjustTopology = true)
        expect(latencyCallback).toHaveBeenCalledWith(250, true);
      });

      it('should not trigger notification for small latency changes', async () => {
        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with 50ms latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 50,
              minRttMs: 30,
              maxRttMs: 80,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Small increase to 70ms (20ms increase, below 50ms threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 70,
              minRttMs: 50,
              maxRttMs: 90,
              measurements: new Map(),
            },
          })
        );

        // Advance time to trigger latency check
        await jest.advanceTimersByTimeAsync(10000);

        expect(latencyCallback).not.toHaveBeenCalled();
      });

      it('should not trigger notification for latency decrease', async () => {
        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with 100ms latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 100,
              minRttMs: 80,
              maxRttMs: 120,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Decrease to 50ms (latency improvement)
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

        // Advance time to trigger latency check
        await jest.advanceTimersByTimeAsync(10000);

        // Should not trigger notification for improvements
        expect(latencyCallback).not.toHaveBeenCalled();
      });
    });

    describe('configuration', () => {
      it('should use custom latency check interval', async () => {
        const config: Partial<NetworkAdapterConfig> = {
          latencyCheckIntervalMs: 20000, // 20 seconds
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with 50ms latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 50,
              minRttMs: 30,
              maxRttMs: 80,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Trigger latency change
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

        // Should not check at 10 seconds
        await jest.advanceTimersByTimeAsync(10000);
        expect(latencyCallback).not.toHaveBeenCalled();

        // Should check at 20 seconds
        await jest.advanceTimersByTimeAsync(10000);
        expect(latencyCallback).toHaveBeenCalled();
      });

      it('should use custom latency increase threshold', async () => {
        const config: Partial<NetworkAdapterConfig> = {
          latencyIncreaseThresholdMs: 100, // Require 100ms increase
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with 50ms latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 50,
              minRttMs: 30,
              maxRttMs: 80,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // 80ms increase (below 100ms threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 130,
              minRttMs: 100,
              maxRttMs: 160,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);
        expect(latencyCallback).not.toHaveBeenCalled();

        // 120ms increase (exceeds 100ms threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 170,
              minRttMs: 140,
              maxRttMs: 200,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);
        expect(latencyCallback).toHaveBeenCalled();
      });

      it('should use custom high latency threshold', async () => {
        const config: Partial<NetworkAdapterConfig> = {
          highLatencyThresholdMs: 150, // Custom threshold for topology adjustment
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with 50ms latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 50,
              minRttMs: 30,
              maxRttMs: 80,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Increase to 140ms (below custom high latency threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 140,
              minRttMs: 110,
              maxRttMs: 170,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);

        // Should not recommend topology adjustment
        expect(latencyCallback).toHaveBeenCalledWith(140, false);

        // Increase to 200ms (exceeds custom high latency threshold and increase threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 200,
              minRttMs: 170,
              maxRttMs: 230,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);

        // Should recommend topology adjustment (200ms >= 150ms threshold)
        expect(latencyCallback).toHaveBeenCalledWith(200, true);
      });
    });

    describe('topology manager integration', () => {
      it('should allow setting topology manager', () => {
        networkAdapter.setTopologyManager(mockTopologyManager);

        // Should not throw error
        expect(networkAdapter).toBeDefined();
      });
    });
  });

  describe('Packet Loss Detection and Error Correction (Task 19.3)', () => {
    describe('packet loss detection', () => {
      it('should detect packet loss exceeding threshold', async () => {
        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with 1% packet loss
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

        // Increase to 7% packet loss (exceeds 5% threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 7,
              jitterMs: 15,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        // Advance time to trigger packet loss check (5 seconds)
        await jest.advanceTimersByTimeAsync(5000);

        expect(packetLossCallback).toHaveBeenCalledWith(7, false);
      });

      it('should recommend error correction for high packet loss', async () => {
        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with 1% packet loss
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

        // Increase to 12% packet loss (exceeds 10% high threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 12,
              jitterMs: 25,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        // Advance time to trigger packet loss check
        await jest.advanceTimersByTimeAsync(5000);

        // Should recommend error correction (shouldApplyCorrection = true)
        expect(packetLossCallback).toHaveBeenCalledWith(12, true);
      });

      it('should not trigger notification for low packet loss', async () => {
        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with 1% packet loss
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

        // Small increase to 3% packet loss (below 5% threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 3,
              jitterMs: 8,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        // Advance time to trigger packet loss check
        await jest.advanceTimersByTimeAsync(5000);

        expect(packetLossCallback).not.toHaveBeenCalled();
      });

      it('should continue monitoring packet loss over time', async () => {
        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with 1% packet loss
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

        // First check - 6% packet loss
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 6,
              jitterMs: 12,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(packetLossCallback).toHaveBeenCalledTimes(1);

        // Second check - 8% packet loss
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 8,
              jitterMs: 18,
              connectionUptime: 110,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(packetLossCallback).toHaveBeenCalledTimes(2);
      });
    });

    describe('configuration', () => {
      it('should use custom packet loss check interval', async () => {
        const config: Partial<NetworkAdapterConfig> = {
          packetLossCheckIntervalMs: 10000, // 10 seconds
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with 1% packet loss
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

        // Trigger packet loss
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 7,
              jitterMs: 15,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        // Should not check at 5 seconds
        await jest.advanceTimersByTimeAsync(5000);
        expect(packetLossCallback).not.toHaveBeenCalled();

        // Should check at 10 seconds
        await jest.advanceTimersByTimeAsync(5000);
        expect(packetLossCallback).toHaveBeenCalled();
      });

      it('should use custom packet loss threshold', async () => {
        const config: Partial<NetworkAdapterConfig> = {
          packetLossThresholdPercent: 8, // Require 8% packet loss
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with 1% packet loss
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

        // 6% packet loss (below 8% threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 6,
              jitterMs: 12,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(packetLossCallback).not.toHaveBeenCalled();

        // 9% packet loss (exceeds 8% threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 9,
              jitterMs: 20,
              connectionUptime: 110,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(packetLossCallback).toHaveBeenCalled();
      });

      it('should use custom high packet loss threshold', async () => {
        const config: Partial<NetworkAdapterConfig> = {
          highPacketLossThresholdPercent: 15, // Custom threshold for error correction
        };

        networkAdapter = new NetworkAdapter(
          mockMetricsCollector,
          mockMediaHandler,
          config
        );

        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with 1% packet loss
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

        // 12% packet loss (below custom high threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 12,
              jitterMs: 25,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);

        // Should not recommend error correction
        expect(packetLossCallback).toHaveBeenCalledWith(12, false);

        // 16% packet loss (exceeds custom high threshold)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 16,
              jitterMs: 35,
              connectionUptime: 110,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);

        // Should recommend error correction
        expect(packetLossCallback).toHaveBeenCalledWith(16, true);
      });
    });
  });

  describe('Network Adaptation Scenarios (Task 19.4)', () => {
    describe('bandwidth degradation scenarios', () => {
      it('should handle gradual bandwidth degradation', async () => {
        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with good bandwidth
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // First degradation: 10 -> 8 Mbps (20% decrease)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 8, downloadMbps: 16, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(6.4, 'bandwidth_decrease');

        // Second degradation: 8 -> 6 Mbps (25% decrease)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 6, downloadMbps: 12, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(expect.closeTo(4.8, 1), 'bandwidth_decrease');

        // Third degradation: 6 -> 4 Mbps (33% decrease)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 4, downloadMbps: 8, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(3.2, 'bandwidth_decrease');
        expect(bitrateCallback).toHaveBeenCalledTimes(3);
      });

      it('should handle severe bandwidth degradation', async () => {
        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with good bandwidth
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Severe drop: 10 -> 2 Mbps (80% decrease)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 2, downloadMbps: 4, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);

        // Should adapt to 2 * 0.8 = 1.6 Mbps
        expect(bitrateCallback).toHaveBeenCalledWith(1.6, 'bandwidth_decrease');
      });

      it('should handle bandwidth recovery after degradation', async () => {
        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with good bandwidth
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Degradation: 10 -> 5 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 5, downloadMbps: 10, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(4, 'bandwidth_decrease');

        // Recovery: 5 -> 9 Mbps (80% increase)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 9, downloadMbps: 18, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(7.2, 'bandwidth_increase');
        expect(bitrateCallback).toHaveBeenCalledTimes(2);
      });

      it('should handle bandwidth fluctuations', async () => {
        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Drop to 7 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 7, downloadMbps: 14, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(expect.closeTo(5.6, 1), 'bandwidth_decrease');

        // Recover to 9 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 9, downloadMbps: 18, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(7.2, 'bandwidth_increase');

        // Drop again to 6 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 6, downloadMbps: 12, measurementConfidence: 0.9 },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(expect.closeTo(4.8, 1), 'bandwidth_decrease');
        expect(bitrateCallback).toHaveBeenCalledTimes(3);
      });
    });

    describe('latency spike scenarios', () => {
      it('should handle sudden latency spike', async () => {
        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with low latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 30,
              minRttMs: 20,
              maxRttMs: 50,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Sudden spike: 30 -> 180 ms (150ms increase)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 180,
              minRttMs: 150,
              maxRttMs: 220,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);

        // Should detect spike but not recommend topology adjustment (below 200ms)
        expect(latencyCallback).toHaveBeenCalledWith(180, false);
      });

      it('should handle severe latency spike requiring topology adjustment', async () => {
        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with low latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 40,
              minRttMs: 30,
              maxRttMs: 60,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Severe spike: 40 -> 300 ms (260ms increase)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 300,
              minRttMs: 250,
              maxRttMs: 350,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);

        // Should recommend topology adjustment (exceeds 200ms threshold)
        expect(latencyCallback).toHaveBeenCalledWith(300, true);
      });

      it('should handle gradual latency increase', async () => {
        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with low latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 50,
              minRttMs: 40,
              maxRttMs: 70,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // First increase: 50 -> 110 ms (60ms increase)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 110,
              minRttMs: 90,
              maxRttMs: 140,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);
        expect(latencyCallback).toHaveBeenCalledWith(110, false);

        // Second increase: 110 -> 180 ms (70ms increase)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 180,
              minRttMs: 150,
              maxRttMs: 220,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);
        expect(latencyCallback).toHaveBeenCalledWith(180, false);

        // Third increase: 180 -> 250 ms (70ms increase, now high)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 250,
              minRttMs: 220,
              maxRttMs: 290,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);
        expect(latencyCallback).toHaveBeenCalledWith(250, true);
        expect(latencyCallback).toHaveBeenCalledTimes(3);
      });

      it('should handle latency recovery', async () => {
        const latencyCallback = jest.fn();
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with high latency
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 250,
              minRttMs: 220,
              maxRttMs: 290,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Recovery: 250 -> 80 ms (latency improvement)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            latency: {
              averageRttMs: 80,
              minRttMs: 60,
              maxRttMs: 110,
              measurements: new Map(),
            },
          })
        );

        await jest.advanceTimersByTimeAsync(10000);

        // Should not trigger notification for latency improvements
        expect(latencyCallback).not.toHaveBeenCalled();
      });
    });

    describe('packet loss scenarios', () => {
      it('should handle sudden packet loss spike', async () => {
        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with low packet loss
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 0.5,
              jitterMs: 3,
              connectionUptime: 100,
              reconnectionCount: 0,
            },
          })
        );

        networkAdapter.startMonitoring();

        // Sudden spike: 0.5% -> 8%
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 8,
              jitterMs: 20,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);

        // Should detect but not recommend error correction (below 10%)
        expect(packetLossCallback).toHaveBeenCalledWith(8, false);
      });

      it('should handle severe packet loss requiring error correction', async () => {
        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

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

        // Severe spike: 1% -> 15%
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 15,
              jitterMs: 35,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);

        // Should recommend error correction (exceeds 10% threshold)
        expect(packetLossCallback).toHaveBeenCalledWith(15, true);
      });

      it('should handle gradual packet loss increase', async () => {
        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

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

        // First increase: 1% -> 6%
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 6,
              jitterMs: 12,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(packetLossCallback).toHaveBeenCalledWith(6, false);

        // Second increase: 6% -> 9%
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 9,
              jitterMs: 20,
              connectionUptime: 110,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(packetLossCallback).toHaveBeenCalledWith(9, false);

        // Third increase: 9% -> 13% (now requires correction)
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 13,
              jitterMs: 30,
              connectionUptime: 115,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(packetLossCallback).toHaveBeenCalledWith(13, true);
        expect(packetLossCallback).toHaveBeenCalledTimes(3);
      });

      it('should handle packet loss recovery', async () => {
        const packetLossCallback = jest.fn();
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with high packet loss
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 12,
              jitterMs: 25,
              connectionUptime: 100,
              reconnectionCount: 0,
            },
          })
        );

        networkAdapter.startMonitoring();

        // Recovery: 12% -> 2%
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            stability: {
              packetLossPercent: 2,
              jitterMs: 6,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);

        // Should not trigger notification for improvements (below threshold)
        expect(packetLossCallback).not.toHaveBeenCalled();
      });
    });

    describe('combined degradation scenarios', () => {
      it('should handle simultaneous bandwidth and latency degradation', async () => {
        const bitrateCallback = jest.fn();
        const latencyCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);
        networkAdapter.onLatencyChange(latencyCallback);

        // Start with good conditions
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
            latency: {
              averageRttMs: 50,
              minRttMs: 40,
              maxRttMs: 70,
              measurements: new Map(),
            },
          })
        );

        networkAdapter.startMonitoring();

        // Both degrade simultaneously
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 5, downloadMbps: 10, measurementConfidence: 0.9 },
            latency: {
              averageRttMs: 220,
              minRttMs: 180,
              maxRttMs: 260,
              measurements: new Map(),
            },
          })
        );

        // Bandwidth check at 5 seconds
        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(4, 'bandwidth_decrease');

        // Latency check at 10 seconds
        await jest.advanceTimersByTimeAsync(5000);
        expect(latencyCallback).toHaveBeenCalledWith(220, true);
      });

      it('should handle simultaneous bandwidth and packet loss degradation', async () => {
        const bitrateCallback = jest.fn();
        const packetLossCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with good conditions
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
            stability: {
              packetLossPercent: 1,
              jitterMs: 5,
              connectionUptime: 100,
              reconnectionCount: 0,
            },
          })
        );

        networkAdapter.startMonitoring();

        // Both degrade simultaneously
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 6, downloadMbps: 12, measurementConfidence: 0.9 },
            stability: {
              packetLossPercent: 11,
              jitterMs: 25,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        // Both checks at 5 seconds
        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(expect.closeTo(4.8, 1), 'bandwidth_decrease');
        expect(packetLossCallback).toHaveBeenCalledWith(11, true);
      });

      it('should handle all three metrics degrading simultaneously', async () => {
        const bitrateCallback = jest.fn();
        const latencyCallback = jest.fn();
        const packetLossCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);
        networkAdapter.onLatencyChange(latencyCallback);
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with excellent conditions
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 15, downloadMbps: 30, measurementConfidence: 0.9 },
            latency: {
              averageRttMs: 30,
              minRttMs: 20,
              maxRttMs: 50,
              measurements: new Map(),
            },
            stability: {
              packetLossPercent: 0.5,
              jitterMs: 3,
              connectionUptime: 100,
              reconnectionCount: 0,
            },
          })
        );

        networkAdapter.startMonitoring();

        // All three degrade to poor conditions
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 4, downloadMbps: 8, measurementConfidence: 0.9 },
            latency: {
              averageRttMs: 280,
              minRttMs: 240,
              maxRttMs: 320,
              measurements: new Map(),
            },
            stability: {
              packetLossPercent: 14,
              jitterMs: 35,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        // Bandwidth and packet loss checks at 5 seconds
        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(3.2, 'bandwidth_decrease');
        expect(packetLossCallback).toHaveBeenCalledWith(14, true);

        // Latency check at 10 seconds
        await jest.advanceTimersByTimeAsync(5000);
        expect(latencyCallback).toHaveBeenCalledWith(280, true);
      });

      it('should handle mixed degradation and recovery', async () => {
        const bitrateCallback = jest.fn();
        const latencyCallback = jest.fn();
        const packetLossCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);
        networkAdapter.onLatencyChange(latencyCallback);
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with good conditions
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
            latency: {
              averageRttMs: 50,
              minRttMs: 40,
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

        // Bandwidth degrades, latency improves, packet loss increases
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 6, downloadMbps: 12, measurementConfidence: 0.9 },
            latency: {
              averageRttMs: 40, // Improved (no notification expected)
              minRttMs: 30,
              maxRttMs: 60,
              measurements: new Map(),
            },
            stability: {
              packetLossPercent: 8,
              jitterMs: 18,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(expect.closeTo(4.8, 1), 'bandwidth_decrease');
        expect(packetLossCallback).toHaveBeenCalledWith(8, false);

        await jest.advanceTimersByTimeAsync(5000);
        expect(latencyCallback).not.toHaveBeenCalled(); // Latency improved

        // Now bandwidth recovers, latency spikes, packet loss improves
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 12, downloadMbps: 24, measurementConfidence: 0.9 },
            latency: {
              averageRttMs: 150, // Spiked from 40 to 150 (110ms increase)
              minRttMs: 120,
              maxRttMs: 180,
              measurements: new Map(),
            },
            stability: {
              packetLossPercent: 3, // Improved (below threshold)
              jitterMs: 8,
              connectionUptime: 110,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledWith(expect.closeTo(9.6, 1), 'bandwidth_increase');

        await jest.advanceTimersByTimeAsync(5000);
        expect(latencyCallback).toHaveBeenCalledWith(150, false);
      });
    });

    describe('stress test scenarios', () => {
      it('should handle rapid network condition changes', async () => {
        const bitrateCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);

        // Start with 10 Mbps
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
          })
        );

        networkAdapter.startMonitoring();

        // Rapid changes every 5 seconds
        const bandwidthSequence = [7, 12, 5, 15, 4, 11, 6, 13];

        for (const bandwidth of bandwidthSequence) {
          mockMetricsCollector.getCurrentMetrics.mockReturnValue(
            createMockMetrics({
              bandwidth: {
                uploadMbps: bandwidth,
                downloadMbps: bandwidth * 2,
                measurementConfidence: 0.9,
              },
            })
          );

          await jest.advanceTimersByTimeAsync(5000);
        }

        // Should have adapted for each significant change
        expect(bitrateCallback.mock.calls.length).toBeGreaterThan(0);
      });

      it('should maintain stability during prolonged poor conditions', async () => {
        const bitrateCallback = jest.fn();
        const latencyCallback = jest.fn();
        const packetLossCallback = jest.fn();
        networkAdapter.onBitrateAdaptation(bitrateCallback);
        networkAdapter.onLatencyChange(latencyCallback);
        networkAdapter.onPacketLoss(packetLossCallback);

        // Start with good conditions
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
            latency: {
              averageRttMs: 50,
              minRttMs: 40,
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

        // Degrade to poor conditions
        mockMetricsCollector.getCurrentMetrics.mockReturnValue(
          createMockMetrics({
            bandwidth: { uploadMbps: 3, downloadMbps: 6, measurementConfidence: 0.9 },
            latency: {
              averageRttMs: 250,
              minRttMs: 220,
              maxRttMs: 290,
              measurements: new Map(),
            },
            stability: {
              packetLossPercent: 12,
              jitterMs: 30,
              connectionUptime: 105,
              reconnectionCount: 0,
            },
          })
        );

        await jest.advanceTimersByTimeAsync(5000);
        expect(bitrateCallback).toHaveBeenCalledTimes(1);
        expect(packetLossCallback).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(5000);
        expect(latencyCallback).toHaveBeenCalledTimes(1);

        // Maintain poor conditions for extended period
        await jest.advanceTimersByTimeAsync(30000);

        // Should continue monitoring but not trigger additional adaptations
        // (conditions haven't changed significantly)
        // Note: packet loss will continue to be detected since it stays above threshold
        expect(bitrateCallback).toHaveBeenCalledTimes(1);
        expect(latencyCallback).toHaveBeenCalledTimes(1);
        // Packet loss callback will be called multiple times since it stays above threshold
        expect(packetLossCallback.mock.calls.length).toBeGreaterThan(1);
      });
    });
  });
});
