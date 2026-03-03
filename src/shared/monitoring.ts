// Monitoring and diagnostics interfaces and implementation

import {
  ConnectionTopology,
  ParticipantMetrics,
  Conference,
  Participant,
} from './types';

// ============================================================================
// Monitoring Interfaces (Task 17.1, 17.2)
// ============================================================================

/**
 * Snapshot of current topology state for monitoring
 * Requirements: 14.1, 14.2
 */
export interface TopologySnapshot {
  topology: ConnectionTopology;
  relayNodeAssignments: RelayNodeAssignment[];
  timestamp: number;
}

/**
 * Information about a relay node and its assignments
 * Requirements: 14.1, 14.2
 */
export interface RelayNodeAssignment {
  relayNodeId: string;
  metrics: ParticipantMetrics;
  assignedRegularNodes: string[];
  connectedRelayNodes: string[];
  groupSize: number;
  loadFactor: number; // 0-1, based on maxParticipantsPerRelay
}

/**
 * Connection quality metrics for a participant
 * Requirements: 14.5
 */
export interface ConnectionQualityMetrics {
  participantId: string;
  connectedTo: string[]; // IDs of participants this one is connected to
  connectionStats: Map<string, PeerConnectionStats>; // participantId -> stats
  overallQuality: 'excellent' | 'good' | 'fair' | 'poor';
  timestamp: number;
}

/**
 * Statistics for a single peer connection
 * Requirements: 14.5
 */
export interface PeerConnectionStats {
  remoteParticipantId: string;
  rttMs: number;
  packetLossPercent: number;
  jitterMs: number;
  bytesReceived: number;
  bytesSent: number;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
}

/**
 * Monitoring interface for exposing system state
 * Requirements: 14.1, 14.2, 14.5
 */
export interface MonitoringInterface {
  /**
   * Get current topology snapshot
   * Requirements: 14.1, 14.2
   */
  getTopologySnapshot(): TopologySnapshot;

  /**
   * Get relay node assignments and metrics
   * Requirements: 14.1, 14.2
   */
  getRelayNodeAssignments(): RelayNodeAssignment[];

  /**
   * Get connection quality metrics for a specific participant
   * Requirements: 14.5
   */
  getConnectionQuality(participantId: string): ConnectionQualityMetrics | null;

  /**
   * Get connection quality metrics for all participants
   * Requirements: 14.5
   */
  getAllConnectionQuality(): Map<string, ConnectionQualityMetrics>;

  /**
   * Get current conference state
   * Requirements: 14.1, 14.2, 14.5
   */
  getConferenceState(): Conference | null;
}

// ============================================================================
// Monitoring Implementation (Task 17.1, 17.2)
// ============================================================================

/**
 * Implementation of monitoring interface
 * Exposes topology structure, relay assignments, and connection quality
 */
export class Monitor implements MonitoringInterface {
  private conference: Conference | null = null;
  private connectionStatsCache: Map<string, Map<string, PeerConnectionStats>> =
    new Map();

  /**
   * Update the conference state being monitored
   */
  setConference(conference: Conference | null): void {
    this.conference = conference;
  }

  /**
   * Update connection statistics for a participant
   */
  updateConnectionStats(
    participantId: string,
    remoteParticipantId: string,
    stats: PeerConnectionStats
  ): void {
    if (!this.connectionStatsCache.has(participantId)) {
      this.connectionStatsCache.set(participantId, new Map());
    }
    this.connectionStatsCache.get(participantId)!.set(remoteParticipantId, stats);
  }

  /**
   * Get current topology snapshot
   * Requirements: 14.1, 14.2
   */
  getTopologySnapshot(): TopologySnapshot {
    if (!this.conference) {
      throw new Error('No conference available for monitoring');
    }

    return {
      topology: this.conference.topology,
      relayNodeAssignments: this.getRelayNodeAssignments(),
      timestamp: Date.now(),
    };
  }

  /**
   * Get relay node assignments and metrics
   * Requirements: 14.1, 14.2
   */
  getRelayNodeAssignments(): RelayNodeAssignment[] {
    if (!this.conference) {
      return [];
    }

    const assignments: RelayNodeAssignment[] = [];
    const { topology, participants, config } = this.conference;

    for (const group of topology.groups) {
      const relayParticipant = participants.get(group.relayNodeId);
      if (!relayParticipant) continue;

      // Find connected relay nodes (other relays in the mesh)
      const connectedRelayNodes = topology.relayConnections
        .filter(
          ([a, b]) => a === group.relayNodeId || b === group.relayNodeId
        )
        .map(([a, b]) => (a === group.relayNodeId ? b : a));

      assignments.push({
        relayNodeId: group.relayNodeId,
        metrics: relayParticipant.metrics,
        assignedRegularNodes: group.regularNodeIds,
        connectedRelayNodes,
        groupSize: group.regularNodeIds.length,
        loadFactor: group.regularNodeIds.length / config.maxParticipantsPerRelay,
      });
    }

    return assignments;
  }

