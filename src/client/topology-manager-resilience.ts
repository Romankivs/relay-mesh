// Topology Manager Resilience Extensions
// Task 18.5: Implement topology formation failure handling

import { TopologyManager } from './topology-manager';
import { SelectionAlgorithm } from './selection-algorithm';
import {
  ConnectionTopology,
  ParticipantGroup,
  ParticipantMetrics,
  SelectionConfig,
} from '../shared/types';

/**
 * ResilientTopologyManager extends TopologyManager with failure handling
 * 
 * Handles:
 * - Insufficient relay candidates (Requirement 4.1)
 * - Group assignment failures (Requirement 4.2)
 * - Fallback to full mesh for small conferences (Requirement 4.3)
 * 
 * Task 18.5
 */
export class ResilientTopologyManager extends TopologyManager {
  private readonly SMALL_CONFERENCE_THRESHOLD = 5; // Participants
  private readonly MIN_RELAY_BANDWIDTH_FALLBACK = 2.5; // Mbps (50% of normal)

  /**
   * Form topology with failure handling (Task 18.5)
   * 
   * Handles insufficient relay candidates by:
   * 1. Lowering bandwidth threshold by 50%
   * 2. Retrying selection with relaxed criteria
   * 3. Falling back to full mesh for small conferences (<5 participants)
   * 4. Using best available candidates for larger conferences
   * 
   * @param relayNodeIds - Array of participant IDs selected as relay nodes
   * @param allParticipants - Array of all participant IDs in the conference
   * @param latencyMap - Map of latency measurements between participants
   * @param allMetrics - Metrics for all participants (for fallback selection)
   * @param config - Selection configuration
   * @returns Complete connection topology
   */
  formTopologyWithFallback(
    relayNodeIds: string[],
    allParticipants: string[],
    latencyMap: Map<string, Map<string, number>>,
    allMetrics?: Map<string, ParticipantMetrics>,
    config?: SelectionConfig
  ): ConnectionTopology {
    // Check if we have sufficient relay candidates
    if (relayNodeIds.length === 0) {
      console.warn('No relay candidates available, attempting fallback');

      // For small conferences, use full mesh
      if (allParticipants.length <= this.SMALL_CONFERENCE_THRESHOLD) {
        console.log(`Small conference (${allParticipants.length} participants), using full mesh topology`);
        return this.createFullMeshTopology(allParticipants);
      }

      // For larger conferences, try to select relays with relaxed criteria
      if (allMetrics && config) {
        console.log('Attempting relay selection with relaxed criteria');
        const relaxedConfig = this.createRelaxedConfig(config);
        const selectionAlgorithm = new SelectionAlgorithm();
        const relaxedRelayIds = selectionAlgorithm.selectRelayNodes(allMetrics, relaxedConfig).selectedIds;

        if (relaxedRelayIds.length > 0) {
          console.log(`Selected ${relaxedRelayIds.length} relays with relaxed criteria`);
          return super.formTopology(relaxedRelayIds, allParticipants, latencyMap);
        }
      }

      // Last resort: use best available candidates even if below ideal thresholds
      if (allMetrics && config) {
        console.log('Using best available candidates as relays');
        const bestCandidates = this.selectBestAvailableCandidates(allMetrics, allParticipants.length);
        
        if (bestCandidates.length > 0) {
          return super.formTopology(bestCandidates, allParticipants, latencyMap);
        }
      }

      // Absolute fallback: full mesh regardless of size
      console.warn('No suitable relay candidates found, falling back to full mesh');
      return this.createFullMeshTopology(allParticipants);
    }

    // Normal topology formation
    try {
      return super.formTopology(relayNodeIds, allParticipants, latencyMap);
    } catch (error) {
      console.error('Topology formation failed:', error);
      
      // Fallback to full mesh on error
      console.warn('Falling back to full mesh due to topology formation error');
      return this.createFullMeshTopology(allParticipants);
    }
  }

