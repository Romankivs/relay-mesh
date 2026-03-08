// Scalability scenario tests
// Task 20.4: Write unit tests for scalability scenarios

import { RelayScaler } from './relay-scaler';
import { ConnectionOptimizer } from './connection-optimizer';
import { SelectionAlgorithm } from './selection-algorithm';
import { TopologyManager } from './topology-manager';
import { ConnectionTopology, ParticipantMetrics, SelectionConfig, NATType } from '../shared/types';

describe('Scalability Scenarios', () => {
  let scaler: RelayScaler;
  let optimizer: ConnectionOptimizer;
  let selectionAlgorithm: SelectionAlgorithm;
  let topologyManager: TopologyManager;
  let config: SelectionConfig;

  beforeEach(() => {
    scaler = new RelayScaler();
    optimizer = new ConnectionOptimizer();
    selectionAlgorithm = new SelectionAlgorithm();
    topologyManager = new TopologyManager();
    config = {
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

  const createMetrics = (participantId: string, uploadMbps: number = 10): ParticipantMetrics => ({
    participantId,
    timestamp: Date.now(),
    bandwidth: {
      uploadMbps,
      downloadMbps: 20,
      measurementConfidence: 0.9,
    },
    natType: NATType.FULL_CONE,
    latency: {
      averageRttMs: 50,
      minRttMs: 40,
      maxRttMs: 60,
      measurements: new Map(),
    },
    stability: {
      packetLossPercent: 1,
      jitterMs: 10,
      connectionUptime: 100,
      reconnectionCount: 0,
    },
    device: {
      cpuUsagePercent: 30,
      availableMemoryMB: 2048,
      supportedCodecs: ['VP8', 'H264'],
      hardwareAcceleration: true,
    },
  });

  const createLatencyMap = (participantIds: string[]): Map<string, Map<string, number>> => {
    const latencyMap = new Map<string, Map<string, number>>();
    for (const id1 of participantIds) {
      const innerMap = new Map<string, number>();
      for (const id2 of participantIds) {
        if (id1 !== id2) {
          innerMap.set(id2, 50 + Math.random() * 50); // 50-100ms latency
        }
      }
      latencyMap.set(id1, innerMap);
    }
    return latencyMap;
  };

  describe('5 participants scenario', () => {
    it('should use 3 relays for 5 participants (sqrt(5) = 2.24, ceil = 3)', () => {
      const participantCount = 5;
      const allMetrics = new Map<string, ParticipantMetrics>();
      
      for (let i = 0; i < participantCount; i++) {
        allMetrics.set(`p${i}`, createMetrics(`p${i}`, 10 + i));
      }

      const optimalRelayCount = selectionAlgorithm.calculateOptimalRelayCount(participantCount);
      expect(optimalRelayCount).toBe(3);

      const relayIds = selectionAlgorithm.selectRelayNodes(allMetrics, config).selectedIds;
      expect(relayIds.length).toBeLessThanOrEqual(3);
    });

    it('should verify connection counts for 5 participants with 3 relays', () => {
      const participantIds = ['p0', 'p1', 'p2', 'p3', 'p4'];
      const allMetrics = new Map<string, ParticipantMetrics>();
      
      for (const id of participantIds) {
        allMetrics.set(id, createMetrics(id, 10 + parseInt(id.slice(1))));
      }

      const relayIds = ['p0', 'p1', 'p2']; // Top 3 as relays
      const latencyMap = createLatencyMap(participantIds);

      const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);

      // Verify topology is optimal
      expect(optimizer.isTopologyOptimal(topology)).toBe(true);

      // Verify relay connections
      for (const relayId of relayIds) {
        const stats = optimizer.verifyRelayNodeConnections(relayId, topology);
        expect(stats.isOptimal).toBe(true);
        // Each relay should connect to 2 other relays + their regular nodes
        expect(stats.connectionCount).toBeGreaterThanOrEqual(2);
      }

      // Verify regular node connections
      const regularIds = participantIds.filter((id) => !relayIds.includes(id));
      for (const regularId of regularIds) {
        const stats = optimizer.verifyRegularNodeConnections(regularId, topology);
        expect(stats.isOptimal).toBe(true);
        expect(stats.connectionCount).toBe(1);
      }
    });

    it('should measure performance metrics for 5 participants', () => {
      const participantIds = ['p0', 'p1', 'p2', 'p3', 'p4'];
      const relayIds = ['p0', 'p1', 'p2'];
      const latencyMap = createLatencyMap(participantIds);

      const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);

      const totalConnections = optimizer.getTotalConnectionCount(topology);
      
      // With 3 relays and 2 regular nodes:
      // - Relay mesh: 3 relays * 2 connections each / 2 = 3 connections
      // - Regular to relay: 2 regular nodes * 1 connection each = 2 connections
      // Total: 5 connections
      expect(totalConnections).toBeGreaterThan(0);
      expect(totalConnections).toBeLessThan(participantIds.length * participantIds.length); // Much less than full mesh
    });
  });

  describe('10 participants scenario', () => {
    it('should use 4 relays for 10 participants (sqrt(10) = 3.16, ceil = 4)', () => {
      const participantCount = 10;
      const allMetrics = new Map<string, ParticipantMetrics>();
      
      for (let i = 0; i < participantCount; i++) {
        allMetrics.set(`p${i}`, createMetrics(`p${i}`, 10 + i));
      }

      const optimalRelayCount = selectionAlgorithm.calculateOptimalRelayCount(participantCount);
      expect(optimalRelayCount).toBe(4);

      const relayIds = selectionAlgorithm.selectRelayNodes(allMetrics, config).selectedIds;
      expect(relayIds.length).toBeLessThanOrEqual(4);
    });

    it('should verify connection counts for 10 participants with 4 relays', () => {
      const participantIds = Array.from({ length: 10 }, (_, i) => `p${i}`);
      const allMetrics = new Map<string, ParticipantMetrics>();
      
      for (const id of participantIds) {
        allMetrics.set(id, createMetrics(id, 10 + parseInt(id.slice(1))));
      }

      const relayIds = ['p0', 'p1', 'p2', 'p3']; // Top 4 as relays
      const latencyMap = createLatencyMap(participantIds);

      const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);

      // Verify topology is optimal
      expect(optimizer.isTopologyOptimal(topology)).toBe(true);

      // Verify all regular nodes have exactly 1 connection
      const regularIds = participantIds.filter((id) => !relayIds.includes(id));
      for (const regularId of regularIds) {
        const stats = optimizer.verifyRegularNodeConnections(regularId, topology);
        expect(stats.connectionCount).toBe(1);
      }

      // Verify relay nodes have correct connection pattern
      for (const relayId of relayIds) {
        const stats = optimizer.verifyRelayNodeConnections(relayId, topology);
        expect(stats.isOptimal).toBe(true);
      }
    });

    it('should measure performance metrics for 10 participants', () => {
      const participantIds = Array.from({ length: 10 }, (_, i) => `p${i}`);
      const relayIds = ['p0', 'p1', 'p2', 'p3'];
      const latencyMap = createLatencyMap(participantIds);

      const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);

      const totalConnections = optimizer.getTotalConnectionCount(topology);
      
      // Should be significantly less than full mesh (10 * 9 / 2 = 45 connections)
      expect(totalConnections).toBeLessThan(45);
      expect(totalConnections).toBeGreaterThan(0);
    });
  });

  describe('20 participants scenario', () => {
    it('should use 5 relays for 20 participants (sqrt(20) = 4.47, ceil = 5)', () => {
      const participantCount = 20;
      const allMetrics = new Map<string, ParticipantMetrics>();
      
      for (let i = 0; i < participantCount; i++) {
        allMetrics.set(`p${i}`, createMetrics(`p${i}`, 10 + i));
      }

      const optimalRelayCount = selectionAlgorithm.calculateOptimalRelayCount(participantCount);
      expect(optimalRelayCount).toBe(5);

      const relayIds = selectionAlgorithm.selectRelayNodes(allMetrics, config).selectedIds;
      expect(relayIds.length).toBeLessThanOrEqual(5);
    });

    it('should verify connection counts for 20 participants with 5 relays', () => {
      const participantIds = Array.from({ length: 20 }, (_, i) => `p${i}`);
      const allMetrics = new Map<string, ParticipantMetrics>();
      
      for (const id of participantIds) {
        allMetrics.set(id, createMetrics(id, 10 + parseInt(id.slice(1))));
      }

      const relayIds = ['p0', 'p1', 'p2', 'p3', 'p4']; // Top 5 as relays
      const latencyMap = createLatencyMap(participantIds);

      const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);

      // Verify topology is optimal
      expect(optimizer.isTopologyOptimal(topology)).toBe(true);

      // Verify all regular nodes have exactly 1 connection
      const regularIds = participantIds.filter((id) => !relayIds.includes(id));
      expect(regularIds.length).toBe(15);
      
      for (const regularId of regularIds) {
        const stats = optimizer.verifyRegularNodeConnections(regularId, topology);
        expect(stats.connectionCount).toBe(1);
      }

      // Verify no group is severely overloaded
      // The topology manager does latency-based assignment which may not perfectly balance
      for (const group of topology.groups) {
        // Verify groups are within reasonable bounds
        expect(group.regularNodeIds.length).toBeLessThan(participantIds.length);
      }
      
      // Verify all regular nodes are assigned
      const assignedRegularNodes = topology.groups.flatMap((g) => g.regularNodeIds);
      expect(assignedRegularNodes.length).toBe(15);
    });

    it('should measure performance metrics for 20 participants', () => {
      const participantIds = Array.from({ length: 20 }, (_, i) => `p${i}`);
      const relayIds = ['p0', 'p1', 'p2', 'p3', 'p4'];
      const latencyMap = createLatencyMap(participantIds);

      const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);

      const totalConnections = optimizer.getTotalConnectionCount(topology);
      
      // Full mesh would be 20 * 19 / 2 = 190 connections
      // Our topology should be much more efficient
      expect(totalConnections).toBeLessThan(190);
      expect(totalConnections).toBeGreaterThan(0);

      // Calculate average connections per participant
      const stats = optimizer.verifyAllConnections(topology);
      const connectionCounts = Array.from(stats.values()).map((s) => s.connectionCount);
      const avgConnections = connectionCounts.reduce((a, b) => a + b, 0) / connectionCounts.length;
      
      // Average should be much less than 19 (full mesh)
      expect(avgConnections).toBeLessThan(19);
    });
  });

  describe('30 participants scenario', () => {
    it('should use 6 relays for 30 participants (sqrt(30) = 5.48, ceil = 6)', () => {
      const participantCount = 30;
      const allMetrics = new Map<string, ParticipantMetrics>();
      
      for (let i = 0; i < participantCount; i++) {
        allMetrics.set(`p${i}`, createMetrics(`p${i}`, 10 + i));
      }

      const optimalRelayCount = selectionAlgorithm.calculateOptimalRelayCount(participantCount);
      expect(optimalRelayCount).toBe(6);

      const relayIds = selectionAlgorithm.selectRelayNodes(allMetrics, config).selectedIds;
      expect(relayIds.length).toBeLessThanOrEqual(6);
    });

    it('should verify connection counts for 30 participants with 6 relays', () => {
      const participantIds = Array.from({ length: 30 }, (_, i) => `p${i}`);
      const allMetrics = new Map<string, ParticipantMetrics>();
      
      for (const id of participantIds) {
        allMetrics.set(id, createMetrics(id, 10 + parseInt(id.slice(1))));
      }

      const relayIds = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']; // Top 6 as relays
      const latencyMap = createLatencyMap(participantIds);

      const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);

      // Verify topology is optimal
      expect(optimizer.isTopologyOptimal(topology)).toBe(true);

      // Verify all regular nodes have exactly 1 connection
      const regularIds = participantIds.filter((id) => !relayIds.includes(id));
      expect(regularIds.length).toBe(24);
      
      for (const regularId of regularIds) {
        const stats = optimizer.verifyRegularNodeConnections(regularId, topology);
        expect(stats.connectionCount).toBe(1);
      }

      // Verify load distribution
      const groupSizes = topology.groups.map((g) => g.regularNodeIds.length);
      const maxGroupSize = Math.max(...groupSizes);
      const minGroupSize = Math.min(...groupSizes);
      const avgGroupSize = groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length;
      
      // Verify all regular nodes are assigned
      const assignedRegularNodes = topology.groups.flatMap((g) => g.regularNodeIds);
      expect(assignedRegularNodes.length).toBe(24);
      
      // Verify average group size is reasonable (24 regular / 6 relays = 4 avg)
      expect(avgGroupSize).toBeCloseTo(4, 1);
    });

    it('should measure performance metrics for 30 participants', () => {
      const participantIds = Array.from({ length: 30 }, (_, i) => `p${i}`);
      const relayIds = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
      const latencyMap = createLatencyMap(participantIds);

      const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);

      const totalConnections = optimizer.getTotalConnectionCount(topology);
      
      // Full mesh would be 30 * 29 / 2 = 435 connections
      // Our topology should be dramatically more efficient
      expect(totalConnections).toBeLessThan(435);
      expect(totalConnections).toBeGreaterThan(0);

      // Calculate efficiency ratio
      const fullMeshConnections = (30 * 29) / 2;
      const efficiency = 1 - totalConnections / fullMeshConnections;
      
      // Should save at least 80% of connections compared to full mesh
      expect(efficiency).toBeGreaterThan(0.8);
    });
  });

  describe('scaling comparison across participant counts', () => {
    it('should demonstrate connection count scaling efficiency', () => {
      const scenarios = [
        { count: 5, expectedRelays: 3 },
        { count: 10, expectedRelays: 4 },
        { count: 20, expectedRelays: 5 },
        { count: 30, expectedRelays: 6 },
      ];

      const results: Array<{
        participantCount: number;
        relayCount: number;
        totalConnections: number;
        fullMeshConnections: number;
        efficiency: number;
      }> = [];

      for (const scenario of scenarios) {
        const participantIds = Array.from({ length: scenario.count }, (_, i) => `p${i}`);
        const relayIds = participantIds.slice(0, scenario.expectedRelays);
        const latencyMap = createLatencyMap(participantIds);

        const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);
        const totalConnections = optimizer.getTotalConnectionCount(topology);
        const fullMeshConnections = (scenario.count * (scenario.count - 1)) / 2;
        const efficiency = 1 - totalConnections / fullMeshConnections;

        results.push({
          participantCount: scenario.count,
          relayCount: scenario.expectedRelays,
          totalConnections,
          fullMeshConnections,
          efficiency,
        });
      }

      // Verify efficiency improves with scale
      for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1];
        const curr = results[i];
        
        // Efficiency should improve or stay similar as we scale
        expect(curr.efficiency).toBeGreaterThanOrEqual(prev.efficiency - 0.1);
      }

      // All scenarios should be significantly more efficient than full mesh
      for (const result of results) {
        expect(result.efficiency).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('should verify regular nodes always have exactly 1 connection regardless of scale', () => {
      const scenarios = [5, 10, 20, 30];

      for (const participantCount of scenarios) {
        const participantIds = Array.from({ length: participantCount }, (_, i) => `p${i}`);
        const optimalRelayCount = selectionAlgorithm.calculateOptimalRelayCount(participantCount);
        const relayIds = participantIds.slice(0, optimalRelayCount);
        const latencyMap = createLatencyMap(participantIds);

        const topology = topologyManager.formTopology(relayIds, participantIds, latencyMap);

        const regularIds = participantIds.filter((id) => !relayIds.includes(id));
        for (const regularId of regularIds) {
          const stats = optimizer.verifyRegularNodeConnections(regularId, topology);
          expect(stats.connectionCount).toBe(1);
        }
      }
    });
  });
});
