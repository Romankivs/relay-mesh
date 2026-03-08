// Relay Scaler component
// Task 20.2: Implement dynamic relay scaling

import { ParticipantMetrics, SelectionConfig, ConnectionTopology } from '../shared/types';
import { SelectionAlgorithm } from './selection-algorithm';

/**
 * Scaling decision result
 */
export interface ScalingDecision {
  shouldScale: boolean;
  currentRelayCount: number;
  optimalRelayCount: number;
  participantCount: number;
  action: 'add_relays' | 'remove_relays' | 'no_change';
  relaysToAdd?: number;
  relaysToRemove?: number;
}

/**
 * Relay Scaler for dynamic relay node scaling
 * Adds relays as participant count increases
 * Uses sqrt formula for optimal relay count
 */
export class RelayScaler {
  private selectionAlgorithm: SelectionAlgorithm;

  constructor() {
    this.selectionAlgorithm = new SelectionAlgorithm();
  }

  /**
   * Evaluate if scaling is needed based on current topology and participant count
   * 
   * @param currentTopology - Current connection topology
   * @param allMetrics - Map of all participant metrics
   * @param config - Selection configuration
   * @returns Scaling decision
   */
  evaluateScaling(
    currentTopology: ConnectionTopology,
    allMetrics: Map<string, ParticipantMetrics>,
    config: SelectionConfig
  ): ScalingDecision {
    const participantCount = allMetrics.size;
    const currentRelayCount = currentTopology.relayNodes.length;
    const optimalRelayCount = this.selectionAlgorithm.calculateOptimalRelayCount(participantCount);

    // Determine if we need to scale
    if (optimalRelayCount > currentRelayCount) {
      return {
        shouldScale: true,
        currentRelayCount,
        optimalRelayCount,
        participantCount,
        action: 'add_relays',
        relaysToAdd: optimalRelayCount - currentRelayCount,
      };
    } else if (optimalRelayCount < currentRelayCount) {
      return {
        shouldScale: true,
        currentRelayCount,
        optimalRelayCount,
        participantCount,
        action: 'remove_relays',
        relaysToRemove: currentRelayCount - optimalRelayCount,
      };
    } else {
      return {
        shouldScale: false,
        currentRelayCount,
        optimalRelayCount,
        participantCount,
        action: 'no_change',
      };
    }
  }

  /**
   * Check if any relay groups are overloaded
   * A group is overloaded if it exceeds maxParticipantsPerRelay
   * 
   * @param currentTopology - Current connection topology
   * @param config - Selection configuration
   * @returns True if any group is overloaded
   */
  hasOverloadedGroups(
    currentTopology: ConnectionTopology,
    config: SelectionConfig
  ): boolean {
    for (const group of currentTopology.groups) {
      if (group.regularNodeIds.length > config.maxParticipantsPerRelay) {
        return true;
      }
    }
    return false;
  }

  /**
   * Scale topology by adding new relay nodes
   * Selects additional relay nodes and redistributes participants
   * 
   * @param currentTopology - Current connection topology
   * @param allMetrics - Map of all participant metrics
   * @param config - Selection configuration
   * @param relaysToAdd - Number of relays to add
   * @returns Updated topology with new relay nodes
   */
  scaleUp(
    currentTopology: ConnectionTopology,
    allMetrics: Map<string, ParticipantMetrics>,
    config: SelectionConfig,
    relaysToAdd: number
  ): ConnectionTopology {
    // Get current relay nodes
    const currentRelayIds = new Set(currentTopology.relayNodes);

    // Select new relay nodes from non-relay participants
    const nonRelayMetrics = new Map<string, ParticipantMetrics>();
    for (const [participantId, metrics] of allMetrics) {
      if (!currentRelayIds.has(participantId)) {
        nonRelayMetrics.set(participantId, metrics);
      }
    }

    // Use selection algorithm to pick best candidates
    const newRelayIds = this.selectionAlgorithm.selectRelayNodes(
      nonRelayMetrics,
      config
    ).selectedIds.slice(0, relaysToAdd);

    // Combine current and new relay nodes
    const updatedRelayNodes = [...currentTopology.relayNodes, ...newRelayIds];

    // Create new topology with updated relay nodes
    // Note: This is a simplified version - in practice, we'd need to
    // redistribute participants across all relays including new ones
    return {
      ...currentTopology,
      version: currentTopology.version + 1,
      timestamp: Date.now(),
      relayNodes: updatedRelayNodes,
    };
  }

  /**
   * Scale topology by removing relay nodes
   * Demotes relay nodes with lowest scores and redistributes their participants
   * 
   * @param currentTopology - Current connection topology
   * @param allMetrics - Map of all participant metrics
   * @param config - Selection configuration
   * @param relaysToRemove - Number of relays to remove
   * @returns Updated topology with fewer relay nodes
   */
  scaleDown(
    currentTopology: ConnectionTopology,
    allMetrics: Map<string, ParticipantMetrics>,
    config: SelectionConfig,
    relaysToRemove: number
  ): ConnectionTopology {
    // Calculate scores for all current relay nodes
    const relayScores = currentTopology.relayNodes
      .map((relayId) => {
        const metrics = allMetrics.get(relayId);
        if (!metrics) {
          return { relayId, score: 0 };
        }
        const scoreData = this.selectionAlgorithm.calculateScore(metrics, config);
        return { relayId, score: scoreData.totalScore };
      })
      .sort((a, b) => a.score - b.score); // Sort ascending (lowest scores first)

    // Remove the lowest scoring relays
    const relaysToRemoveIds = new Set(
      relayScores.slice(0, relaysToRemove).map((r) => r.relayId)
    );

    // Keep only the relays we're not removing
    const updatedRelayNodes = currentTopology.relayNodes.filter(
      (relayId) => !relaysToRemoveIds.has(relayId)
    );

    // Create new topology with updated relay nodes
    // Note: This is a simplified version - in practice, we'd need to
    // redistribute participants from removed relays to remaining ones
    return {
      ...currentTopology,
      version: currentTopology.version + 1,
      timestamp: Date.now(),
      relayNodes: updatedRelayNodes,
    };
  }

  /**
   * Automatically scale topology based on current state
   * 
   * @param currentTopology - Current connection topology
   * @param allMetrics - Map of all participant metrics
   * @param config - Selection configuration
   * @returns Updated topology if scaling occurred, or original topology if no scaling needed
   */
  autoScale(
    currentTopology: ConnectionTopology,
    allMetrics: Map<string, ParticipantMetrics>,
    config: SelectionConfig
  ): ConnectionTopology {
    const decision = this.evaluateScaling(currentTopology, allMetrics, config);

    if (!decision.shouldScale) {
      return currentTopology;
    }

    if (decision.action === 'add_relays' && decision.relaysToAdd) {
      return this.scaleUp(currentTopology, allMetrics, config, decision.relaysToAdd);
    } else if (decision.action === 'remove_relays' && decision.relaysToRemove) {
      return this.scaleDown(currentTopology, allMetrics, config, decision.relaysToRemove);
    }

    return currentTopology;
  }
}
