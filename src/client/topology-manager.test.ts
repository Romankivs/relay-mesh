// Unit tests for Topology Manager
// Task 6: Implement Topology Manager component

import { TopologyManager } from './topology-manager';
import {
  ConnectionTopology,
  ParticipantMetrics,
  NATType,
  SelectionConfig,
} from '../shared/types';

describe('TopologyManager', () => {
  let topologyManager: TopologyManager;
  let defaultConfig: SelectionConfig;

  beforeEach(() => {
    topologyManager = new TopologyManager();
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

  describe('formTopology', () => {
    it('should create topology with relay nodes and groups', () => {
      const relayNodeIds = ['relay1', 'relay2'];
      const allParticipants = ['relay1', 'relay2', 'regular1', 'regular2', 'regular3'];
      const latencyMap = new Map([
        ['regular1', new Map([['relay1', 20], ['relay2', 30]])],
        ['regular2', new Map([['relay1', 40], ['relay2', 25]])],
        ['regular3', new Map([['relay1', 35], ['relay2', 15]])],
      ]);

      const topology = topologyManager.formTopology(
        relayNodeIds,
        allParticipants,
        latencyMap
      );

      expect(topology.relayNodes).toEqual(['relay1', 'relay2']);
      expect(topology.groups).toHaveLength(2);
      expect(topology.version).toBe(1);
      expect(topology.timestamp).toBeGreaterThan(0);
    });

    it('should assign regular nodes to relays based on latency', () => {
      const relayNodeIds = ['relay1', 'relay2'];
      const allParticipants = ['relay1', 'relay2', 'regular1', 'regular2'];
      const latencyMap = new Map([
        ['regular1', new Map([['relay1', 10], ['relay2', 50]])],
        ['regular2', new Map([['relay1', 60], ['relay2', 20]])],
      ]);

      const topology = topologyManager.formTopology(
        relayNodeIds,
        allParticipants,
        latencyMap
      );

      // regular1 should be assigned to relay1 (lower latency)
      const relay1Group = topology.groups.find(g => g.relayNodeId === 'relay1');
      expect(relay1Group?.regularNodeIds).toContain('regular1');

      // regular2 should be assigned to relay2 (lower latency)
      const relay2Group = topology.groups.find(g => g.relayNodeId === 'relay2');
      expect(relay2Group?.regularNodeIds).toContain('regular2');
    });

    it('should create full mesh between relay nodes', () => {
      const relayNodeIds = ['relay1', 'relay2', 'relay3'];
      const allParticipants = ['relay1', 'relay2', 'relay3'];
      const latencyMap = new Map();

      const topology = topologyManager.formTopology(
        relayNodeIds,
        allParticipants,
        latencyMap
      );

      // Full mesh for 3 relays should have 3 connections
      expect(topology.relayConnections).toHaveLength(3);
      expect(topology.relayConnections).toContainEqual(['relay1', 'relay2']);
      expect(topology.relayConnections).toContainEqual(['relay1', 'relay3']);
      expect(topology.relayConnections).toContainEqual(['relay2', 'relay3']);
    });

    it('should handle single relay node', () => {
      const relayNodeIds = ['relay1'];
      const allParticipants = ['relay1', 'regular1', 'regular2'];
      const latencyMap = new Map([
        ['regular1', new Map([['relay1', 20]])],
        ['regular2', new Map([['relay1', 25]])],
      ]);

      const topology = topologyManager.formTopology(
        relayNodeIds,
        allParticipants,
        latencyMap
      );

      expect(topology.relayNodes).toEqual(['relay1']);
      expect(topology.groups).toHaveLength(1);
      expect(topology.groups[0].regularNodeIds).toHaveLength(2);
      expect(topology.relayConnections).toHaveLength(0); // No relay-to-relay connections
    });
  });

  describe('assignToRelay', () => {
    it('should assign to relay with lowest latency', () => {
      const relayNodeIds = ['relay1', 'relay2', 'relay3'];
      const latencyMap = new Map([
        ['relay1', 50],
        ['relay2', 20],
        ['relay3', 30],
      ]);
      const groups = [
        { relayNodeId: 'relay1', regularNodeIds: [] },
        { relayNodeId: 'relay2', regularNodeIds: [] },
        { relayNodeId: 'relay3', regularNodeIds: [] },
      ];

      const assignedRelay = topologyManager.assignToRelay(
        'regular1',
        relayNodeIds,
        latencyMap,
        groups
      );

      expect(assignedRelay).toBe('relay2'); // Lowest latency
    });

    it('should balance load when latencies are equal', () => {
      const relayNodeIds = ['relay1', 'relay2'];
      const latencyMap = new Map([
        ['relay1', 30],
        ['relay2', 30],
      ]);
      const groups = [
        { relayNodeId: 'relay1', regularNodeIds: ['existing1', 'existing2'] },
        { relayNodeId: 'relay2', regularNodeIds: [] },
      ];

      const assignedRelay = topologyManager.assignToRelay(
        'regular1',
        relayNodeIds,
        latencyMap,
        groups
      );

      expect(assignedRelay).toBe('relay2'); // Less loaded
    });

    it('should throw error when no relay nodes available', () => {
      expect(() => {
        topologyManager.assignToRelay('regular1', [], new Map(), []);
      }).toThrow('No relay nodes available for assignment');
    });

    it('should handle missing latency data', () => {
      const relayNodeIds = ['relay1', 'relay2'];
      const latencyMap = new Map([['relay1', 30]]); // relay2 missing
      const groups = [
        { relayNodeId: 'relay1', regularNodeIds: [] },
        { relayNodeId: 'relay2', regularNodeIds: [] },
      ];

      const assignedRelay = topologyManager.assignToRelay(
        'regular1',
        relayNodeIds,
        latencyMap,
        groups
      );

      expect(assignedRelay).toBe('relay1'); // Has known latency
    });
  });

  describe('balanceLoad', () => {
    it('should not rebalance when load is already balanced', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['r1', 'r2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['r3', 'r4'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };
      const latencyMap = new Map();

      const balanced = topologyManager.balanceLoad(topology, latencyMap);

      expect(balanced.version).toBe(1); // No change
      expect(balanced.groups).toEqual(topology.groups);
    });

    it('should rebalance when load difference is significant', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['r1', 'r2', 'r3', 'r4'] },
          { relayNodeId: 'relay2', regularNodeIds: [] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };
      const latencyMap = new Map([
        ['r1', new Map([['relay1', 20], ['relay2', 25]])],
        ['r2', new Map([['relay1', 30], ['relay2', 28]])],
        ['r3', new Map([['relay1', 40], ['relay2', 35]])],
        ['r4', new Map([['relay1', 50], ['relay2', 45]])],
      ]);

      const balanced = topologyManager.balanceLoad(topology, latencyMap);

      expect(balanced.version).toBe(2); // Version incremented
      const relay1Group = balanced.groups.find(g => g.relayNodeId === 'relay1');
      const relay2Group = balanced.groups.find(g => g.relayNodeId === 'relay2');

      // Load should be more balanced
      expect(relay1Group!.regularNodeIds.length).toBeLessThan(4);
      expect(relay2Group!.regularNodeIds.length).toBeGreaterThan(0);
    });

    it('should not move participant if latency increase is too high', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['r1', 'r2', 'r3'] },
          { relayNodeId: 'relay2', regularNodeIds: [] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };
      const latencyMap = new Map([
        ['r1', new Map([['relay1', 10], ['relay2', 100]])], // High increase
        ['r2', new Map([['relay1', 10], ['relay2', 100]])], // High increase
        ['r3', new Map([['relay1', 10], ['relay2', 100]])], // High increase
      ]);

      const balanced = topologyManager.balanceLoad(topology, latencyMap);

      // Should not rebalance due to high latency increase
      expect(balanced.groups[0].regularNodeIds).toHaveLength(3);
      expect(balanced.groups[1].regularNodeIds).toHaveLength(0);
    });
  });

  describe('handleJoin', () => {
    it('should add participant to appropriate group', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['r1'] },
          { relayNodeId: 'relay2', regularNodeIds: ['r2'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const metrics: ParticipantMetrics = {
        participantId: 'newParticipant',
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.8 },
        natType: NATType.FULL_CONE,
        latency: {
          averageRttMs: 25,
          minRttMs: 20,
          maxRttMs: 30,
          measurements: new Map([['relay1', 20], ['relay2', 40]]),
        },
        stability: {
          packetLossPercent: 0.5,
          jitterMs: 5,
          connectionUptime: 60,
          reconnectionCount: 0,
        },
        device: {
          cpuUsagePercent: 30,
          availableMemoryMB: 2048,
          supportedCodecs: ['VP8', 'H264'],
          hardwareAcceleration: true,
        },
      };

      const updated = topologyManager.handleJoin('newParticipant', topology, metrics);

      expect(updated.version).toBe(2);
      const relay1Group = updated.groups.find(g => g.relayNodeId === 'relay1');
      expect(relay1Group?.regularNodeIds).toContain('newParticipant');
    });

    it('should create empty topology for first participant', () => {
      const emptyTopology: ConnectionTopology = {
        version: 0,
        timestamp: Date.now(),
        relayNodes: [],
        groups: [],
        relayConnections: [],
      };

      const metrics: ParticipantMetrics = {
        participantId: 'firstParticipant',
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.8 },
        natType: NATType.OPEN,
        latency: {
          averageRttMs: 0,
          minRttMs: 0,
          maxRttMs: 0,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 0,
          jitterMs: 0,
          connectionUptime: 0,
          reconnectionCount: 0,
        },
        device: {
          cpuUsagePercent: 20,
          availableMemoryMB: 4096,
          supportedCodecs: ['VP8'],
          hardwareAcceleration: true,
        },
      };

      const updated = topologyManager.handleJoin('firstParticipant', emptyTopology, metrics);

      expect(updated.version).toBe(1);
      expect(updated.relayNodes).toHaveLength(0);
      expect(updated.groups).toHaveLength(0);
    });
  });

  describe('handleLeave', () => {
    it('should remove regular node from group', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['r1', 'r2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['r3'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const updated = topologyManager.handleLeave('r1', topology);

      expect(updated.version).toBe(2);
      const relay1Group = updated.groups.find(g => g.relayNodeId === 'relay1');
      expect(relay1Group?.regularNodeIds).not.toContain('r1');
      expect(relay1Group?.regularNodeIds).toContain('r2');
    });

    it('should throw error when relay node leaves', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['r1'] },
          { relayNodeId: 'relay2', regularNodeIds: ['r2'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      expect(() => {
        topologyManager.handleLeave('relay1', topology);
      }).toThrow('use handleRelayFailure instead');
    });

    it('should handle participant not in any group', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: ['r1'] }],
        relayConnections: [],
      };

      const updated = topologyManager.handleLeave('nonexistent', topology);

      expect(updated.version).toBe(2);
      expect(updated.groups[0].regularNodeIds).toEqual(['r1']);
    });
  });

  describe('handleRelayFailure', () => {
    it('should redistribute participants when no replacement available', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['r1', 'r2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['r3'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const allMetrics = new Map<string, ParticipantMetrics>([
        [
          'r1',
          {
            participantId: 'r1',
            timestamp: Date.now(),
            bandwidth: { uploadMbps: 3, downloadMbps: 10, measurementConfidence: 0.8 },
            natType: NATType.SYMMETRIC,
            latency: {
              averageRttMs: 30,
              minRttMs: 25,
              maxRttMs: 35,
              measurements: new Map([['relay2', 30]]),
            },
            stability: {
              packetLossPercent: 1,
              jitterMs: 5,
              connectionUptime: 20,
              reconnectionCount: 0,
            },
            device: {
              cpuUsagePercent: 50,
              availableMemoryMB: 1024,
              supportedCodecs: ['VP8'],
              hardwareAcceleration: false,
            },
          },
        ],
        [
          'r2',
          {
            participantId: 'r2',
            timestamp: Date.now(),
            bandwidth: { uploadMbps: 4, downloadMbps: 12, measurementConfidence: 0.8 },
            natType: NATType.SYMMETRIC,
            latency: {
              averageRttMs: 25,
              minRttMs: 20,
              maxRttMs: 30,
              measurements: new Map([['relay2', 25]]),
            },
            stability: {
              packetLossPercent: 0.5,
              jitterMs: 3,
              connectionUptime: 25,
              reconnectionCount: 0,
            },
            device: {
              cpuUsagePercent: 40,
              availableMemoryMB: 1536,
              supportedCodecs: ['VP8'],
              hardwareAcceleration: false,
            },
          },
        ],
      ]);

      const updated = topologyManager.handleRelayFailure(
        'relay1',
        topology,
        allMetrics,
        defaultConfig
      );

      expect(updated.version).toBe(2);
      expect(updated.relayNodes).not.toContain('relay1');
      expect(updated.relayNodes).toContain('relay2');

      // All participants should be reassigned to relay2
      const relay2Group = updated.groups.find(g => g.relayNodeId === 'relay2');
      expect(relay2Group?.regularNodeIds).toContain('r1');
      expect(relay2Group?.regularNodeIds).toContain('r2');
      expect(relay2Group?.regularNodeIds).toContain('r3');
    });

    it('should promote replacement relay from affected group', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['r1', 'r2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['r3'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const allMetrics = new Map<string, ParticipantMetrics>([
        [
          'r1',
          {
            participantId: 'r1',
            timestamp: Date.now(),
            bandwidth: { uploadMbps: 15, downloadMbps: 30, measurementConfidence: 0.9 },
            natType: NATType.OPEN,
            latency: {
              averageRttMs: 20,
              minRttMs: 15,
              maxRttMs: 25,
              measurements: new Map([['relay2', 20]]),
            },
            stability: {
              packetLossPercent: 0.2,
              jitterMs: 2,
              connectionUptime: 120,
              reconnectionCount: 0,
            },
            device: {
              cpuUsagePercent: 25,
              availableMemoryMB: 4096,
              supportedCodecs: ['VP8', 'H264', 'VP9'],
              hardwareAcceleration: true,
            },
          },
        ],
        [
          'r2',
          {
            participantId: 'r2',
            timestamp: Date.now(),
            bandwidth: { uploadMbps: 8, downloadMbps: 20, measurementConfidence: 0.8 },
            natType: NATType.FULL_CONE,
            latency: {
              averageRttMs: 25,
              minRttMs: 20,
              maxRttMs: 30,
              measurements: new Map([['relay2', 25]]),
            },
            stability: {
              packetLossPercent: 0.5,
              jitterMs: 4,
              connectionUptime: 100,
              reconnectionCount: 0,
            },
            device: {
              cpuUsagePercent: 35,
              availableMemoryMB: 2048,
              supportedCodecs: ['VP8', 'H264'],
              hardwareAcceleration: true,
            },
          },
        ],
      ]);

      const updated = topologyManager.handleRelayFailure(
        'relay1',
        topology,
        allMetrics,
        defaultConfig
      );

      expect(updated.version).toBe(2);
      expect(updated.relayNodes).not.toContain('relay1');
      expect(updated.relayNodes.length).toBe(2); // relay2 + replacement

      // r1 should be promoted to relay (best metrics)
      expect(updated.relayNodes).toContain('r1');
    });

    it('should handle failure of non-existent relay', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: ['r1'] }],
        relayConnections: [],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();

      const updated = topologyManager.handleRelayFailure(
        'nonexistent',
        topology,
        allMetrics,
        defaultConfig
      );

      expect(updated).toEqual(topology); // No change
    });

    it('should handle last relay failure', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: ['r1', 'r2'] }],
        relayConnections: [],
      };

      const allMetrics = new Map<string, ParticipantMetrics>([
        [
          'r1',
          {
            participantId: 'r1',
            timestamp: Date.now(),
            bandwidth: { uploadMbps: 3, downloadMbps: 10, measurementConfidence: 0.8 },
            natType: NATType.SYMMETRIC,
            latency: {
              averageRttMs: 30,
              minRttMs: 25,
              maxRttMs: 35,
              measurements: new Map(),
            },
            stability: {
              packetLossPercent: 1,
              jitterMs: 5,
              connectionUptime: 20,
              reconnectionCount: 0,
            },
            device: {
              cpuUsagePercent: 50,
              availableMemoryMB: 1024,
              supportedCodecs: ['VP8'],
              hardwareAcceleration: false,
            },
          },
        ],
      ]);

      const updated = topologyManager.handleRelayFailure(
        'relay1',
        topology,
        allMetrics,
        defaultConfig
      );

      expect(updated.relayNodes).toHaveLength(0);
      expect(updated.groups).toHaveLength(0);
    });
  });
});
