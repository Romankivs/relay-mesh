// Main client application entry point for RelayMesh
import { EventEmitter } from 'events';
import { MetricsCollector } from './metrics-collector';
import { SelectionAlgorithm } from './selection-algorithm';
import { TopologyManager } from './topology-manager';
import { MediaHandler } from './media-handler';
import { RelayEngine } from './relay-engine';
import { SignalingClient } from './signaling-client';
import { ConferenceStateMachineImpl, ConferenceState } from './conference-state-machine';
import type {
  ParticipantMetrics,
  ConnectionTopology,
  SelectionConfig,
  PeerConnectionConfig,
  SignalingMessage,
  TopologyUpdateMessage,
  MetricsBroadcastMessage,
  RelayAssignmentMessage,
} from '../shared/types';

export interface RelayMeshClientConfig {
  signalingServerUrl: string;
  participantName: string;
  selectionConfig?: Partial<SelectionConfig>;
  peerConnectionConfig?: Partial<PeerConnectionConfig>;
  enforceSecureConnection?: boolean; // For testing only - default: true
}

export interface ConferenceInfo {
  conferenceId: string;
  participantId: string;
  participantCount: number;
  role: 'relay' | 'regular';
}

export class RelayMeshClient extends EventEmitter {
  private metricsCollector: MetricsCollector | null = null;
  private selectionAlgorithm: SelectionAlgorithm;
  private topologyManager: TopologyManager;
  private mediaHandler: MediaHandler | null = null;
  private relayEngine: RelayEngine | null = null;
  private signalingClient: SignalingClient;
  private stateMachine: ConferenceStateMachineImpl;

  private config: RelayMeshClientConfig;
  private currentTopology: ConnectionTopology | null = null;
  private allMetrics: Map<string, ParticipantMetrics> = new Map();
  private currentRole: 'relay' | 'regular' = 'regular';
  private metricsUpdateInterval: NodeJS.Timeout | null = null;

  constructor(config: RelayMeshClientConfig) {
    super();
    this.config = config;

    // Initialize components that don't need participant ID
    this.selectionAlgorithm = new SelectionAlgorithm();
    this.topologyManager = new TopologyManager();
    // MetricsCollector and MediaHandler will be initialized on join with actual participant ID
    this.signalingClient = new SignalingClient({
      serverUrl: config.signalingServerUrl,
      participantId: 'temp-id', // Will be updated on join
      participantName: config.participantName,
      enforceSecureConnection: config.enforceSecureConnection,
    });
    this.stateMachine = new ConferenceStateMachineImpl();

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // State machine events
    this.stateMachine.onStateChange((event) => {
      this.emit('stateChange', event);
      this.handleStateTransition(event.from, event.to);
    });

    // Signaling client events
    this.signalingClient.on('message', (message: SignalingMessage) => {
      this.handleSignalingMessage(message);
    });

    this.signalingClient.on('connected', () => {
      this.emit('signalingConnected');
    });

    this.signalingClient.on('disconnected', () => {
      this.emit('signalingDisconnected');
    });
  }

  async joinConference(conferenceId: string): Promise<ConferenceInfo> {
    // Transition to joining state
    const participantId = this.generateParticipantId();
    await this.stateMachine.startJoin(conferenceId, participantId);

    try {
      // Initialize metrics collector with actual participant ID
      this.metricsCollector = new MetricsCollector({ participantId });
      
      // Set up metrics collector events
      this.metricsCollector.onMetricsUpdate((metrics) => {
        this.handleLocalMetricsUpdate(metrics);
      });

      // Initialize media handler with actual participant ID
      this.mediaHandler = new MediaHandler(participantId);
      
      // Set up media handler events
      this.mediaHandler.onRemoteStream((stream) => {
        this.emit('remoteStream', stream);
      });

      // Connect to signaling server
      await this.signalingClient.connect();

      // Start metrics collection
      await this.metricsCollector.startCollection();

      // Initialize local media
      await this.mediaHandler.initializeLocalMedia({
        audio: true,
        video: true,
      });

      // Send join message
      await this.signalingClient.sendJoin(conferenceId);

      // Wait for topology assignment (handled in signaling message handler)
      // The completeJoin will be called when topology is received

      return {
        conferenceId,
        participantId,
        participantCount: this.currentTopology?.relayNodes.length || 0,
        role: this.currentRole,
      };
    } catch (error) {
      // Rollback to idle on error
      await this.stateMachine.completeLeave();
      throw error;
    }
  }

