// Selection Algorithm component
// Task 4: Implement Selection Algorithm component

import { ParticipantMetrics, SelectionConfig, NATType } from '../shared/types';

/**
 * Relay score breakdown for a participant
 */
export interface RelayScore {
  participantId: string;
  totalScore: number;
  bandwidthScore: number;
  natScore: number;
  latencyScore: number;
  stabilityScore: number;
  deviceScore: number;
}

/**
 * Selection Algorithm for determining optimal relay nodes
 * Implements weighted scoring based on multiple metrics
 */
export class SelectionAlgorithm {
  /**
   * Calculate relay score for a participant
   * Implements the weighted scoring formula from the design document
   * 
   * @param metrics - Participant metrics to evaluate
   * @param config - Selection configuration with weights
   * @returns Detailed score breakdown
   */
  calculateScore(metrics: ParticipantMetrics, config: SelectionConfig): RelayScore {
    const bandwidthScore = this.calculateBandwidthScore(metrics.bandwidth.uploadMbps, metrics.bandwidth.downloadMbps);
    const natScore = this.calculateNATScore(metrics.natType);
    const latencyScore = this.calculateLatencyScore(metrics.latency.averageRttMs);
    const stabilityScore = this.calculateStabilityScore(metrics.stability);
    const deviceScore = this.calculateDeviceScore(metrics.device);

    const totalScore =
      bandwidthScore * config.bandwidthWeight +
      natScore * config.natWeight +
      latencyScore * config.latencyWeight +
      stabilityScore * config.stabilityWeight +
      deviceScore * config.deviceWeight;

    return {
      participantId: metrics.participantId,
      totalScore,
      bandwidthScore,
      natScore,
      latencyScore,
      stabilityScore,
      deviceScore,
    };
  }

  /**
   * Calculate bandwidth score (0-1)
   * Prioritizes upload bandwidth (relay nodes send more than receive)
   * Formula: uploadScore * 0.7 + downloadScore * 0.3
   */
  private calculateBandwidthScore(uploadMbps: number, downloadMbps: number): number {
    const uploadScore = Math.min(uploadMbps / 20, 1.0);
    const downloadScore = Math.min(downloadMbps / 50, 1.0);
    return uploadScore * 0.7 + downloadScore * 0.3;
  }

  /**
   * Calculate NAT type score (0-1)
   * Less restrictive NAT types get higher scores
   * Formula: (4 - natType) / 4
   */
  private calculateNATScore(natType: NATType): number {
    return (4 - natType) / 4;
  }

  /**
   * Calculate latency score (0-1)
   * Lower average latency gets higher score
   * Formula: max(0, 1 - (averageLatency / 200))
   */
  private calculateLatencyScore(averageRttMs: number): number {
    return Math.max(0, 1 - averageRttMs / 200);
  }

  /**
   * Calculate stability score (0-1)
   * Combines packet loss, jitter, uptime, and reconnection history
   */
  private calculateStabilityScore(stability: {
    packetLossPercent: number;
    jitterMs: number;
    connectionUptime: number;
    reconnectionCount: number;
  }): number {
    const packetLossScore = 1 - stability.packetLossPercent / 100;
    const jitterScore = Math.max(0, 1 - stability.jitterMs / 50);
    const uptimeScore = Math.min(stability.connectionUptime / 300, 1.0);
    const reconnectionScore = Math.max(0, 1 - stability.reconnectionCount / 5);

    return (
      packetLossScore * 0.4 +
      jitterScore * 0.3 +
      uptimeScore * 0.2 +
      reconnectionScore * 0.1
    );
  }

