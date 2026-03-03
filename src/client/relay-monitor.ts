// Relay Monitor component
// Task 18.2: Implement relay failure detection
// Monitors relay connection state and detects disconnection within 5 seconds

import { MediaHandler } from './media-handler';

/**
 * Callback type for relay failure events
 */
export type RelayFailureCallback = (relayId: string, reason: string) => void;

/**
 * Connection health status
 */
interface ConnectionHealth {
  relayId: string;
  lastSeen: number;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  consecutiveFailures: number;
}

/**
 * RelayMonitor monitors relay node connections and detects failures
 * 
 * Responsibilities:
 * - Monitor relay connection state continuously
 * - Detect disconnection within 5 seconds (Requirement 7.2)
 * - Trigger failure callbacks when relay becomes unavailable
 * - Track connection health metrics
 * 
 * Requirements: 7.1, 7.2
 */
export class RelayMonitor {
  private mediaHandler: MediaHandler;
  private relayHealthMap: Map<string, ConnectionHealth> = new Map();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private failureCallbacks: RelayFailureCallback[] = [];
  private readonly HEALTH_CHECK_INTERVAL_MS = 1000; // Check every 1 second
  private readonly FAILURE_THRESHOLD_MS = 5000; // Detect failure within 5 seconds
  private readonly CONSECUTIVE_FAILURES_THRESHOLD = 2; // Require 2 consecutive failures for stability

  constructor(mediaHandler: MediaHandler) {
    this.mediaHandler = mediaHandler;
  }

  /**
   * Start monitoring relay connections (Task 18.2)
   * Begins periodic health checks of relay nodes
   * 
   * Requirement 7.1: Monitor relay connection state
   */
  startMonitoring(): void {
    if (this.monitoringInterval) {
      return; // Already monitoring
    }

    this.monitoringInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Stop monitoring relay connections
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  /**
   * Register a relay node for monitoring (Task 18.2)
   * 
   * @param relayId - ID of the relay node to monitor
   */
  registerRelay(relayId: string): void {
    if (!this.relayHealthMap.has(relayId)) {
      this.relayHealthMap.set(relayId, {
        relayId,
        lastSeen: Date.now(),
        connectionState: 'new',
        iceConnectionState: 'new',
        consecutiveFailures: 0,
      });
    }
  }

  /**
   * Unregister a relay node from monitoring
   * 
   * @param relayId - ID of the relay node to stop monitoring
   */
  unregisterRelay(relayId: string): void {
    this.relayHealthMap.delete(relayId);
  }

  /**
   * Register callback for relay failure events (Task 18.2)
   * 
   * @param callback - Function to call when relay failure is detected
   */
  onRelayFailure(callback: RelayFailureCallback): void {
    this.failureCallbacks.push(callback);
  }

  /**
   * Update relay connection health (Task 18.2)
   * Should be called when connection state changes
   * 
   * @param relayId - ID of the relay node
   * @param connectionState - Current RTCPeerConnection state
   * @param iceConnectionState - Current ICE connection state
   */
  updateRelayHealth(
    relayId: string,
    connectionState: RTCPeerConnectionState,
    iceConnectionState: RTCIceConnectionState
  ): void {
    const health = this.relayHealthMap.get(relayId);
    if (!health) {
      return; // Not monitoring this relay
    }

    // Update health status
    health.connectionState = connectionState;
    health.iceConnectionState = iceConnectionState;

    // Connection is only healthy if BOTH states are healthy
    const isConnectionHealthy =
      (connectionState === 'connected' || connectionState === 'new' || connectionState === 'connecting') &&
      (iceConnectionState === 'connected' || iceConnectionState === 'completed' || iceConnectionState === 'new' || iceConnectionState === 'checking');

    // If connection is healthy, reset failure counter and update last seen
    if (isConnectionHealthy) {
      health.lastSeen = Date.now();
      health.consecutiveFailures = 0;
    }
  }

  /**
   * Perform health check on all monitored relays (Task 18.2)
   * Detects disconnection within 5 seconds (Requirement 7.2)
   * 
   * This method:
   * 1. Checks connection state of each relay
   * 2. Detects if relay has been disconnected for > 5 seconds
   * 3. Triggers failure callbacks for failed relays
   */
  private performHealthCheck(): void {
    const now = Date.now();

    for (const [relayId, health] of this.relayHealthMap.entries()) {
      // Get current peer connection
      const peerConnections = this.mediaHandler.getPeerConnections();
      const peerConnection = peerConnections.get(relayId);

      if (!peerConnection) {
        // Connection doesn't exist - relay may have been removed
        continue;
      }

      // Update health from peer connection
      this.updateRelayHealth(
        relayId,
        peerConnection.connectionState,
        peerConnection.iceConnectionState
      );

      // Check for failure conditions
      const timeSinceLastSeen = now - health.lastSeen;
      const isConnectionFailed =
        health.connectionState === 'failed' ||
        health.connectionState === 'closed' ||
        health.iceConnectionState === 'failed' ||
        health.iceConnectionState === 'closed';

      const isConnectionDisconnected =
        health.connectionState === 'disconnected' ||
        health.iceConnectionState === 'disconnected';

      // Detect failure within 5 seconds (Requirement 7.2)
      if (isConnectionFailed) {
        // Immediate failure - increment counter
        health.consecutiveFailures++;
        if (health.consecutiveFailures >= this.CONSECUTIVE_FAILURES_THRESHOLD) {
          this.triggerRelayFailure(relayId, 'Connection failed');
        }
      } else if (isConnectionDisconnected && timeSinceLastSeen >= this.FAILURE_THRESHOLD_MS) {
        // Disconnected for more than 5 seconds
        health.consecutiveFailures++;
        if (health.consecutiveFailures >= this.CONSECUTIVE_FAILURES_THRESHOLD) {
          this.triggerRelayFailure(relayId, 'Connection disconnected for > 5 seconds');
        }
      } else if (timeSinceLastSeen >= this.FAILURE_THRESHOLD_MS * 2) {
        // No activity for more than 10 seconds (double the threshold)
        health.consecutiveFailures++;
        if (health.consecutiveFailures >= this.CONSECUTIVE_FAILURES_THRESHOLD) {
          this.triggerRelayFailure(relayId, 'No activity for > 10 seconds');
        }
      } else {
        // Connection appears healthy
        health.consecutiveFailures = 0;
      }
    }
  }

  /**
   * Trigger relay failure callbacks (Task 18.2)
   * 
   * @param relayId - ID of the failed relay
   * @param reason - Reason for failure
   */
  private triggerRelayFailure(relayId: string, reason: string): void {
    console.warn(`Relay failure detected: ${relayId} - ${reason}`);

    // Remove from monitoring to prevent duplicate failures
    this.unregisterRelay(relayId);

    // Notify all registered callbacks
    this.failureCallbacks.forEach((callback) => {
      try {
        callback(relayId, reason);
      } catch (error) {
        console.error(
          `Error in relay failure callback: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /**
   * Get health status for a relay
   * 
   * @param relayId - ID of the relay node
   * @returns Health status or undefined if not monitored
   */
  getRelayHealth(relayId: string): ConnectionHealth | undefined {
    return this.relayHealthMap.get(relayId);
  }

  /**
   * Get health status for all monitored relays
   * 
   * @returns Map of relay IDs to health status
   */
  getAllRelayHealth(): Map<string, ConnectionHealth> {
    return new Map(this.relayHealthMap);
  }

  /**
   * Cleanup and stop monitoring
   */
  cleanup(): void {
    this.stopMonitoring();
    this.relayHealthMap.clear();
    this.failureCallbacks = [];
  }
}