  async leaveConference(): Promise<void> {
    if (this.stateMachine.getCurrentState() !== ConferenceState.CONNECTED) {
      throw new Error('Not currently in a conference');
    }

    await this.stateMachine.startLeave();

    try {
      // Stop relay engine if active
      if (this.relayEngine) {
        this.relayEngine.stopRelay();
        this.relayEngine = null;
      }

      // Close all peer connections
      if (this.mediaHandler) {
        this.mediaHandler.closeAllConnections();
      }

      // Stop metrics collection
      if (this.metricsCollector) {
        this.metricsCollector.stopCollection();
      }

      if (this.metricsUpdateInterval) {
        clearInterval(this.metricsUpdateInterval);
        this.metricsUpdateInterval = null;
      }

      // Send leave message
      const participantId = this.stateMachine.getParticipantId();
      if (participantId) {
        await this.signalingClient.sendLeave(participantId);
      }

      // Disconnect from signaling
      this.signalingClient.disconnect();

      // Clear state
      this.currentTopology = null;
      this.allMetrics.clear();
      this.currentRole = 'regular';
      this.mediaHandler = null;
      this.metricsCollector = null;

      await this.stateMachine.completeLeave();
    } catch (error) {
      // Force cleanup even on error
      await this.stateMachine.completeLeave();
      throw error;
    }
  }

  getCurrentState(): ConferenceState {
    return this.stateMachine.getCurrentState();
  }

  getConferenceInfo(): ConferenceInfo | null {
    const conferenceId = this.stateMachine.getConferenceId();
    const participantId = this.stateMachine.getParticipantId();

    if (!conferenceId || !participantId) {
      return null;
    }

    return {
      conferenceId,
      participantId,
      participantCount: this.allMetrics.size,
      role: this.currentRole,
    };
  }

  private async handleStateTransition(from: ConferenceState, to: ConferenceState): Promise<void> {
    if (to === ConferenceState.CONNECTED && this.metricsCollector) {
      // Start periodic metrics updates
      const interval = this.config.selectionConfig?.reevaluationIntervalMs || 30000;
      this.metricsUpdateInterval = setInterval(() => {
        if (this.metricsCollector) {
          const metrics = this.metricsCollector.getCurrentMetrics();
          this.signalingClient.broadcastMetrics(metrics);
        }
      }, interval);
    }
  }

  private handleLocalMetricsUpdate(metrics: ParticipantMetrics): void {
    const participantId = this.stateMachine.getParticipantId();
    if (participantId) {
      this.allMetrics.set(participantId, metrics);
      this.evaluateTopology();
    }
  }