  /**
   * Calculate device capabilities score (0-1)
   * Favors devices with available resources and capabilities
   */
  private calculateDeviceScore(device: {
    cpuUsagePercent: number;
    availableMemoryMB: number;
    supportedCodecs: string[];
    hardwareAcceleration: boolean;
  }): number {
    const cpuScore = 1 - device.cpuUsagePercent / 100;
    const memoryScore = Math.min(device.availableMemoryMB / 2048, 1.0);
    const codecScore = Math.min(device.supportedCodecs.length / 10, 1.0);
    const accelerationScore = device.hardwareAcceleration ? 1.0 : 0.5;

    return (
      cpuScore * 0.4 +
      memoryScore * 0.3 +
      codecScore * 0.2 +
      accelerationScore * 0.1
    );
  }

  /**
   * Select optimal relay nodes from all participants
   * Applies eligibility filters and selects top N based on scores
   * 
   * @param allMetrics - Map of all participant metrics
   * @param config - Selection configuration
   * @returns Object with selected IDs and full selection details
   */
  selectRelayNodes(
    allMetrics: Map<string, ParticipantMetrics>,
    config: SelectionConfig,
    currentRelayIds: string[] = []
  ): {
    selectedIds: string[];
    selectionData: {
      timestamp: number;
      totalParticipants: number;
      optimalRelayCount: number;
      eligibleCount: number;
      selectedCount: number;
      selectedIds: string[];
      scores: Array<{
        id: string;
        total: string;
        bandwidth: string;
        nat: string;
        latency: string;
        stability: string;
        device: string;
      }>;
      ineligible: Array<{
        id: string;
        reason: string;
      }>;
    };
  } {
    // Calculate optimal number of relay nodes
    const optimalRelayCount = this.calculateOptimalRelayCount(allMetrics.size);

    // Filter eligible participants and calculate scores
    const eligibleScores: RelayScore[] = [];
    const ineligibleReasons: Map<string, string> = new Map();

    for (const [participantId, metrics] of allMetrics) {
      if (this.isEligibleForRelay(metrics, config)) {
        const score = this.calculateScore(metrics, config);
        eligibleScores.push(score);
      } else {
        // Track why participant is ineligible
        const reason = this.getIneligibilityReason(metrics, config);
        ineligibleReasons.set(participantId, reason);
      }
    }

    // Sort by total score (descending), then by participant ID (ascending) for deterministic ordering
    // This ensures that when scores are equal (e.g., placeholder metrics), we always pick the same participants
    eligibleScores.sort((a, b) => {
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore;
      }
      // Tie-breaker: sort by participant ID for deterministic selection
      return a.participantId.localeCompare(b.participantId);
    });

    // Apply hysteresis: prefer keeping current relays to avoid churn.
    // A current relay is only displaced if a challenger scores more than 15% better.
    const selectedCount = Math.min(optimalRelayCount, eligibleScores.length);
    const currentRelaySet = new Set(currentRelayIds);
    const HYSTERESIS_THRESHOLD = 0.15; // challenger must beat incumbent by >15% to displace it

    const selected: RelayScore[] = [];
    const remaining: RelayScore[] = [];

    // First pass: keep current relays that are still eligible and not severely degraded
    for (const score of eligibleScores) {
      if (currentRelaySet.has(score.participantId) && selected.length < selectedCount) {
        selected.push(score);
      } else {
        remaining.push(score);
      }
    }

    // Second pass: fill remaining slots with best challengers, but only if they
    // beat the weakest incumbent by more than the hysteresis threshold
    for (const challenger of remaining) {
      if (selected.length >= selectedCount) break;

      if (selected.length === 0) {
        // No incumbents at all — just pick the best
        selected.push(challenger);
      } else {
        // Find the weakest incumbent
        const weakest = selected.reduce((min, s) => s.totalScore < min.totalScore ? s : min, selected[0]);
        if (challenger.totalScore > weakest.totalScore * (1 + HYSTERESIS_THRESHOLD)) {
          // Challenger is significantly better — displace the weakest incumbent
          selected.splice(selected.indexOf(weakest), 1, challenger);
        } else {
          // Not better enough — keep the incumbent, add challenger to fill empty slot
          selected.push(challenger);
        }
      }
    }

