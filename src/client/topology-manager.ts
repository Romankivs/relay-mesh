// Topology Manager component
// Task 6: Implement Topology Manager component

import {
  ConnectionTopology,
  ParticipantGroup,
  ParticipantMetrics,
  SelectionConfig,
} from '../shared/types';
import { SelectionAlgorithm } from './selection-algorithm';

/**
 * Topology Manager for forming and maintaining connection topology
 * Organizes participants into groups around relay nodes
 */
export class TopologyManager {
  private selectionAlgorithm: SelectionAlgorithm;

  constructor() {
    this.selectionAlgorithm = new SelectionAlgorithm();
  }

  /**
   * Form initial topology from relay node selection
   * Task 6.1
   * 
   * Organizes participants into groups around relay nodes
   * Establishes relay-to-relay connections for inter-group communication
   * 
   * @param relayNodeIds - Array of participant IDs selected as relay nodes
   * @param allParticipants - Array of all participant IDs in the conference
   * @param latencyMap - Map of latency measurements between participants
   * @returns Complete connection topology
   */
  formTopology(
    relayNodeIds: string[],
    allParticipants: string[],
    latencyMap: Map<string, Map<string, number>>
  ): ConnectionTopology {
    // Special case: No relay nodes (direct P2P for small conferences)
    if (relayNodeIds.length === 0) {
      // For direct P2P, create a single group with all participants
      // Each participant will connect to all others directly
      const groups: ParticipantGroup[] = allParticipants.length > 0 ? [{
        relayNodeId: allParticipants[0], // Use first participant as nominal "relay" for group structure
        regularNodeIds: allParticipants.slice(1), // All others are "regular" nodes
      }] : [];

      return {
        version: 1,
        timestamp: Date.now(),
        relayNodes: [], // No actual relay nodes
        groups,
        relayConnections: [], // No relay-to-relay connections
      };
    }

    // Initialize groups for each relay node
    const groups: ParticipantGroup[] = relayNodeIds.map(relayId => ({
      relayNodeId: relayId,
      regularNodeIds: [],
    }));

    // Separate regular nodes from relay nodes
    const regularNodeIds = allParticipants.filter(id => !relayNodeIds.includes(id));

    // Assign each regular node to a relay
    for (const regularNodeId of regularNodeIds) {
      const participantLatencies = latencyMap.get(regularNodeId) || new Map();
      const assignedRelayId = this.assignToRelay(
        regularNodeId,
        relayNodeIds,
        participantLatencies,
        groups
      );

      // Add to the assigned relay's group
      const group = groups.find(g => g.relayNodeId === assignedRelayId);
      if (group) {
        group.regularNodeIds.push(regularNodeId);
      }
    }

    // Create relay-to-relay connections (full mesh)
    const relayConnections = this.createRelayMesh(relayNodeIds);

    return {
      version: 1,
      timestamp: Date.now(),
      relayNodes: relayNodeIds,
      groups,
      relayConnections,
    };
  }

  /**
   * Assign a regular node to optimal relay node
   * Task 6.2
   * 
   * Assigns based on network proximity (latency) and load balancing
   * 
   * @param participantId - ID of the regular node to assign
   * @param relayNodeIds - Array of available relay node IDs
   * @param latencyMap - Map of latencies from this participant to others
   * @param currentGroups - Current group assignments for load balancing
   * @returns ID of the assigned relay node
   */
  assignToRelay(
    participantId: string,
    relayNodeIds: string[],
    latencyMap: Map<string, number>,
    currentGroups: ParticipantGroup[]
  ): string {
    if (relayNodeIds.length === 0) {
      throw new Error('No relay nodes available for assignment');
    }

    // Calculate scores for each relay based on latency
    const relayScores = relayNodeIds.map(relayId => {
      const latency = latencyMap.get(relayId) || Infinity;
      const group = currentGroups.find(g => g.relayNodeId === relayId);
      const currentLoad = group ? group.regularNodeIds.length : 0;

      return {
        relayId,
        latency,
        currentLoad,
      };
    });

    // Sort by latency (ascending), then by load (ascending)
    relayScores.sort((a, b) => {
      // First priority: latency
      if (a.latency !== b.latency) {
        return a.latency - b.latency;
      }
      // Second priority: load balancing
      return a.currentLoad - b.currentLoad;
    });

    // Return the relay with lowest latency and load
    return relayScores[0].relayId;
  }

  /**
   * Create full mesh connections between relay nodes
   * Task 6.6
   * 
   * @param relayNodeIds - Array of relay node IDs
   * @returns Array of relay-to-relay connection pairs
   */
  private createRelayMesh(relayNodeIds: string[]): Array<[string, string]> {
    const connections: Array<[string, string]> = [];

    // Create full mesh: each relay connects to every other relay
    for (let i = 0; i < relayNodeIds.length; i++) {
      for (let j = i + 1; j < relayNodeIds.length; j++) {
        connections.push([relayNodeIds[i], relayNodeIds[j]]);
      }
    }

    return connections;
  }