  /**
   * Get connection quality metrics for a specific participant
   * Requirements: 14.5
   */
  getConnectionQuality(participantId: string): ConnectionQualityMetrics | null {
    if (!this.conference) {
      return null;
    }

    const participant = this.conference.participants.get(participantId);
    if (!participant) {
      return null;
    }

    const connectionStats = this.connectionStatsCache.get(participantId) || new Map();
    const connectedTo = Array.from(participant.connections.keys());

    // Calculate overall quality based on connection stats
    const overallQuality = this.calculateOverallQuality(connectionStats);

    return {
      participantId,
      connectedTo,
      connectionStats,
      overallQuality,
      timestamp: Date.now(),
    };
  }

  /**
   * Get connection quality metrics for all participants
   * Requirements: 14.5
   */
  getAllConnectionQuality(): Map<string, ConnectionQualityMetrics> {
    if (!this.conference) {
      return new Map();
    }

    const allQuality = new Map<string, ConnectionQualityMetrics>();

    for (const participantId of this.conference.participants.keys()) {
      const quality = this.getConnectionQuality(participantId);
      if (quality) {
        allQuality.set(participantId, quality);
      }
    }

    return allQuality;
  }

  /**
   * Get current conference state
   * Requirements: 14.1, 14.2, 14.5
   */
  getConferenceState(): Conference | null {
    return this.conference;
  }

  /**
   * Calculate overall connection quality from stats
   */
  private calculateOverallQuality(
    stats: Map<string, PeerConnectionStats>
  ): 'excellent' | 'good' | 'fair' | 'poor' {
    if (stats.size === 0) {
      return 'poor';
    }

    let totalRtt = 0;
    let totalPacketLoss = 0;
    let totalJitter = 0;
    let disconnectedCount = 0;

    for (const stat of stats.values()) {
      totalRtt += stat.rttMs;
      totalPacketLoss += stat.packetLossPercent;
      totalJitter += stat.jitterMs;

      if (
        stat.connectionState === 'disconnected' ||
        stat.connectionState === 'failed'
      ) {
        disconnectedCount++;
      }
    }

    const avgRtt = totalRtt / stats.size;
    const avgPacketLoss = totalPacketLoss / stats.size;
    const avgJitter = totalJitter / stats.size;
    const disconnectedRatio = disconnectedCount / stats.size;

    // Poor: any disconnections or severe quality issues
    if (disconnectedRatio > 0 || avgPacketLoss > 5 || avgRtt > 300) {
      return 'poor';
    }

    // Fair: moderate quality issues
    if (avgPacketLoss > 2 || avgRtt > 150 || avgJitter > 30) {
      return 'fair';
    }

    // Good: minor quality issues
    if (avgPacketLoss > 0.5 || avgRtt > 50 || avgJitter > 10) {
      return 'good';
    }

    // Excellent: no significant issues
    return 'excellent';
  }
}

/**
 * Global monitor instance
 */
export const monitor = new Monitor();

// ============================================================================
// Event Logging System (Task 17.4)
// ============================================================================

/**
 * Event types for logging
 * Requirements: 14.3, 14.4, 14.6
 */
export enum EventType {
  TOPOLOGY_CHANGE = 'topology-change',
  RELAY_SELECTION = 'relay-selection',
  RELAY_DEMOTION = 'relay-demotion',
  PARTICIPANT_JOIN = 'participant-join',
  PARTICIPANT_LEAVE = 'participant-leave',
  RELAY_FAILURE = 'relay-failure',
  ERROR = 'error',
}

/**
 * Base event interface
 * Requirements: 14.3, 14.4, 14.6
 */
export interface LogEvent {
  type: EventType;
  timestamp: number;
  conferenceId?: string;
  message: string;
  details?: Record<string, any>;
}

/**
 * Topology change event
 * Requirements: 14.3
 */
export interface TopologyChangeEvent extends LogEvent {
  type: EventType.TOPOLOGY_CHANGE;
  reason: 'relay-selection' | 'participant-join' | 'participant-leave' | 'relay-failure';
  previousTopologyVersion: number;
  newTopologyVersion: number;
  affectedParticipants: string[];
}

/**
 * Relay selection event
 * Requirements: 14.4
 */