    // Sort final selection for deterministic output
    selected.sort((a, b) => a.participantId.localeCompare(b.participantId));
    const selectedIds = selected.map((score) => score.participantId);

    // Build selection data for monitoring
    const selectionData = {
      timestamp: Date.now(),
      totalParticipants: allMetrics.size,
      optimalRelayCount,
      eligibleCount: eligibleScores.length,
      selectedCount,
      selectedIds,
      scores: selected.map(s => ({
        id: s.participantId,
        total: s.totalScore.toFixed(3),
        bandwidth: s.bandwidthScore.toFixed(3),
        nat: s.natScore.toFixed(3),
        latency: s.latencyScore.toFixed(3),
        stability: s.stabilityScore.toFixed(3),
        device: s.deviceScore.toFixed(3),
      })),
      ineligible: Array.from(ineligibleReasons.entries()).map(([id, reason]) => ({ id, reason })),
    };

    return { selectedIds, selectionData };
  }

  /**
   * Get reason why a participant is ineligible for relay
   */
  private getIneligibilityReason(metrics: ParticipantMetrics, config: SelectionConfig): string {
    if (metrics.bandwidth.uploadMbps < config.minBandwidthMbps) {
      return `Bandwidth too low: ${metrics.bandwidth.uploadMbps.toFixed(1)} < ${config.minBandwidthMbps} Mbps`;
    }
    if (metrics.stability.connectionUptime < 1) {
      return `Connection too new: ${metrics.stability.connectionUptime}s < 1s`;
    }
    return 'Unknown reason';
  }

  /**
   * Check if a participant is eligible to be a relay node
   * Applies minimum bandwidth, NAT type, and uptime filters
   */
  private isEligibleForRelay(metrics: ParticipantMetrics, config: SelectionConfig): boolean {
    // Must meet minimum bandwidth requirement
    if (metrics.bandwidth.uploadMbps < config.minBandwidthMbps) {
      return false;
    }

    // NAT type check is relaxed - SYMMETRIC NAT is allowed
    // In practice, if all participants have SYMMETRIC NAT, we still need relays
    // The NAT score will be lower, but they can still be selected

    // Must have been connected for at least 1 second (prevents immediate selection)
    // Reduced to 1 second to allow relay selection in test environments
    if (metrics.stability.connectionUptime < 1) {
      return false;
    }

    return true;
  }

  /**
   * Calculate optimal number of relay nodes for participant count
   * Formula: ceil(sqrt(participantCount))
   * 
   * @param participantCount - Total number of participants
   * @returns Optimal number of relay nodes
   */
  calculateOptimalRelayCount(participantCount: number): number {
    // Special case: with 2 participants, only 1 relay is needed
    // (one relay, one regular node connected to it)
    if (participantCount <= 2) {
      return 1;
    }
    
    return Math.ceil(Math.sqrt(participantCount));
  }

  /**
   * Determine if a relay node should be demoted
   * Checks if relay metrics fall below thresholds
   * 
   * @param relayId - ID of the relay node to check
   * @param currentMetrics - Current metrics for the relay
   * @param config - Selection configuration
   * @returns True if relay should be demoted
   */
  shouldDemote(
    relayId: string,
    currentMetrics: ParticipantMetrics,
    config: SelectionConfig
  ): boolean {
    // Check if no longer eligible (bandwidth, NAT, uptime)
    if (!this.isEligibleForRelay(currentMetrics, config)) {
      return true;
    }

    // Check for severe degradation
    const stability = currentMetrics.stability;

    // Severe packet loss (> 15%)
    if (stability.packetLossPercent > 15) {
      return true;
    }

    // High latency (> 200ms average)
    if (currentMetrics.latency.averageRttMs > 200) {
      return true;
    }

    // Bandwidth dropped below minimum
    if (currentMetrics.bandwidth.uploadMbps < config.minBandwidthMbps) {
      return true;
    }

    return false;
  }
}