  /**
   * Balance load across relay nodes
   * Task 6.4
   * 
   * Ensures groups are balanced within maxParticipantsPerRelay
   * Redistributes participants if load is unbalanced
   * 
   * @param currentTopology - Current topology to balance
   * @param latencyMap - Map of latency measurements for reassignment decisions
   * @returns Balanced topology
   */
  balanceLoad(
    currentTopology: ConnectionTopology,
    latencyMap: Map<string, Map<string, number>>
  ): ConnectionTopology {
    const groups = [...currentTopology.groups];

    // Calculate load for each group
    const groupLoads = groups.map(group => ({
      relayId: group.relayNodeId,
      load: group.regularNodeIds.length,
      group,
    }));

    // Sort by load
    groupLoads.sort((a, b) => b.load - a.load);

    // Check if rebalancing is needed
    const maxLoad = groupLoads[0]?.load || 0;
    const minLoad = groupLoads[groupLoads.length - 1]?.load || 0;
    const loadDifference = maxLoad - minLoad;

    // If load difference is acceptable, no rebalancing needed
    if (loadDifference <= 1) {
      return currentTopology;
    }

    // Rebalance: move participants from overloaded to underloaded relays
    let rebalanced = false;
    for (let i = 0; i < groupLoads.length - 1; i++) {
      const overloadedGroup = groupLoads[i];
      const underloadedGroup = groupLoads[groupLoads.length - 1 - i];

      if (overloadedGroup.load - underloadedGroup.load <= 1) {
        break;
      }

      // Find the best participant to move (highest latency to current relay)
      const participantToMove = this.findBestParticipantToMove(
        overloadedGroup.group,
        underloadedGroup.relayId,
        latencyMap
      );

      if (participantToMove) {
        // Remove from overloaded group
        overloadedGroup.group.regularNodeIds = overloadedGroup.group.regularNodeIds.filter(
          id => id !== participantToMove
        );
        overloadedGroup.load--;

        // Add to underloaded group
        underloadedGroup.group.regularNodeIds.push(participantToMove);
        underloadedGroup.load++;

        rebalanced = true;
      }
    }

    if (rebalanced) {
      return {
        ...currentTopology,
        version: currentTopology.version + 1,
        timestamp: Date.now(),
        groups,
      };
    }

    return currentTopology;
  }

  /**
   * Find the best participant to move from one group to another
   * Selects participant with highest latency to current relay
   * and acceptable latency to target relay
   */
  private findBestParticipantToMove(
    sourceGroup: ParticipantGroup,
    targetRelayId: string,
    latencyMap: Map<string, Map<string, number>>
  ): string | null {
    if (sourceGroup.regularNodeIds.length === 0) {
      return null;
    }

    // Score each participant for moving
    const moveScores = sourceGroup.regularNodeIds.map(participantId => {
      const participantLatencies = latencyMap.get(participantId) || new Map();
      const currentRelayLatency = participantLatencies.get(sourceGroup.relayNodeId) || 0;
      const targetRelayLatency = participantLatencies.get(targetRelayId) || Infinity;

      // Only consider if target latency is not much worse (within 50ms)
      const latencyIncrease = targetRelayLatency - currentRelayLatency;
      if (latencyIncrease > 50) {
        return { participantId, score: -Infinity };
      }

      // Prefer moving participants with higher latency to current relay
      return { participantId, score: currentRelayLatency };
    });

    // Sort by score (descending)
    moveScores.sort((a, b) => b.score - a.score);

    // Return best candidate if score is valid
    if (moveScores[0].score > -Infinity) {
      return moveScores[0].participantId;
    }

    return null;
  }

  /**
   * Handle participant joining
   * Task 6.10
   * 
   * Integrates new participant into existing topology
   * 
   * @param participantId - ID of the joining participant
   * @param currentTopology - Current topology
   * @param metrics - Metrics for the joining participant
   * @returns Updated topology
   */
  handleJoin(
    participantId: string,
    currentTopology: ConnectionTopology,
    metrics: ParticipantMetrics
  ): ConnectionTopology {
    // If this is the first participant, create empty topology
    if (currentTopology.relayNodes.length === 0) {
      return {
        version: 1,
        timestamp: Date.now(),
        relayNodes: [],
        groups: [],
        relayConnections: [],
      };
    }

    // Assign to a relay based on latency
    const latencyMap = metrics.latency.measurements;
    const groups = [...currentTopology.groups];

    const assignedRelayId = this.assignToRelay(
      participantId,
      currentTopology.relayNodes,
      latencyMap,
      groups
    );

    // Add to the assigned relay's group
    const group = groups.find(g => g.relayNodeId === assignedRelayId);
    if (group) {
      group.regularNodeIds.push(participantId);
    }

    return {
      ...currentTopology,
      version: currentTopology.version + 1,
      timestamp: Date.now(),
      groups,
    };
  }