export interface RelaySelectionEvent extends LogEvent {
  type: EventType.RELAY_SELECTION;
  selectedRelayIds: string[];
  candidateCount: number;
  selectionCriteria: Record<string, any>;
}

/**
 * Relay demotion event
 * Requirements: 14.4
 */
export interface RelayDemotionEvent extends LogEvent {
  type: EventType.RELAY_DEMOTION;
  demotedRelayId: string;
  reason: string;
  metrics: ParticipantMetrics;
}

/**
 * Error event
 * Requirements: 14.6
 */
export interface ErrorEvent extends LogEvent {
  type: EventType.ERROR;
  errorCode?: string;
  errorMessage: string;
  stackTrace?: string;
  context?: Record<string, any>;
}

/**
 * Event logger interface
 * Requirements: 14.3, 14.4, 14.6
 */
export interface EventLogger {
  /**
   * Log a topology change event
   * Requirements: 14.3
   */
  logTopologyChange(event: Omit<TopologyChangeEvent, 'timestamp'>): void;

  /**
   * Log a relay selection event
   * Requirements: 14.4
   */
  logRelaySelection(event: Omit<RelaySelectionEvent, 'timestamp'>): void;

  /**
   * Log a relay demotion event
   * Requirements: 14.4
   */
  logRelayDemotion(event: Omit<RelayDemotionEvent, 'timestamp'>): void;

  /**
   * Log an error event
   * Requirements: 14.6
   */
  logError(event: Omit<ErrorEvent, 'timestamp'>): void;

  /**
   * Log a generic event
   */
  logEvent(event: Omit<LogEvent, 'timestamp'>): void;

  /**
   * Get all logged events
   */
  getEvents(filter?: {
    type?: EventType;
    conferenceId?: string;
    startTime?: number;
    endTime?: number;
  }): LogEvent[];

  /**
   * Clear all logged events
   */
  clearEvents(): void;
}

/**
 * Event logger implementation
 * Requirements: 14.3, 14.4, 14.6
 */
export class Logger implements EventLogger {
  private events: LogEvent[] = [];
  private maxEvents: number = 10000; // Prevent unbounded growth

  /**
   * Log a topology change event
   * Requirements: 14.3
   */
  logTopologyChange(event: Omit<TopologyChangeEvent, 'timestamp'>): void {
    this.addEvent({
      ...event,
      timestamp: Date.now(),
    });
  }

  /**
   * Log a relay selection event
   * Requirements: 14.4
   */
  logRelaySelection(event: Omit<RelaySelectionEvent, 'timestamp'>): void {
    this.addEvent({
      ...event,
      timestamp: Date.now(),
    });
  }

  /**
   * Log a relay demotion event
   * Requirements: 14.4
   */
  logRelayDemotion(event: Omit<RelayDemotionEvent, 'timestamp'>): void {
    this.addEvent({
      ...event,
      timestamp: Date.now(),
    });
  }

  /**
   * Log an error event
   * Requirements: 14.6
   */
  logError(event: Omit<ErrorEvent, 'timestamp'>): void {
    this.addEvent({
      ...event,
      timestamp: Date.now(),
    });

    // Also log to console for immediate visibility
    console.error(
      `[RelayMesh Error] ${event.errorMessage}`,
      event.context || {}
    );
  }

  /**
   * Log a generic event
   */
  logEvent(event: Omit<LogEvent, 'timestamp'>): void {
    this.addEvent({
      ...event,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all logged events with optional filtering
   */
  getEvents(filter?: {
    type?: EventType;
    conferenceId?: string;
    startTime?: number;
    endTime?: number;
  }): LogEvent[] {
    let filtered = this.events;

    if (filter) {
      if (filter.type) {
        filtered = filtered.filter((e) => e.type === filter.type);
      }
      if (filter.conferenceId) {
        filtered = filtered.filter((e) => e.conferenceId === filter.conferenceId);
      }
      if (filter.startTime) {
        filtered = filtered.filter((e) => e.timestamp >= filter.startTime!);
      }
      if (filter.endTime) {
        filtered = filtered.filter((e) => e.timestamp <= filter.endTime!);
      }
    }

    return filtered;
  }

  /**
   * Clear all logged events
   */
  clearEvents(): void {
    this.events = [];
  }

  /**
   * Set maximum number of events to store
   */
  setMaxEvents(max: number): void {
    this.maxEvents = max;
    this.trimEvents();
  }

  /**
   * Add an event to the log
   */
  private addEvent(event: LogEvent): void {
    this.events.push(event);
    this.trimEvents();
  }

  /**
   * Trim events to stay within max limit (FIFO)
   */
  private trimEvents(): void {
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }
}

/**
 * Global logger instance
 */
export const logger = new Logger();
