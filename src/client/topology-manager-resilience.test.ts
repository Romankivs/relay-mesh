// Unit tests for Resilient Topology Manager
// Task 18.5: Implement topology formation failure handling

import { ResilientTopologyManager } from './topology-manager-resilience';
import { NATType, ParticipantMetrics, SelectionConfig } from '../shared/types';

describe('ResilientTopologyManager - Task 18.5', () => {
  let manager: ResilientTopologyManager;

  beforeEach(() => {
    manager = new ResilientTopologyManager();
  });

  describe('Insufficient relay candidates handling', () => {
    it('should fall back to full mesh for small conferences when no relays available', () => {
      const allParticipants = ['p1', 'p2', 'p3', 'p4']; // 4 participants (< 5 threshold)
      const latencyMap = new Map<string, Map<string, number>>();

      const topology = manager.formTopologyWithFallback(
        [], // No relay candidates
        allParticipants,
        latencyMap
      );

      // Should create full mesh topology
      expect(topology.relayNodes).toEqual([]);
      expect(topology.groups).toEqual([]);
      expect(topology.relayConnections).toEqual([]);
    });

    it('should attempt relaxed criteria for larger conferences when no relays available', () => {
      const allParticipants = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']; // 6 participants (> 5 threshold)
      const latencyMap = new Map<string, Map<string, number>>();

      // Create metrics with low bandwidth (below normal threshold but above relaxed)
      const allMetrics = new Map<string, ParticipantMetrics>();
      allParticipants.forEach((id, index) => {
        allMetrics.set(id, {
          participantId: id,
          timestamp: Date.now(),
          bandwidth: {
            uploadMbps: 3.0, // Below normal 5 Mbps, but above relaxed 2.5 Mbps
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

      const topology = manager.formTopologyWithFallback(
        [], // No relay candidates with normal criteria
        allParticipants,
        latencyMap,
        allMetrics,
        config
      );

      // Should have selected relays with relaxed criteria
      expect(topology.relayNodes.length).toBeGreaterThan(0);
    });

    it('should use best available candidates when relaxed criteria still insufficient', () => {
      const allParticipants = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
      const latencyMap = new Map<string, Map<string, number>>();

      // Create metrics with very low bandwidth (below even relaxed threshold)
      const allMetrics = new Map<string, ParticipantMetrics>();
      allParticipants.forEach((id, index) => {
        allMetrics.set(id, {
          participantId: id,
          timestamp: Date.now(),
          bandwidth: {
            uploadMbps: 1.0 + index * 0.5, // Varying bandwidth, all low
            downloadMbps: 5.0,
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

      const topology = manager.formTopologyWithFallback(
        [],
        allParticipants,
        latencyMap,
        allMetrics,
        config
      );

      // Should have selected best available candidates
      expect(topology.relayNodes.length).toBeGreaterThan(0);
    });
  });

  describe('Group assignment failure handling', () => {
    it('should temporarily exceed capacity when all relays are at capacity', () => {
      const relayNodeIds = ['relay1', 'relay2'];
      const latencyMap = new Map<string, number>([
        ['relay1', 50],
        ['relay2', 60],
      ]);

      // Create groups at capacity (5 participants each)
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

      const assignedRelayId = manager.assignToRelayWithFallback(
        'p11',
        relayNodeIds,
        latencyMap,
        currentGroups,
        config
      );

      // Should assign to one of the relays (least loaded)
      expect(relayNodeIds).toContain(assignedRelayId);
    });

    it('should throw error when no relay nodes available', () => {
      const latencyMap = new Map<string, number>();
      const currentGroups: any[] = [];

      expect(() => {
        manager.assignToRelayWithFallback('p1', [], latencyMap, currentGroups);
      }).toThrow('No relay nodes available for assignment');
    });
  });

  describe('Full mesh fallback', () => {
    it('should create full mesh topology with no relay nodes', () => {
      const allParticipants = ['p1', 'p2', 'p3'];
      const latencyMap = new Map<string, Map<string, number>>();

      const topology = manager.formTopologyWithFallback(
        [],
        allParticipants,
        latencyMap
      );

      expect(topology.relayNodes).toEqual([]);
      expect(topology.groups).toEqual([]);
      expect(topology.relayConnections).toEqual([]);
      expect(topology.version).toBe(1);
      expect(topology.timestamp).toBeDefined();
    });

    it('should identify small conferences correctly', () => {
      expect(manager.shouldUseFullMesh(3)).toBe(true);
      expect(manager.shouldUseFullMesh(5)).toBe(true);
      expect(manager.shouldUseFullMesh(6)).toBe(false);
      expect(manager.shouldUseFullMesh(10)).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should handle topology formation with valid inputs gracefully', () => {
      const allParticipants = ['p1', 'p2', 'p3', 'relay1'];
      const latencyMap = new Map<string, Map<string, number>>();
      
      // Set up latency map
      allParticipants.forEach(p1 => {
        const innerMap = new Map<string, number>();
        allParticipants.forEach(p2 => {
          if (p1 !== p2) {
            innerMap.set(p2, 50);
          }
        });
        latencyMap.set(p1, innerMap);
      });

      const relayIds = ['relay1'];

      const topology = manager.formTopologyWithFallback(
        relayIds,
        allParticipants,
        latencyMap
      );

      // Should form normal topology
      expect(topology.relayNodes).toEqual(relayIds);
      expect(topology.groups.length).toBeGreaterThan(0);
    });
  });
});