  /**
   * Handle participant leaving
   * Task 6.12
   * 
   * Removes participant and updates topology
   * Distinguishes between regular node and relay node leaving
   * 
   * @param participantId - ID of the leaving participant
   * @param currentTopology - Current topology
   * @returns Updated topology
   */
  handleLeave(
    participantId: string,
    currentTopology: ConnectionTopology
  ): ConnectionTopology {
    // Check if leaving participant is a relay node
    const isRelayNode = currentTopology.relayNodes.includes(participantId);

    if (isRelayNode) {
      // Relay node leaving - trigger relay failure handling
      // This will be handled by handleRelayFailure
      throw new Error(
        `Relay node ${participantId} leaving - use handleRelayFailure instead`
      );
    }

    // Regular node leaving - simply remove from group
    const groups = currentTopology.groups.map(group => ({
      ...group,
      regularNodeIds: group.regularNodeIds.filter(id => id !== participantId),
    }));

    return {
      ...currentTopology,
      version: currentTopology.version + 1,
      timestamp: Date.now(),
      groups,
    };
  }

  /**
   * Handle relay node failure
   * Task 6.16
   * 
   * Selects replacement relay or redistributes participants
   * 
   * @param failedRelayId - ID of the failed relay node
   * @param currentTopology - Current topology
   * @param allMetrics - Metrics for all participants
   * @returns Updated topology
   */
  handleRelayFailure(
    failedRelayId: string,
    currentTopology: ConnectionTopology,
    allMetrics: Map<string, ParticipantMetrics>,
    config: SelectionConfig
  ): ConnectionTopology {
    // Find the failed relay's group
    const failedGroup = currentTopology.groups.find(
      g => g.relayNodeId === failedRelayId
    );

    if (!failedGroup) {
      // Relay not found, return current topology
      return currentTopology;
    }

    // Get affected participants (regular nodes in the failed group)
    const affectedParticipants = failedGroup.regularNodeIds;

    // Remove failed relay from topology
    const remainingRelayNodes = currentTopology.relayNodes.filter(
      id => id !== failedRelayId
    );
    let groups = currentTopology.groups.filter(
      g => g.relayNodeId !== failedRelayId
    );

    // Try to select a replacement relay from affected participants
    const affectedMetrics = new Map(
      Array.from(allMetrics.entries()).filter(([id]) =>
        affectedParticipants.includes(id)
      )
    );

    const replacementCandidates = this.selectionAlgorithm.selectRelayNodes(
      affectedMetrics,
      config
    );

    if (replacementCandidates.length > 0 && remainingRelayNodes.length > 0) {
      // Promote a replacement relay from the affected group
      const replacementRelayId = replacementCandidates[0];

      // Create new group for replacement relay
      const newGroup: ParticipantGroup = {
        relayNodeId: replacementRelayId,
        regularNodeIds: affectedParticipants.filter(id => id !== replacementRelayId),
      };

      groups.push(newGroup);
      remainingRelayNodes.push(replacementRelayId);
    } else {
      // No suitable replacement - redistribute to existing relays
      if (remainingRelayNodes.length > 0) {
        // Build latency map for reassignment
        const latencyMap = new Map<string, Map<string, number>>();
        for (const participantId of affectedParticipants) {
          const metrics = allMetrics.get(participantId);
          if (metrics) {
            latencyMap.set(participantId, metrics.latency.measurements);
          }
        }

        // Reassign each affected participant
        for (const participantId of affectedParticipants) {
          const participantLatencies = latencyMap.get(participantId) || new Map();
          const assignedRelayId = this.assignToRelay(
            participantId,
            remainingRelayNodes,
            participantLatencies,
            groups
          );

          // Add to assigned group
          const group = groups.find(g => g.relayNodeId === assignedRelayId);
          if (group) {
            group.regularNodeIds.push(participantId);
          }
        }
      } else {
        // No remaining relays - all participants become regular nodes
        // This is a degenerate case - conference should probably end
        groups = [];
      }
    }

    // Update relay-to-relay connections
    const relayConnections = this.createRelayMesh(remainingRelayNodes);

    return {
      version: currentTopology.version + 1,
      timestamp: Date.now(),
      relayNodes: remainingRelayNodes,
      groups,
      relayConnections,
    };
  }
}
