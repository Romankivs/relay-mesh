// Relay Scaler tests
// Task 20.2: Implement dynamic relay scaling

import { RelayScaler } from './relay-scaler';
import { ConnectionTopology, ParticipantMetrics, SelectionConfig, NATType } from '../shared/types';

describe('RelayScaler', () => {
  let scaler: RelayScaler;
  let config: SelectionConfig;

  beforeEach(() => {
    scaler = new RelayScaler();
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

  describe('evaluateScaling', () => {
    it('should recommend adding relays when participant count increases', () => {
      // 9 participants should need 3 relays (sqrt(9) = 3)
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'], // Currently only 2 relays
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['p1', 'p2', 'p3'] },
          { relayNodeId: 'relay2', regularNodeIds: ['p4', 'p5', 'p6', 'p7'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      for (let i = 1; i <= 7; i++) {
        allMetrics.set(`p${i}`, createMetrics(`p${i}`));
      }
      allMetrics.set('relay1', createMetrics('relay1'));
      allMetrics.set('relay2', createMetrics('relay2'));

      const decision = scaler.evaluateScaling(topology, allMetrics, config);

      expect(decision.shouldScale).toBe(true);
      expect(decision.action).toBe('add_relays');
      expect(decision.currentRelayCount).toBe(2);
      expect(decision.optimalRelayCount).toBe(3);
      expect(decision.participantCount).toBe(9);
      expect(decision.relaysToAdd).toBe(1);
    });

    it('should recommend removing relays when participant count decreases', () => {
      // 4 participants should need 2 relays (sqrt(4) = 2)
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2', 'relay3'], // Currently 3 relays
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['p1'] },
          { relayNodeId: 'relay2', regularNodeIds: [] },
          { relayNodeId: 'relay3', regularNodeIds: [] },
        ],
        relayConnections: [
          ['relay1', 'relay2'],
          ['relay1', 'relay3'],
          ['relay2', 'relay3'],
        ],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      allMetrics.set('p1', createMetrics('p1'));
      allMetrics.set('relay1', createMetrics('relay1'));
      allMetrics.set('relay2', createMetrics('relay2'));
      allMetrics.set('relay3', createMetrics('relay3'));

      const decision = scaler.evaluateScaling(topology, allMetrics, config);

      expect(decision.shouldScale).toBe(true);
      expect(decision.action).toBe('remove_relays');
      expect(decision.currentRelayCount).toBe(3);
      expect(decision.optimalRelayCount).toBe(2);
      expect(decision.participantCount).toBe(4);
      expect(decision.relaysToRemove).toBe(1);
    });

    it('should recommend no change when relay count is optimal', () => {
      // 4 participants should need 2 relays (sqrt(4) = 2)
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'], // Exactly 2 relays
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['p1'] },
          { relayNodeId: 'relay2', regularNodeIds: ['p2'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      allMetrics.set('p1', createMetrics('p1'));
      allMetrics.set('p2', createMetrics('p2'));
      allMetrics.set('relay1', createMetrics('relay1'));
      allMetrics.set('relay2', createMetrics('relay2'));

      const decision = scaler.evaluateScaling(topology, allMetrics, config);

      expect(decision.shouldScale).toBe(false);
      expect(decision.action).toBe('no_change');
      expect(decision.currentRelayCount).toBe(2);
      expect(decision.optimalRelayCount).toBe(2);
    });
  });

  describe('hasOverloadedGroups', () => {
    it('should detect overloaded groups', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [
          {
            relayNodeId: 'relay1',
            regularNodeIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], // 6 > maxParticipantsPerRelay (5)
          },
        ],
        relayConnections: [],
      };

      expect(scaler.hasOverloadedGroups(topology, config)).toBe(true);
    });

    it('should return false when no groups are overloaded', () => {
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

      expect(scaler.hasOverloadedGroups(topology, config)).toBe(false);
    });
  });

  describe('scaleUp', () => {
    it('should add new relay nodes to topology', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: ['p1', 'p2', 'p3'] }],
        relayConnections: [],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      allMetrics.set('relay1', createMetrics('relay1', 15));
      allMetrics.set('p1', createMetrics('p1', 12));
      allMetrics.set('p2', createMetrics('p2', 10));
      allMetrics.set('p3', createMetrics('p3', 8));

      const updatedTopology = scaler.scaleUp(topology, allMetrics, config, 1);

      expect(updatedTopology.relayNodes.length).toBe(2);
      expect(updatedTopology.relayNodes).toContain('relay1');
      expect(updatedTopology.version).toBe(2);
    });

    it('should select best candidates from non-relay participants', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: ['p1', 'p2', 'p3'] }],
        relayConnections: [],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      allMetrics.set('relay1', createMetrics('relay1', 15));
      allMetrics.set('p1', createMetrics('p1', 20)); // Best candidate
      allMetrics.set('p2', createMetrics('p2', 10));
      allMetrics.set('p3', createMetrics('p3', 8));

      const updatedTopology = scaler.scaleUp(topology, allMetrics, config, 1);

      expect(updatedTopology.relayNodes).toContain('p1');
    });
  });

  describe('scaleDown', () => {
    it('should remove lowest scoring relay nodes', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2', 'relay3'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: [] },
          { relayNodeId: 'relay2', regularNodeIds: [] },
          { relayNodeId: 'relay3', regularNodeIds: [] },
        ],
        relayConnections: [
          ['relay1', 'relay2'],
          ['relay1', 'relay3'],
          ['relay2', 'relay3'],
        ],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      allMetrics.set('relay1', createMetrics('relay1', 15)); // Best
      allMetrics.set('relay2', createMetrics('relay2', 10)); // Medium
      allMetrics.set('relay3', createMetrics('relay3', 5)); // Worst

      const updatedTopology = scaler.scaleDown(topology, allMetrics, config, 1);

      expect(updatedTopology.relayNodes.length).toBe(2);
      expect(updatedTopology.relayNodes).toContain('relay1');
      expect(updatedTopology.relayNodes).toContain('relay2');
      expect(updatedTopology.relayNodes).not.toContain('relay3');
      expect(updatedTopology.version).toBe(2);
    });
  });

  describe('autoScale', () => {
    it('should automatically scale up when needed', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: ['p1', 'p2', 'p3'] }],
        relayConnections: [],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      allMetrics.set('relay1', createMetrics('relay1', 15));
      allMetrics.set('p1', createMetrics('p1', 12));
      allMetrics.set('p2', createMetrics('p2', 10));
      allMetrics.set('p3', createMetrics('p3', 8));

      const updatedTopology = scaler.autoScale(topology, allMetrics, config);

      expect(updatedTopology.relayNodes.length).toBe(2);
    });

    it('should return original topology when no scaling needed', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['p1'] },
          { relayNodeId: 'relay2', regularNodeIds: ['p2'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      allMetrics.set('p1', createMetrics('p1'));
      allMetrics.set('p2', createMetrics('p2'));
      allMetrics.set('relay1', createMetrics('relay1'));
      allMetrics.set('relay2', createMetrics('relay2'));

      const updatedTopology = scaler.autoScale(topology, allMetrics, config);

      expect(updatedTopology).toBe(topology);
    });
  });

  describe('scaling with different participant counts', () => {
    it('should scale correctly for 5 participants (needs 3 relays)', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['p1', 'p2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['p3'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const allMetrics = new Map<string, ParticipantMetrics>();
      for (let i = 1; i <= 3; i++) {
        allMetrics.set(`p${i}`, createMetrics(`p${i}`));
      }
      allMetrics.set('relay1', createMetrics('relay1'));
      allMetrics.set('relay2', createMetrics('relay2'));

      const decision = scaler.evaluateScaling(topology, allMetrics, config);

      expect(decision.participantCount).toBe(5);
      expect(decision.optimalRelayCount).toBe(3); // ceil(sqrt(5)) = 3
      expect(decision.shouldScale).toBe(true);
      expect(decision.action).toBe('add_relays');
    });

    it('should scale correctly for 10 participants (needs 4 relays)', () => {
      const allMetrics = new Map<string, ParticipantMetrics>();
      for (let i = 1; i <= 10; i++) {
        allMetrics.set(`p${i}`, createMetrics(`p${i}`));
      }

      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['p1', 'p2', 'p3'],
        groups: [
          { relayNodeId: 'p1', regularNodeIds: ['p4', 'p5'] },
          { relayNodeId: 'p2', regularNodeIds: ['p6', 'p7'] },
          { relayNodeId: 'p3', regularNodeIds: ['p8', 'p9', 'p10'] },
        ],
        relayConnections: [
          ['p1', 'p2'],
          ['p1', 'p3'],
          ['p2', 'p3'],
        ],
      };

      const decision = scaler.evaluateScaling(topology, allMetrics, config);

      expect(decision.participantCount).toBe(10);
      expect(decision.optimalRelayCount).toBe(4); // ceil(sqrt(10)) = 4
      expect(decision.shouldScale).toBe(true);
      expect(decision.action).toBe('add_relays');
    });

    it('should scale correctly for 20 participants (needs 5 relays)', () => {
      const allMetrics = new Map<string, ParticipantMetrics>();
      for (let i = 1; i <= 20; i++) {
        allMetrics.set(`p${i}`, createMetrics(`p${i}`));
      }

      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['p1', 'p2', 'p3', 'p4'],
        groups: [
          { relayNodeId: 'p1', regularNodeIds: ['p5', 'p6', 'p7', 'p8'] },
          { relayNodeId: 'p2', regularNodeIds: ['p9', 'p10', 'p11', 'p12'] },
          { relayNodeId: 'p3', regularNodeIds: ['p13', 'p14', 'p15', 'p16'] },
          { relayNodeId: 'p4', regularNodeIds: ['p17', 'p18', 'p19', 'p20'] },
        ],
        relayConnections: [
          ['p1', 'p2'],
          ['p1', 'p3'],
          ['p1', 'p4'],
          ['p2', 'p3'],
          ['p2', 'p4'],
          ['p3', 'p4'],
        ],
      };

      const decision = scaler.evaluateScaling(topology, allMetrics, config);

      expect(decision.participantCount).toBe(20);
      expect(decision.optimalRelayCount).toBe(5); // ceil(sqrt(20)) = 5
      expect(decision.shouldScale).toBe(true);
      expect(decision.action).toBe('add_relays');
    });
  });
});