  private async handleSignalingMessage(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case 'topology-update':
        await this.handleTopologyUpdate(message as TopologyUpdateMessage);
        break;
      case 'metrics-broadcast':
        this.handleMetricsBroadcast(message as MetricsBroadcastMessage);
        break;
      case 'relay-assignment':
        await this.handleRelayAssignment(message as RelayAssignmentMessage);
        break;
      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'ice-candidate':
        // Forward to media handler
        this.emit('webrtcSignaling', message);
        break;
    }
  }

  private async handleTopologyUpdate(message: TopologyUpdateMessage): Promise<void> {
    this.currentTopology = message.topology;
    this.emit('topologyUpdate', message.topology);

    // If we were joining, complete the join
    if (this.stateMachine.getCurrentState() === ConferenceState.JOINING) {
      await this.stateMachine.completeJoin();
    }

    // Update connections based on new topology
    await this.updateConnections();
  }

  private handleMetricsBroadcast(message: MetricsBroadcastMessage): void {
    this.allMetrics.set(message.from, message.metrics);
    this.evaluateTopology();
  }

  private async handleRelayAssignment(message: RelayAssignmentMessage): Promise<void> {
    this.currentRole = message.role;
    this.emit('roleChange', message.role);

    if (message.role === 'relay') {
      // Initialize relay engine
      this.relayEngine = new RelayEngine();
      this.relayEngine.startRelay();
    } else if (this.relayEngine) {
      // Stop relay engine if we were demoted
      this.relayEngine.stopRelay();
      this.relayEngine = null;
    }
  }

  private evaluateTopology(): void {
    if (this.stateMachine.getCurrentState() !== ConferenceState.CONNECTED) {
      return;
    }

    // Run selection algorithm
    const config = this.buildSelectionConfig();
    const relayNodeIds = this.selectionAlgorithm.selectRelayNodes(this.allMetrics, config);

    // Check if topology needs update
    const currentRelayIds = this.currentTopology?.relayNodes || [];
    const needsUpdate = !this.arraysEqual(relayNodeIds, currentRelayIds);

    if (needsUpdate) {
      // Form new topology
      const latencyMap = this.buildLatencyMap();
      const allParticipants = Array.from(this.allMetrics.keys());
      const newTopology = this.topologyManager.formTopology(
        relayNodeIds,
        allParticipants,
        latencyMap
      );

      // Broadcast topology update via signaling
      this.signalingClient.sendTopologyUpdate(newTopology, 'relay-selection');
    }
  }

  private async updateConnections(): Promise<void> {
    if (!this.currentTopology || !this.mediaHandler) {
      return;
    }

    const participantId = this.stateMachine.getParticipantId();
    if (!participantId) {
      return;
    }

    // Determine which participants we should be connected to
    const targetConnections = this.getTargetConnections(participantId);

    // Close connections that are no longer needed
    const currentConnections = this.mediaHandler.getActiveConnections();
    for (const remoteId of currentConnections) {
      if (!targetConnections.includes(remoteId)) {
        this.mediaHandler.closePeerConnection(remoteId);
      }
    }

    // Establish new connections
    const peerConfig = this.buildPeerConnectionConfig();
    for (const remoteId of targetConnections) {
      if (!currentConnections.includes(remoteId)) {
        await this.mediaHandler.createPeerConnection(remoteId, peerConfig);
      }
    }

    // Configure relay routes if we're a relay node
    if (this.currentRole === 'relay' && this.relayEngine) {
      const group = this.currentTopology.groups.find((g) => g.relayNodeId === participantId);
      if (group) {
        const otherRelays = this.currentTopology.relayNodes.filter((id) => id !== participantId);
        this.relayEngine.configureRoutes(
          group.regularNodeIds,
          otherRelays,
          otherRelays,
          group.regularNodeIds
        );
      }
    }
  }

  private getTargetConnections(participantId: string): string[] {
    if (!this.currentTopology) {
      return [];
    }

    const isRelay = this.currentTopology.relayNodes.includes(participantId);

    if (isRelay) {
      // Relay nodes connect to all other relays and their group members
      const otherRelays = this.currentTopology.relayNodes.filter((id) => id !== participantId);
      const group = this.currentTopology.groups.find((g) => g.relayNodeId === participantId);
      const groupMembers = group?.regularNodeIds || [];
      return [...otherRelays, ...groupMembers];
    } else {
      // Regular nodes connect only to their assigned relay
      const group = this.currentTopology.groups.find((g) =>
        g.regularNodeIds.includes(participantId)
      );
      return group ? [group.relayNodeId] : [];
    }
  }

  private buildSelectionConfig(): SelectionConfig {
    return {
      bandwidthWeight: 0.3,
      natWeight: 0.25,
      latencyWeight: 0.2,
      stabilityWeight: 0.15,
      deviceWeight: 0.1,
      minBandwidthMbps: 5,
      maxParticipantsPerRelay: 5,
      reevaluationIntervalMs: 30000,
      ...this.config.selectionConfig,
    };
  }

  private buildPeerConnectionConfig(): PeerConnectionConfig {
    return {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
      iceTransportPolicy: 'all',
      ...this.config.peerConnectionConfig,
    };
  }

  private buildLatencyMap(): Map<string, Map<string, number>> {
    const latencyMap = new Map<string, Map<string, number>>();

    for (const [participantId, metrics] of this.allMetrics) {
      latencyMap.set(participantId, metrics.latency.measurements);
    }

    return latencyMap;
  }

  private generateParticipantId(): string {
    return `participant-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((val, idx) => val === sortedB[idx]);
  }
}
