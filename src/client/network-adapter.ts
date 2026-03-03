import { ParticipantMetrics } from '../shared/types';
import { MediaHandler } from './media-handler';
import { MetricsCollector } from './metrics-collector';
import { TopologyManager } from './topology-manager';

/**
 * Configuration for network adaptation behavior
 */
export interface NetworkAdapterConfig {
  // Bandwidth monitoring
  bandwidthCheckIntervalMs: number; // default: 5000 (5 seconds)
  bandwidthChangeThresholdPercent: number; // default: 20 (trigger adaptation on 20% change)
  minBitrateMbps: number; // default: 0.5
  maxBitrateMbps: number; // default: 10

  // Latency monitoring
  latencyCheckIntervalMs: number; // default: 10000 (10 seconds)
  latencyIncreaseThresholdMs: number; // default: 50 (trigger adjustment on 50ms increase)
  highLatencyThresholdMs: number; // default: 200

  // Packet loss monitoring
  packetLossCheckIntervalMs: number; // default: 5000 (5 seconds)
  packetLossThresholdPercent: number; // default: 5
  highPacketLossThresholdPercent: number; // default: 10
}

/**
 * Default configuration values
 */
export const DEFAULT_NETWORK_ADAPTER_CONFIG: NetworkAdapterConfig = {
  bandwidthCheckIntervalMs: 5000,
  bandwidthChangeThresholdPercent: 20,
  minBitrateMbps: 0.5,
  maxBitrateMbps: 10,
  latencyCheckIntervalMs: 10000,
  latencyIncreaseThresholdMs: 50,
  highLatencyThresholdMs: 200,
  packetLossCheckIntervalMs: 5000,
  packetLossThresholdPercent: 5,
  highPacketLossThresholdPercent: 10,
};

/**
 * Callback types for network adaptation events
 */
export type BitrateAdaptationCallback = (
  newBitrateMbps: number,
  reason: string
) => void;

export type LatencyChangeCallback = (
  averageLatencyMs: number,
  shouldAdjustTopology: boolean
) => void;

export type PacketLossCallback = (
  packetLossPercent: number,
  shouldApplyCorrection: boolean
) => void;

/**
 * NetworkAdapter monitors network conditions and triggers adaptations
 * to maintain optimal conference quality.
 *
 * Responsibilities:
 * - Monitor bandwidth changes and adapt bitrate
 * - Monitor latency changes and notify topology manager
 * - Detect packet loss and apply error correction
 */
export class NetworkAdapter {
  private config: NetworkAdapterConfig;
  private metricsCollector: MetricsCollector;
  private mediaHandler: MediaHandler;
  private topologyManager?: TopologyManager;

  private bandwidthMonitorInterval?: NodeJS.Timeout;
  private latencyMonitorInterval?: NodeJS.Timeout;
  private packetLossMonitorInterval?: NodeJS.Timeout;

  private lastBandwidthMbps: number = 0;
  private lastAverageLatencyMs: number = 0;
  private lastPacketLossPercent: number = 0;

  private bitrateCallbacks: BitrateAdaptationCallback[] = [];
  private latencyCallbacks: LatencyChangeCallback[] = [];
  private packetLossCallbacks: PacketLossCallback[] = [];

  private isMonitoring: boolean = false;

  constructor(
    metricsCollector: MetricsCollector,
    mediaHandler: MediaHandler,
    config: Partial<NetworkAdapterConfig> = {}
  ) {
    this.metricsCollector = metricsCollector;
    this.mediaHandler = mediaHandler;
    this.config = { ...DEFAULT_NETWORK_ADAPTER_CONFIG, ...config };
  }

  /**
   * Set the topology manager for latency-based topology adjustments
   */
  setTopologyManager(topologyManager: TopologyManager): void {
    this.topologyManager = topologyManager;
  }

  /**
   * Start monitoring network conditions
   */
  startMonitoring(): void {
    if (this.isMonitoring) {
      return;
    }

    this.isMonitoring = true;

    // Initialize baseline values
    const currentMetrics = this.metricsCollector.getCurrentMetrics();
    this.lastBandwidthMbps = currentMetrics.bandwidth.uploadMbps;
    this.lastAverageLatencyMs = currentMetrics.latency.averageRttMs;
    this.lastPacketLossPercent = currentMetrics.stability.packetLossPercent;

    // Start bandwidth monitoring
    this.bandwidthMonitorInterval = setInterval(() => {
      this.monitorBandwidth();
    }, this.config.bandwidthCheckIntervalMs);

    // Start latency monitoring
    this.latencyMonitorInterval = setInterval(() => {
      this.monitorLatency();
    }, this.config.latencyCheckIntervalMs);

    // Start packet loss monitoring
    this.packetLossMonitorInterval = setInterval(() => {
      this.monitorPacketLoss();
    }, this.config.packetLossCheckIntervalMs);
  }

  /**
   * Stop monitoring network conditions
   */
  stopMonitoring(): void {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;

    if (this.bandwidthMonitorInterval) {
      clearInterval(this.bandwidthMonitorInterval);
      this.bandwidthMonitorInterval = undefined;
    }

    if (this.latencyMonitorInterval) {
      clearInterval(this.latencyMonitorInterval);
      this.latencyMonitorInterval = undefined;
    }

    if (this.packetLossMonitorInterval) {
      clearInterval(this.packetLossMonitorInterval);
      this.packetLossMonitorInterval = undefined;
    }
  }

