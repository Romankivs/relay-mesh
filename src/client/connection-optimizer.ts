// Connection Optimizer component
// Task 20.1: Optimize connection count per participant

import { ConnectionTopology } from '../shared/types';

/**
 * Connection count statistics for a participant
 */
export interface ConnectionStats {
  participantId: string;
  role: 'relay' | 'regular';
  connectionCount: number;
  connectedTo: string[];
  isOptimal: boolean;
  expectedCount: number;
}

/**
 * Connection Optimizer for verifying and optimizing connection counts
 * Ensures regular nodes only connect to assigned relay
 * Ensures relay nodes connect to other relays and assigned regular nodes
 */
export class ConnectionOptimizer {
  /**
   * Verify connection count for a regular node
   * Regular nodes should have exactly 1 connection (to their assigned relay)
   * 
   * @param participantId - ID of the regular node
   * @param topology - Current connection topology
   * @returns Connection statistics
   */
  verifyRegularNodeConnections(
    participantId: string,
    topology: ConnectionTopology
  ): ConnectionStats {
    // Find the group this participant belongs to
    let assignedRelayId: string | undefined;
    for (const group of topology.groups) {
      if (group.regularNodeIds.includes(participantId)) {
        assignedRelayId = group.relayNodeId;
        break;
      }
    }

    if (!assignedRelayId) {
      throw new Error(`Participant ${participantId} not found in any group`);
    }

    // Regular node should only connect to assigned relay
    const expectedCount = 1;
    const connectedTo = [assignedRelayId];
    const connectionCount = connectedTo.length;
    const isOptimal = connectionCount === expectedCount;

    return {
      participantId,
      role: 'regular',
      connectionCount,
      connectedTo,
      isOptimal,
      expectedCount,
    };
  }

  /**
   * Verify connection count for a relay node
   * Relay nodes should connect to:
   * - All other relay nodes (N-1 where N is total relay count)
   * - All regular nodes in their assigned group (M)
   * Total: (N-1) + M connections
   * 
   * @param relayId - ID of the relay node
   * @param topology - Current connection topology
   * @returns Connection statistics
   */
  verifyRelayNodeConnections(
    relayId: string,
    topology: ConnectionTopology
  ): ConnectionStats {
    // Find the group this relay manages
    const group = topology.groups.find((g) => g.relayNodeId === relayId);
    if (!group) {
      throw new Error(`Relay node ${relayId} not found in topology`);
    }

    // Calculate expected connections
    const totalRelayCount = topology.relayNodes.length;
    const otherRelayCount = totalRelayCount - 1;
    const regularNodeCount = group.regularNodeIds.length;
    const expectedCount = otherRelayCount + regularNodeCount;

    // Build list of connected participants
    const connectedTo: string[] = [];

    // Add other relay nodes
    for (const otherRelayId of topology.relayNodes) {
      if (otherRelayId !== relayId) {
        connectedTo.push(otherRelayId);
      }
    }

    // Add regular nodes in this relay's group
    connectedTo.push(...group.regularNodeIds);

    const connectionCount = connectedTo.length;
    const isOptimal = connectionCount === expectedCount;

    return {
      participantId: relayId,
      role: 'relay',
      connectionCount,
      connectedTo,
      isOptimal,
      expectedCount,
    };
  }

  /**
   * Verify all connections in the topology are optimal
   * 
   * @param topology - Current connection topology
   * @returns Map of participant ID to connection statistics
   */
  verifyAllConnections(topology: ConnectionTopology): Map<string, ConnectionStats> {
    const stats = new Map<string, ConnectionStats>();

    // Verify relay nodes
    for (const relayId of topology.relayNodes) {
      const relayStats = this.verifyRelayNodeConnections(relayId, topology);
      stats.set(relayId, relayStats);
    }

    // Verify regular nodes
    for (const group of topology.groups) {
      for (const regularNodeId of group.regularNodeIds) {
        const regularStats = this.verifyRegularNodeConnections(regularNodeId, topology);
        stats.set(regularNodeId, regularStats);
      }
    }

    return stats;
  }

  /**
   * Check if all connections in the topology are optimal
   * 
   * @param topology - Current connection topology
   * @returns True if all connections are optimal
   */
  isTopologyOptimal(topology: ConnectionTopology): boolean {
    const stats = this.verifyAllConnections(topology);
    for (const [, stat] of stats) {
      if (!stat.isOptimal) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get total connection count for the entire topology
   * 
   * @param topology - Current connection topology
   * @returns Total number of connections
   */
  getTotalConnectionCount(topology: ConnectionTopology): number {
    const stats = this.verifyAllConnections(topology);
    let total = 0;
    for (const [, stat] of stats) {
      total += stat.connectionCount;
    }
    // Divide by 2 because each connection is counted twice (once per endpoint)
    return total / 2;
  }
}
