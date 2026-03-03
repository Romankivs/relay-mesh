// Connection Optimizer tests
// Task 20.1: Optimize connection count per participant

import { ConnectionOptimizer } from './connection-optimizer';
import { ConnectionTopology } from '../shared/types';

describe('ConnectionOptimizer', () => {
  let optimizer: ConnectionOptimizer;

  beforeEach(() => {
    optimizer = new ConnectionOptimizer();
  });

  describe('verifyRegularNodeConnections', () => {
    it('should verify regular node has exactly 1 connection to assigned relay', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['regular1', 'regular2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['regular3'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const stats = optimizer.verifyRegularNodeConnections('regular1', topology);

      expect(stats.participantId).toBe('regular1');
      expect(stats.role).toBe('regular');
      expect(stats.connectionCount).toBe(1);
      expect(stats.connectedTo).toEqual(['relay1']);
      expect(stats.isOptimal).toBe(true);
      expect(stats.expectedCount).toBe(1);
    });

    it('should throw error if regular node not found in topology', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: ['regular1'] }],
        relayConnections: [],
      };

      expect(() => {
        optimizer.verifyRegularNodeConnections('nonexistent', topology);
      }).toThrow('Participant nonexistent not found in any group');
    });
  });

  describe('verifyRelayNodeConnections', () => {
    it('should verify relay node connects to other relays and assigned regular nodes', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2', 'relay3'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['regular1', 'regular2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['regular3'] },
          { relayNodeId: 'relay3', regularNodeIds: [] },
        ],
        relayConnections: [
          ['relay1', 'relay2'],
          ['relay1', 'relay3'],
          ['relay2', 'relay3'],
        ],
      };

      const stats = optimizer.verifyRelayNodeConnections('relay1', topology);

      expect(stats.participantId).toBe('relay1');
      expect(stats.role).toBe('relay');
      // Should connect to 2 other relays + 2 regular nodes = 4 total
      expect(stats.connectionCount).toBe(4);
      expect(stats.connectedTo).toContain('relay2');
      expect(stats.connectedTo).toContain('relay3');
      expect(stats.connectedTo).toContain('regular1');
      expect(stats.connectedTo).toContain('regular2');
      expect(stats.isOptimal).toBe(true);
      expect(stats.expectedCount).toBe(4);
    });

    it('should verify relay node with no regular nodes only connects to other relays', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['regular1'] },
          { relayNodeId: 'relay2', regularNodeIds: [] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const stats = optimizer.verifyRelayNodeConnections('relay2', topology);

      expect(stats.connectionCount).toBe(1);
      expect(stats.connectedTo).toEqual(['relay1']);
      expect(stats.isOptimal).toBe(true);
      expect(stats.expectedCount).toBe(1);
    });

    it('should throw error if relay node not found in topology', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: [] }],
        relayConnections: [],
      };

      expect(() => {
        optimizer.verifyRelayNodeConnections('nonexistent', topology);
      }).toThrow('Relay node nonexistent not found in topology');
    });
  });

  describe('verifyAllConnections', () => {
    it('should verify all connections in topology', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['regular1', 'regular2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['regular3'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const stats = optimizer.verifyAllConnections(topology);

      expect(stats.size).toBe(5); // 2 relays + 3 regular nodes
      expect(stats.get('relay1')?.isOptimal).toBe(true);
      expect(stats.get('relay2')?.isOptimal).toBe(true);
      expect(stats.get('regular1')?.isOptimal).toBe(true);
      expect(stats.get('regular2')?.isOptimal).toBe(true);
      expect(stats.get('regular3')?.isOptimal).toBe(true);
    });
  });

  describe('isTopologyOptimal', () => {
    it('should return true for optimal topology', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['regular1'] },
          { relayNodeId: 'relay2', regularNodeIds: ['regular2'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      expect(optimizer.isTopologyOptimal(topology)).toBe(true);
    });
  });

  describe('getTotalConnectionCount', () => {
    it('should calculate total connection count correctly', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1', 'relay2'],
        groups: [
          { relayNodeId: 'relay1', regularNodeIds: ['regular1', 'regular2'] },
          { relayNodeId: 'relay2', regularNodeIds: ['regular3'] },
        ],
        relayConnections: [['relay1', 'relay2']],
      };

      const totalConnections = optimizer.getTotalConnectionCount(topology);

      // relay1: 1 other relay + 2 regular = 3
      // relay2: 1 other relay + 1 regular = 2
      // regular1: 1 relay = 1
      // regular2: 1 relay = 1
      // regular3: 1 relay = 1
      // Total: 8 connections (counted from both ends)
      // Actual unique connections: 8 / 2 = 4
      expect(totalConnections).toBe(4);
    });

    it('should handle single relay topology', () => {
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: ['regular1', 'regular2'] }],
        relayConnections: [],
      };

      const totalConnections = optimizer.getTotalConnectionCount(topology);

      // relay1: 0 other relays + 2 regular = 2
      // regular1: 1 relay = 1
      // regular2: 1 relay = 1
      // Total: 4 / 2 = 2 unique connections
      expect(totalConnections).toBe(2);
    });
  });
});