  /**
   * Monitor bandwidth and trigger bitrate adaptation when needed
   */
  private async monitorBandwidth(): Promise<void> {
    const currentMetrics = this.metricsCollector.getCurrentMetrics();
    const currentBandwidthMbps = currentMetrics.bandwidth.uploadMbps;

    // Calculate percentage change
    const percentChange =
      this.lastBandwidthMbps > 0
        ? Math.abs(currentBandwidthMbps - this.lastBandwidthMbps) /
          this.lastBandwidthMbps *
          100
        : 0;

    // Check if change exceeds threshold
    if (percentChange >= this.config.bandwidthChangeThresholdPercent) {
      const reason =
        currentBandwidthMbps < this.lastBandwidthMbps
          ? 'bandwidth_decrease'
          : 'bandwidth_increase';

      // Calculate target bitrate (use 80% of available bandwidth for safety margin)
      const targetBitrateMbps = Math.max(
        this.config.minBitrateMbps,
        Math.min(this.config.maxBitrateMbps, currentBandwidthMbps * 0.8)
      );

      // Adapt bitrate for all peer connections
      await this.adaptBitrateForAllConnections(targetBitrateMbps, reason);

      // Update last known bandwidth
      this.lastBandwidthMbps = currentBandwidthMbps;

      // Notify subscribers
      this.notifyBitrateAdaptation(targetBitrateMbps, reason);
    }
  }

  /**
   * Adapt bitrate for all active peer connections
   */
  private async adaptBitrateForAllConnections(
    targetBitrateMbps: number,
    reason: string
  ): Promise<void> {
    const peerConnections = this.mediaHandler.getPeerConnections();

    const adaptationPromises: Promise<void>[] = [];

    for (const [remoteParticipantId, peerConnection] of peerConnections) {
      adaptationPromises.push(
        this.mediaHandler
          .adaptBitrate(peerConnection, targetBitrateMbps)
          .catch((error) => {
            console.error(
              `Failed to adapt bitrate for ${remoteParticipantId}:`,
              error
            );
          })
      );
    }

    await Promise.all(adaptationPromises);
  }

  /**
   * Subscribe to bitrate adaptation events
   */
  onBitrateAdaptation(callback: BitrateAdaptationCallback): void {
    this.bitrateCallbacks.push(callback);
  }

  /**
   * Notify subscribers of bitrate adaptation
   */
  private notifyBitrateAdaptation(
    newBitrateMbps: number,
    reason: string
  ): void {
    for (const callback of this.bitrateCallbacks) {
      try {
        callback(newBitrateMbps, reason);
      } catch (error) {
        console.error('Error in bitrate adaptation callback:', error);
      }
    }
  }

  /**
   * Monitor latency and notify topology manager for potential adjustments
   */
  private monitorLatency(): void {
    const currentMetrics = this.metricsCollector.getCurrentMetrics();
    const currentAverageLatencyMs = currentMetrics.latency.averageRttMs;

    // Calculate latency increase
    const latencyIncrease = currentAverageLatencyMs - this.lastAverageLatencyMs;

    // Check if latency increase exceeds threshold
    if (latencyIncrease >= this.config.latencyIncreaseThresholdMs) {
      const shouldAdjustTopology =
        currentAverageLatencyMs >= this.config.highLatencyThresholdMs;

      // Update last known latency
      this.lastAverageLatencyMs = currentAverageLatencyMs;

      // Notify subscribers
      this.notifyLatencyChange(currentAverageLatencyMs, shouldAdjustTopology);
    }
  }

  /**
   * Subscribe to latency change events
   */
  onLatencyChange(callback: LatencyChangeCallback): void {
    this.latencyCallbacks.push(callback);
  }

  /**
   * Notify subscribers of latency changes
   */
  private notifyLatencyChange(
    averageLatencyMs: number,
    shouldAdjustTopology: boolean
  ): void {
    for (const callback of this.latencyCallbacks) {
      try {
        callback(averageLatencyMs, shouldAdjustTopology);
      } catch (error) {
        console.error('Error in latency change callback:', error);
      }
    }
  }

  /**
   * Monitor packet loss and apply error correction when needed
   */
  private monitorPacketLoss(): void {
    const currentMetrics = this.metricsCollector.getCurrentMetrics();
    const currentPacketLossPercent = currentMetrics.stability.packetLossPercent;

    // Check if packet loss exceeds threshold
    if (currentPacketLossPercent >= this.config.packetLossThresholdPercent) {
      const shouldApplyCorrection =
        currentPacketLossPercent >= this.config.highPacketLossThresholdPercent;

      // Update last known packet loss
      this.lastPacketLossPercent = currentPacketLossPercent;

      // Notify subscribers
      this.notifyPacketLoss(currentPacketLossPercent, shouldApplyCorrection);
    }
  }

  /**
   * Subscribe to packet loss events
   */
  onPacketLoss(callback: PacketLossCallback): void {
    this.packetLossCallbacks.push(callback);
  }

  /**
   * Notify subscribers of packet loss detection
   */
  private notifyPacketLoss(
    packetLossPercent: number,
    shouldApplyCorrection: boolean
  ): void {
    for (const callback of this.packetLossCallbacks) {
      try {
        callback(packetLossPercent, shouldApplyCorrection);
      } catch (error) {
        console.error('Error in packet loss callback:', error);
      }
    }
  }

  /**
   * Get current monitoring status
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Get current network conditions summary
   */
  getCurrentConditions(): {
    bandwidthMbps: number;
    averageLatencyMs: number;
    packetLossPercent: number;
  } {
    const metrics = this.metricsCollector.getCurrentMetrics();
    return {
      bandwidthMbps: metrics.bandwidth.uploadMbps,
      averageLatencyMs: metrics.latency.averageRttMs,
      packetLossPercent: metrics.stability.packetLossPercent,
    };
  }
}