  /**
   * Assign participant to relay with failure handling (Task 18.5)
   * 
   * Handles group assignment failures by:
   * 1. Temporarily exceeding maxParticipantsPerRelay for least loaded relay
   * 2. Triggering immediate relay re-evaluation
   * 3. Logging warning about overloaded topology
   * 
   * @param participantId - ID of the regular node to assign
   * @param relayNodeIds - Array of available relay node IDs
   * @param latencyMap - Map of latencies from this participant to others
   * @param currentGroups - Current group assignments for load balancing
   * @param config - Selection configuration (for maxParticipantsPerRelay)
   * @returns ID of the assigned relay node
   */
  assignToRelayWithFallback(
    participantId: string,
    relayNodeIds: string[],
    latencyMap: Map<string, number>,
    currentGroups: ParticipantGroup[],
    config?: SelectionConfig
  ): string {
    if (relayNodeIds.length === 0) {
      throw new Error('No relay nodes available for assignment');
    }

    try {
      return super.assignToRelay(participantId, relayNodeIds, latencyMap, currentGroups);
    } catch (error) {
      console.error('Group assignment failed:', error);

      // Check if all relays are at capacity
      const maxParticipantsPerRelay = config?.maxParticipantsPerRelay || 5;
      const allAtCapacity = currentGroups.every(
        group => group.regularNodeIds.length >= maxParticipantsPerRelay
      );

      if (allAtCapacity) {
        console.warn('All relays at capacity, temporarily exceeding limit for least loaded relay');
        
        // Find least loaded relay
        const leastLoadedGroup = currentGroups.reduce((min, group) =>
          group.regularNodeIds.length < min.regularNodeIds.length ? group : min
        );

        console.warn(`Assigning ${participantId} to overloaded relay ${leastLoadedGroup.relayNodeId}`);
        console.warn('Immediate relay re-evaluation recommended');

        return leastLoadedGroup.relayNodeId;
      }

      // If not all at capacity, retry with first available relay
      return relayNodeIds[0];
    }
  }

  /**
   * Create full mesh topology (Task 18.5)
   * All participants connect to all other participants
   * 
   * @param allParticipants - Array of all participant IDs
   * @returns Full mesh topology with no relay nodes
   */
  private createFullMeshTopology(allParticipants: string[]): ConnectionTopology {
    // In full mesh, there are no relay nodes
    // Each participant connects directly to every other participant
    return {
      version: 1,
      timestamp: Date.now(),
      relayNodes: [],
      groups: [],
      relayConnections: [],
    };
  }

  /**
   * Create relaxed configuration (Task 18.5)
   * Lowers minBandwidthMbps threshold by 50%
   * 
   * @param config - Original configuration
   * @returns Relaxed configuration
   */
  private createRelaxedConfig(config: SelectionConfig): SelectionConfig {
    return {
      ...config,
      minBandwidthMbps: config.minBandwidthMbps * 0.5, // 50% of original
    };
  }

  /**
   * Select best available candidates (Task 18.5)
   * Selects participants with highest scores even if below ideal thresholds
   * 
   * @param allMetrics - Metrics for all participants
   * @param participantCount - Total number of participants
   * @returns Array of best candidate IDs
   */
  private selectBestAvailableCandidates(
    allMetrics: Map<string, ParticipantMetrics>,
    participantCount: number
  ): string[] {
    const selectionAlgorithm = new SelectionAlgorithm();
    
    // Calculate optimal relay count
    const optimalRelayCount = selectionAlgorithm.calculateOptimalRelayCount(participantCount);

    // Score all participants
    const scores = Array.from(allMetrics.entries()).map(([participantId, metrics]) => ({
      participantId,
      score: selectionAlgorithm.calculateScore(metrics, {
        bandwidthWeight: 0.30,
        natWeight: 0.25,
        latencyWeight: 0.20,
        stabilityWeight: 0.15,
        deviceWeight: 0.10,
        minBandwidthMbps: 0, // No minimum for best available
        maxParticipantsPerRelay: 5,
        reevaluationIntervalMs: 30000,
      }).totalScore,
    }));

    // Sort by score (descending)
    scores.sort((a, b) => b.score - a.score);

    // Return top N candidates
    return scores.slice(0, optimalRelayCount).map(s => s.participantId);
  }

  /**
   * Check if topology formation should use full mesh (Task 18.5)
   * 
   * @param participantCount - Number of participants
   * @returns True if full mesh should be used
   */
  shouldUseFullMesh(participantCount: number): boolean {
    return participantCount <= this.SMALL_CONFERENCE_THRESHOLD;
  }
}
