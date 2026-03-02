// Unit tests for Selection Algorithm
// Task 4: Selection Algorithm component tests

import { SelectionAlgorithm } from './selection-algorithm';
import { ParticipantMetrics, SelectionConfig, NATType } from '../shared/types';

describe('SelectionAlgorithm', () => {
  let algorithm: SelectionAlgorithm;
  let defaultConfig: SelectionConfig;

  beforeEach(() => {
    algorithm = new SelectionAlgorithm();
    defaultConfig = {
      bandwidthWeight: 0.3,
      natWeight: 0.25,
      latencyWeight: 0.2,
      stabilityWeight: 0.15,
      deviceWeight: 0.1,
      minBandwidthMbps: 5,
      maxParticipantsPerRelay: 5,
      reevaluationIntervalMs: 30000,
    };
  });

  describe('calculateScore', () => {
    it('should calculate score for participant with good metrics', () => {
      const metrics: ParticipantMetrics = {
        participantId: 'participant-1',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 20,
          downloadMbps: 50,
          measurementConfidence: 0.9,
        },
        natType: NATType.OPEN,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map([['participant-2', 50]]),
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
          supportedCodecs: ['VP8', 'VP9', 'H264'],
          hardwareAcceleration: true,
        },
      };

      const score = algorithm.calculateScore(metrics, defaultConfig);

      expect(score.participantId).toBe('participant-1');
      expect(score.totalScore).toBeGreaterThan(0.8);
      expect(score.bandwidthScore).toBeCloseTo(1.0, 1);
      expect(score.natScore).toBe(1.0);
      expect(score.latencyScore).toBeCloseTo(0.75, 1);
      expect(score.stabilityScore).toBeGreaterThan(0.9);
      expect(score.deviceScore).toBeGreaterThan(0.7);
    });

    it('should calculate lower score for participant with poor metrics', () => {
      const metrics: ParticipantMetrics = {
        participantId: 'participant-2',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 3,
          downloadMbps: 10,
          measurementConfidence: 0.7,
        },
        natType: NATType.SYMMETRIC,
        latency: {
          averageRttMs: 250,
          minRttMs: 200,
          maxRttMs: 300,
          measurements: new Map([['participant-1', 250]]),
        },
        stability: {
          packetLossPercent: 5,
          jitterMs: 40,
          connectionUptime: 60,
          reconnectionCount: 3,
        },
        device: {
          cpuUsagePercent: 80,
          availableMemoryMB: 512,
          supportedCodecs: ['VP8'],
          hardwareAcceleration: false,
        },
      };

      const score = algorithm.calculateScore(metrics, defaultConfig);

      expect(score.participantId).toBe('participant-2');
      expect(score.totalScore).toBeLessThan(0.4);
      expect(score.bandwidthScore).toBeLessThan(0.3);
      expect(score.natScore).toBe(0);
      expect(score.latencyScore).toBe(0); // Clamped to 0 for high latency
      expect(score.stabilityScore).toBeLessThan(0.6);
      expect(score.deviceScore).toBeLessThan(0.4);
    });
  });

  describe('calculateOptimalRelayCount', () => {
    it('should calculate correct relay count for various participant counts', () => {
      expect(algorithm.calculateOptimalRelayCount(4)).toBe(2);
      expect(algorithm.calculateOptimalRelayCount(9)).toBe(3);
      expect(algorithm.calculateOptimalRelayCount(16)).toBe(4);
      expect(algorithm.calculateOptimalRelayCount(25)).toBe(5);
      expect(algorithm.calculateOptimalRelayCount(10)).toBe(4);
    });

    it('should handle edge cases', () => {
      expect(algorithm.calculateOptimalRelayCount(1)).toBe(1);
      expect(algorithm.calculateOptimalRelayCount(2)).toBe(2);
      expect(algorithm.calculateOptimalRelayCount(3)).toBe(2);
    });
  });

  describe('selectRelayNodes', () => {
    it('should select top scoring eligible participants', () => {
      const allMetrics = new Map<string, ParticipantMetrics>();

      // Add 6 participants with varying metrics
      for (let i = 1; i <= 6; i++) {
        allMetrics.set(`participant-${i}`, {
          participantId: `participant-${i}`,
          timestamp: Date.now(),
          bandwidth: {
            uploadMbps: 5 + i * 2,
            downloadMbps: 20 + i * 5,
            measurementConfidence: 0.9,
          },
          natType: NATType.OPEN,
          latency: {
            averageRttMs: 50,
            minRttMs: 40,
            maxRttMs: 60,
            measurements: new Map(),
          },
          stability: {
            packetLossPercent: 1,
            jitterMs: 10,
            connectionUptime: 300,
            reconnectionCount: 0,
          },
          device: {
            cpuUsagePercent: 30,
            availableMemoryMB: 2048,
            supportedCodecs: ['VP8', 'VP9'],
            hardwareAcceleration: true,
          },
        });
      }

      const selected = algorithm.selectRelayNodes(allMetrics, defaultConfig);

      // For 6 participants, optimal relay count is ceil(sqrt(6)) = 3
      expect(selected.length).toBe(3);

      // Should select participants with highest bandwidth (6, 5, 4)
      expect(selected).toContain('participant-6');
      expect(selected).toContain('participant-5');
      expect(selected).toContain('participant-4');
    });

    it('should exclude ineligible participants', () => {
      const allMetrics = new Map<string, ParticipantMetrics>();

      // Participant 1: Good metrics
      allMetrics.set('participant-1', {
        participantId: 'participant-1',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 20,
          downloadMbps: 50,
          measurementConfidence: 0.9,
        },
        natType: NATType.OPEN,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 1,
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
      });

      // Participant 2: Low bandwidth (ineligible)
      allMetrics.set('participant-2', {
        participantId: 'participant-2',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 3,
          downloadMbps: 10,
          measurementConfidence: 0.9,
        },
        natType: NATType.OPEN,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 1,
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
      });

      // Participant 3: SYMMETRIC NAT (ineligible)
      allMetrics.set('participant-3', {
        participantId: 'participant-3',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 20,
          downloadMbps: 50,
          measurementConfidence: 0.9,
        },
        natType: NATType.SYMMETRIC,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 1,
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
      });

      // Participant 4: Low uptime (ineligible)
      allMetrics.set('participant-4', {
        participantId: 'participant-4',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 20,
          downloadMbps: 50,
          measurementConfidence: 0.9,
        },
        natType: NATType.OPEN,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 1,
          jitterMs: 10,
          connectionUptime: 20,
          reconnectionCount: 0,
        },
        device: {
          cpuUsagePercent: 30,
          availableMemoryMB: 2048,
          supportedCodecs: ['VP8'],
          hardwareAcceleration: true,
        },
      });

      const selected = algorithm.selectRelayNodes(allMetrics, defaultConfig);

      // Only participant-1 is eligible
      expect(selected.length).toBe(1);
      expect(selected).toContain('participant-1');
    });
  });

  describe('shouldDemote', () => {
    it('should demote relay with severe packet loss', () => {
      const metrics: ParticipantMetrics = {
        participantId: 'relay-1',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 20,
          downloadMbps: 50,
          measurementConfidence: 0.9,
        },
        natType: NATType.OPEN,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 20, // Severe packet loss
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

      expect(algorithm.shouldDemote('relay-1', metrics, defaultConfig)).toBe(true);
    });

    it('should demote relay with high latency', () => {
      const metrics: ParticipantMetrics = {
        participantId: 'relay-1',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 20,
          downloadMbps: 50,
          measurementConfidence: 0.9,
        },
        natType: NATType.OPEN,
        latency: {
          averageRttMs: 250, // High latency
          minRttMs: 200,
          maxRttMs: 300,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 1,
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

      expect(algorithm.shouldDemote('relay-1', metrics, defaultConfig)).toBe(true);
    });

    it('should demote relay with insufficient bandwidth', () => {
      const metrics: ParticipantMetrics = {
        participantId: 'relay-1',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 3, // Below minimum
          downloadMbps: 10,
          measurementConfidence: 0.9,
        },
        natType: NATType.OPEN,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 1,
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

      expect(algorithm.shouldDemote('relay-1', metrics, defaultConfig)).toBe(true);
    });

    it('should not demote relay with good metrics', () => {
      const metrics: ParticipantMetrics = {
        participantId: 'relay-1',
        timestamp: Date.now(),
        bandwidth: {
          uploadMbps: 20,
          downloadMbps: 50,
          measurementConfidence: 0.9,
        },
        natType: NATType.OPEN,
        latency: {
          averageRttMs: 50,
          minRttMs: 40,
          maxRttMs: 60,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 1,
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

      expect(algorithm.shouldDemote('relay-1', metrics, defaultConfig)).toBe(false);
    });
  });
});
