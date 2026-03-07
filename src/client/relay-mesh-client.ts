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

    // WebRTC signaling handlers
    this.signalingClient.onWebRTCOffer(async (message) => {
      await this.handleWebRTCOffer(message);
    });

    this.signalingClient.onWebRTCAnswer(async (message) => {
      await this.handleWebRTCAnswer(message);
    });

    this.signalingClient.onICECandidate(async (message) => {
      await this.handleICECandidate(message);
    });
  }

  async joinConference(conferenceId: string): Promise<ConferenceInfo> {
    // Transition to joining state
    const participantId = this.generateParticipantId();
    await this.stateMachine.startJoin(conferenceId, participantId);

    try {
      // Update signaling client with actual participant ID
      this.signalingClient['config'].participantId = participantId;
      
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

      // Set up ICE candidate handler
      this.mediaHandler.onICECandidate((remoteParticipantId, candidate) => {
        this.signalingClient.sendICECandidate(remoteParticipantId, candidate);
      });

      // Connect to signaling server
      await this.signalingClient.connect();

      // Initialize local media
      await this.mediaHandler.initializeLocalMedia({
        audio: true,
        video: true,
      });

      // Send join message (register with server first)
      await this.signalingClient.sendJoin(conferenceId, participantId, this.config.participantName);

      // Start metrics collection (after registration)
      await this.metricsCollector.startCollection();

      // Wait for topology assignment and state transition to CONNECTED
      await this.waitForState(ConferenceState.CONNECTED, 10000);

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

  private waitForState(targetState: ConferenceState, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if already in target state
      if (this.stateMachine.getCurrentState() === targetState) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        this.stateMachine.offStateChange(handler);
        reject(new Error(`Timeout waiting for state ${targetState}`));
      }, timeoutMs);

      const handler = (event: any) => {
        if (event.to === targetState) {
          clearTimeout(timeout);
          this.stateMachine.offStateChange(handler);
          resolve();
        }
      };

      this.stateMachine.onStateChange(handler);
    });
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

  /**
   * Get the local media stream
   *
   * @returns The local media stream or null if not initialized
   */
  getLocalStream(): globalThis.MediaStream | null {
    return this.mediaHandler?.getLocalStream() || null;
  }


  private async handleStateTransition(from: ConferenceState, to: ConferenceState): Promise<void> {
    if (to === ConferenceState.CONNECTED && this.metricsCollector) {
      // Immediately broadcast current metrics if available
      try {
        const currentMetrics = this.metricsCollector.getCurrentMetrics();
        console.log('[RelayMeshClient] Broadcasting metrics on CONNECTED:', currentMetrics.participantId);
        this.signalingClient.broadcastMetrics(currentMetrics);
      } catch (error) {
        console.warn('[RelayMeshClient] Metrics not ready yet, will broadcast on next collection');
      }
      
      // Start periodic metrics updates
      const interval = this.config.selectionConfig?.reevaluationIntervalMs || 30000;
      this.metricsUpdateInterval = setInterval(() => {
        if (this.metricsCollector) {
          try {
            const metrics = this.metricsCollector.getCurrentMetrics();
            this.signalingClient.broadcastMetrics(metrics);
          } catch (error) {
            // Metrics not ready yet, skip this broadcast
          }
        }
      }, interval);
    }
  }

  private handleLocalMetricsUpdate(metrics: ParticipantMetrics): void {
    const participantId = this.stateMachine.getParticipantId();
    if (participantId) {
      this.allMetrics.set(participantId, metrics);
      
      // Broadcast metrics immediately to other participants
      if (this.stateMachine.getCurrentState() === ConferenceState.CONNECTED) {
        this.signalingClient.broadcastMetrics(metrics);
      }
      
      this.evaluateTopology();
    }
  }

  private async handleSignalingMessage(message: SignalingMessage): Promise<void> {
    switch (message.type) {
      case 'join-response':
        await this.handleJoinResponse(message as any);
        break;
      case 'topology-update':
        await this.handleTopologyUpdate(message as TopologyUpdateMessage);
        break;
      case 'metrics-broadcast':
        this.handleMetricsBroadcast(message as MetricsBroadcastMessage);
        break;
      case 'relay-assignment':
        await this.handleRelayAssignment(message as RelayAssignmentMessage);
        break;
      case 'participant-left':
        this.handleParticipantLeft(message as any);
        break;
      case 'participant-joined':
        this.handleParticipantJoined(message as any);
        break;
      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'ice-candidate':
        // Forward to media handler
        this.emit('webrtcSignaling', message);
        break;
    }
  }

  private async handleJoinResponse(message: any): Promise<void> {
    // Handle initial topology from join response
    // Topology might be null for the first participant
    this.currentTopology = message.topology;
    if (message.topology) {
      this.emit('topologyUpdate', message.topology);
    }

    // Handle existing participants information
    if (message.existingParticipants && Array.isArray(message.existingParticipants)) {
      console.log('[RelayMeshClient] Received existing participants:', message.existingParticipants);
      for (const participant of message.existingParticipants) {
        console.log('[RelayMeshClient] Emitting participantJoined for existing participant:', participant);
        this.emit('participantJoined', {
          participantId: participant.participantId,
          participantName: participant.participantName,
        });
      }
    } else {
      console.log('[RelayMeshClient] No existing participants in join-response');
    }

    // Immediately add our own participant to allMetrics so count is correct
    // This will be replaced with actual metrics once collection starts
    const participantId = this.stateMachine.getParticipantId();
    if (participantId && !this.allMetrics.has(participantId)) {
      // Add placeholder metrics for ourselves
      this.allMetrics.set(participantId, {
        participantId,
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 0, downloadMbps: 0, measurementConfidence: 0 },
        natType: 0, // NATType.OPEN
        latency: { averageRttMs: 0, minRttMs: 0, maxRttMs: 0, measurements: new Map() },
        stability: { packetLossPercent: 0, jitterMs: 0, connectionUptime: 0, reconnectionCount: 0 },
        device: { cpuUsagePercent: 0, availableMemoryMB: 0, supportedCodecs: [], hardwareAcceleration: false },
      });
      console.log('[RelayMeshClient] Added self to allMetrics on join');
    }

    // Complete the join transition
    if (this.stateMachine.getCurrentState() === ConferenceState.JOINING) {
      await this.stateMachine.completeJoin();
    }

    // Update connections based on topology (if topology exists)
    if (message.topology) {
      await this.updateConnections();
    }
  }

  private async handleTopologyUpdate(message: TopologyUpdateMessage): Promise<void> {
    console.log('[RelayMeshClient] Received topology update:', message.topology);
    console.log('[RelayMeshClient] Topology groups:', message.topology.groups);
    console.log('[RelayMeshClient] Topology relay nodes:', message.topology.relayNodes);
    
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
    console.log('[RelayMeshClient] Received metrics broadcast from:', message.from);
    this.allMetrics.set(message.from, message.metrics);
    this.evaluateTopology();
  }

  private handleParticipantLeft(message: any): void {
    const participantId = message.participantId;
    console.log('[RelayMeshClient] Participant left:', participantId);
    
    // Remove from metrics
    this.allMetrics.delete(participantId);
    
    // Emit event for UI
    this.emit('participantLeft', participantId);
    
    // Re-evaluate topology
    this.evaluateTopology();
  }

  private handleParticipantJoined(message: any): void {
    const participantId = message.participantId;
    console.log('[RelayMeshClient] Participant joined:', participantId);
    
    // Immediately broadcast our metrics to the new participant
    if (this.metricsCollector && this.stateMachine.getCurrentState() === ConferenceState.CONNECTED) {
      try {
        const currentMetrics = this.metricsCollector.getCurrentMetrics();
        console.log('[RelayMeshClient] Broadcasting metrics to new participant');
        this.signalingClient.broadcastMetrics(currentMetrics);
      } catch (error) {
        // Metrics not ready yet
        console.log('[RelayMeshClient] Metrics not ready to broadcast to new participant');
      }
    }
    
    // Emit event for UI
    this.emit('participantJoined', { participantId, participantName: message.participantName });
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
    console.log('[RelayMeshClient] evaluateTopology called, state:', this.stateMachine.getCurrentState());
    
    if (this.stateMachine.getCurrentState() !== ConferenceState.CONNECTED) {
      console.log('[RelayMeshClient] Not evaluating topology - not connected');
      return;
    }

    console.log('[RelayMeshClient] All metrics:', Array.from(this.allMetrics.keys()));
    
    // Run selection algorithm
    const config = this.buildSelectionConfig();
    const relayNodeIds = this.selectionAlgorithm.selectRelayNodes(this.allMetrics, config);
    
    console.log('[RelayMeshClient] Selected relay nodes:', relayNodeIds);

    // Check if topology needs update
    const currentRelayIds = this.currentTopology?.relayNodes || [];
    const relayNodesChanged = !this.arraysEqual(relayNodeIds, currentRelayIds);
    
    // Also check if we have multiple participants but no topology groups (need P2P connections)
    const hasMultipleParticipants = this.allMetrics.size > 1;
    const currentGroups = this.currentTopology?.groups || [];
    const hasGroups = currentGroups.length > 0;
    const needsInitialTopology = hasMultipleParticipants && !hasGroups;
    
    const needsUpdate = relayNodesChanged || needsInitialTopology;
    
    console.log('[RelayMeshClient] Relay nodes changed:', relayNodesChanged);
    console.log('[RelayMeshClient] Needs initial topology:', needsInitialTopology);
    console.log('[RelayMeshClient] Needs topology update:', needsUpdate);

    if (needsUpdate) {
      // Form new topology
      const latencyMap = this.buildLatencyMap();
      const allParticipants = Array.from(this.allMetrics.keys());
      
      console.log('[RelayMeshClient] Forming topology with participants:', allParticipants);
      
      const newTopology = this.topologyManager.formTopology(
        relayNodeIds,
        allParticipants,
        latencyMap
      );
      
      console.log('[RelayMeshClient] New topology formed:', newTopology);

      // Broadcast topology update via signaling
      this.signalingClient.sendTopologyUpdate(newTopology, 'relay-selection');
    }
  }

  private async updateConnections(): Promise<void> {
    console.log('[RelayMeshClient] updateConnections called');
    console.log('[RelayMeshClient] Current topology:', this.currentTopology);
    console.log('[RelayMeshClient] Media handler exists:', !!this.mediaHandler);
    
    if (!this.currentTopology || !this.mediaHandler) {
      console.log('[RelayMeshClient] Skipping updateConnections - missing topology or media handler');
      return;
    }

    const participantId = this.stateMachine.getParticipantId();
    if (!participantId) {
      console.log('[RelayMeshClient] Skipping updateConnections - no participant ID');
      return;
    }

    console.log('[RelayMeshClient] Participant ID:', participantId);

    // Get local stream
    const localStream = this.mediaHandler.getLocalStream();
    if (!localStream) {
      console.log('[RelayMeshClient] Skipping updateConnections - no local stream');
      return;
    }

    // Determine which participants we should be connected to
    const targetConnections = this.getTargetConnections(participantId);
    
    console.log('[RelayMeshClient] Target connections:', targetConnections);

    // Close connections that are no longer needed
    const currentConnections = this.mediaHandler.getActiveConnections();
    
    console.log('[RelayMeshClient] Current connections:', currentConnections);
    for (const remoteId of currentConnections) {
      if (!targetConnections.includes(remoteId)) {
        this.mediaHandler.closePeerConnection(remoteId);
      }
    }

    // Establish new connections and add local stream
    const peerConfig = this.buildPeerConnectionConfig();
    for (const remoteId of targetConnections) {
      if (!currentConnections.includes(remoteId)) {
        console.log('[RelayMeshClient] Creating peer connection to:', remoteId);
        const peerConnection = await this.mediaHandler.createPeerConnection(remoteId, peerConfig);
        
        // Add local stream to the peer connection
        console.log('[RelayMeshClient] Adding local stream to peer connection:', remoteId);
        this.mediaHandler.addLocalStream(peerConnection, {
          streamId: localStream.id,
          participantId: participantId,
          tracks: localStream.getTracks(),
          isLocal: true,
        });

        // Initiate WebRTC offer
        console.log('[RelayMeshClient] Creating WebRTC offer for:', remoteId);
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        this.signalingClient.sendWebRTCOffer(remoteId, offer);
        console.log('[RelayMeshClient] Sent WebRTC offer to:', remoteId);
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

    // Special case: P2P mode (no relay nodes)
    if (this.currentTopology.relayNodes.length === 0) {
      // In P2P mode, connect to all other participants in the group
      const group = this.currentTopology.groups.find((g) =>
        g.relayNodeId === participantId || g.regularNodeIds.includes(participantId)
      );
      
      if (group) {
        // Connect to all other participants in the group (full mesh)
        const allInGroup = [group.relayNodeId, ...group.regularNodeIds];
        return allInGroup.filter((id) => id !== participantId);
      }
      
      return [];
    }

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

  /**
   * Handle incoming WebRTC offer
   */
  private async handleWebRTCOffer(message: any): Promise<void> {
    if (!this.mediaHandler) {
      console.error('[RelayMeshClient] Cannot handle offer - no media handler');
      return;
    }

    console.log('[RelayMeshClient] Received WebRTC offer from:', message.from);

    try {
      // Get or create peer connection
      const peerConfig = this.buildPeerConnectionConfig();
      const peerConnection = await this.mediaHandler.createPeerConnection(message.from, peerConfig);

      // Add local stream if not already added
      const localStream = this.mediaHandler.getLocalStream();
      if (localStream) {
        const tracks = localStream.getTracks();
        const senders = peerConnection.getSenders();
        
        // Only add tracks if they haven't been added yet
        if (senders.length === 0) {
          const participantId = this.stateMachine.getParticipantId();
          this.mediaHandler.addLocalStream(peerConnection, {
            streamId: localStream.id,
            participantId: participantId || '',
            tracks: tracks,
            isLocal: true,
          });
        }
      }

      // Set remote description (the offer)
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));

      // Create and send answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      // Send answer back
      this.signalingClient.sendWebRTCAnswer(message.from, answer);

      console.log('[RelayMeshClient] Sent WebRTC answer to:', message.from);
    } catch (error) {
      console.error('[RelayMeshClient] Error handling WebRTC offer:', error);
    }
  }

  /**
   * Handle incoming WebRTC answer
   */
  private async handleWebRTCAnswer(message: any): Promise<void> {
    if (!this.mediaHandler) {
      console.error('[RelayMeshClient] Cannot handle answer - no media handler');
      return;
    }

    console.log('[RelayMeshClient] Received WebRTC answer from:', message.from);

    try {
      const peerConnections = this.mediaHandler.getPeerConnections();
      const peerConnection = peerConnections.get(message.from);

      if (!peerConnection) {
        console.error('[RelayMeshClient] No peer connection found for:', message.from);
        return;
      }

      // Set remote description (the answer)
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));

      console.log('[RelayMeshClient] Set remote description from answer:', message.from);
    } catch (error) {
      console.error('[RelayMeshClient] Error handling WebRTC answer:', error);
    }
  }

  /**
   * Handle incoming ICE candidate
   */
  private async handleICECandidate(message: any): Promise<void> {
    if (!this.mediaHandler) {
      console.error('[RelayMeshClient] Cannot handle ICE candidate - no media handler');
      return;
    }

    console.log('[RelayMeshClient] Received ICE candidate from:', message.from);

    try {
      const peerConnections = this.mediaHandler.getPeerConnections();
      const peerConnection = peerConnections.get(message.from);

      if (!peerConnection) {
        console.error('[RelayMeshClient] No peer connection found for:', message.from);
        return;
      }

      // Add ICE candidate
      await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));

      console.log('[RelayMeshClient] Added ICE candidate from:', message.from);
    } catch (error) {
      console.error('[RelayMeshClient] Error handling ICE candidate:', error);
    }
  }

  private generateParticipantId(): string {
    // Use a combination of timestamp, random string, and a counter for uniqueness
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    const counter = Math.floor(Math.random() * 10000);
    return `participant-${timestamp}-${random}-${counter}`;
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((val, idx) => val === sortedB[idx]);
  }
}
