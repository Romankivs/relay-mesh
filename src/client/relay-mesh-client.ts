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
  private lastTopologyRelayIds: string[] = [];
  private lastTopologyMetricsSnapshot: Map<string, {
    uploadMbps: number;
    downloadMbps: number;
    natType: number;
    latency: number;
    packetLoss: number;
    jitter: number;
    uptime: number;
    cpuUsage: number;
  }> = new Map();
  private makingOffer: Map<string, boolean> = new Map(); // Track ongoing offer creation per peer
  private forwardedStreamIds: Set<string> = new Set(); // Track streams we're already forwarding

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
        console.log('[RelayMeshClient] ========================================');
        console.log('[RelayMeshClient] REMOTE STREAM RECEIVED');
        console.log('[RelayMeshClient] From participant:', stream.participantId);
        console.log('[RelayMeshClient] Stream ID:', stream.streamId);
        console.log('[RelayMeshClient] Current role:', this.currentRole);
        console.log('[RelayMeshClient] Tracks:', stream.tracks.map(t => `${t.kind} (${t.id})`));
        console.log('[RelayMeshClient] ========================================');
        
        // ALWAYS emit the remote stream event so the UI can display it
        // This is critical - relays need to display streams they receive, not just forward them
        this.emit('remoteStream', stream);
        
        // If we're a relay node, check if this is a new stream we need to forward
        if (this.currentRole === 'relay' && this.mediaHandler && this.currentTopology) {
          const participantId = this.stateMachine.getParticipantId();
          if (!participantId) return;
          
          // Create a unique identifier for this stream
          const streamKey = `${stream.participantId}-${stream.streamId}`;
          
          // Only trigger reconnection if this is a NEW stream we haven't seen before
          if (!this.forwardedStreamIds.has(streamKey)) {
            console.log('[RelayMeshClient] Relay received new stream, checking if forwarding is needed');
            this.forwardedStreamIds.add(streamKey);
            
            // Check if we have peers to forward to
            const connectedPeers = this.mediaHandler.getConnectedPeers();
            const myGroup = this.currentTopology.groups.find(g => g.relayNodeId === participantId);
            const hasGroupMembers = myGroup && myGroup.regularNodeIds.length > 0;
            const hasOtherRelays = this.currentTopology.relayNodes.filter(id => id !== participantId).length > 0;
            
            // Count total peers (group members + other relays)
            const totalPeers = (myGroup?.regularNodeIds.length || 0) + (this.currentTopology.relayNodes.length - 1);
            
            console.log('[RelayMeshClient] Forwarding check:');
            console.log('[RelayMeshClient]   - Total peers:', totalPeers);
            console.log('[RelayMeshClient]   - Connected peers:', connectedPeers.length);
            console.log('[RelayMeshClient]   - Group members:', myGroup?.regularNodeIds.length || 0);
            console.log('[RelayMeshClient]   - Other relays:', this.currentTopology.relayNodes.length - 1);
            
            // Only recreate connections if we have multiple peers to forward to
            // In 2-person conference (1 relay + 1 regular): totalPeers = 1, no forwarding needed
            // In 3+ person conference: totalPeers >= 2, forwarding needed
            if (connectedPeers.length > 0 && totalPeers > 1 && (hasGroupMembers || hasOtherRelays)) {
              console.log('[RelayMeshClient] ✓ Relay will recreate connections to forward stream');
              // Trigger connection update which will recreate connections with all streams
              setTimeout(() => {
                if (this.currentRole === 'relay') {
                  this.updateConnections();
                }
              }, 500); // Small delay to ensure stream is fully received
            } else {
              console.log('[RelayMeshClient] ✗ Relay will NOT recreate connections - no forwarding needed (2-person conference)');
            }
          } else {
            console.log('[RelayMeshClient] Stream already seen, skipping forwarding check');
          }
        }
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
      // Clear forwarded streams tracking
      this.forwardedStreamIds.clear();
      
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

      // Determine role from current topology
      let role: 'relay' | 'regular' = 'regular';
      if (this.currentTopology && this.currentTopology.relayNodes.includes(participantId)) {
        role = 'relay';
      }

      return {
        conferenceId,
        participantId,
        participantCount: this.allMetrics.size,
        role,
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
        // If the new metrics have 0 bandwidth and we already have placeholder metrics with non-zero bandwidth,
        // preserve the placeholder bandwidth values until real measurements are available
        const existingMetrics = this.allMetrics.get(participantId);
        if (existingMetrics && 
            metrics.bandwidth.uploadMbps === 0 && 
            metrics.bandwidth.downloadMbps === 0 &&
            existingMetrics.bandwidth.uploadMbps > 0) {
          metrics = {
            ...metrics,
            bandwidth: existingMetrics.bandwidth
          };
        }

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
        
        // Add placeholder metrics for existing participants
        // These will be replaced when we receive their metrics broadcasts
        if (!this.allMetrics.has(participant.participantId)) {
          this.allMetrics.set(participant.participantId, {
            participantId: participant.participantId,
            timestamp: Date.now(),
            bandwidth: { uploadMbps: 5.0, downloadMbps: 10.0, measurementConfidence: 0.1 },
            natType: 0, // NATType.OPEN
            latency: { averageRttMs: 50, minRttMs: 50, maxRttMs: 50, measurements: new Map() },
            stability: { packetLossPercent: 0, jitterMs: 0, connectionUptime: 0, reconnectionCount: 0 },
            device: { cpuUsagePercent: 0, availableMemoryMB: 0, supportedCodecs: [], hardwareAcceleration: false },
          });
          console.log('[RelayMeshClient] Added placeholder metrics for existing participant:', participant.participantId);
        }
      }
    } else {
      console.log('[RelayMeshClient] No existing participants in join-response');
    }

    // Immediately add our own participant to allMetrics so count is correct
    // This will be replaced with actual metrics once collection starts
    const participantId = this.stateMachine.getParticipantId();
    if (participantId && !this.allMetrics.has(participantId)) {
      // Add placeholder metrics for ourselves with reasonable defaults
      // Using conservative bandwidth values (5 Mbps upload, 10 Mbps download)
      // to ensure participants are eligible for relay selection until real metrics arrive
      this.allMetrics.set(participantId, {
        participantId,
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 5.0, downloadMbps: 10.0, measurementConfidence: 0.1 },
        natType: 0, // NATType.OPEN
        latency: { averageRttMs: 50, minRttMs: 50, maxRttMs: 50, measurements: new Map() },
        stability: { packetLossPercent: 0, jitterMs: 0, connectionUptime: 0, reconnectionCount: 0 },
        device: { cpuUsagePercent: 0, availableMemoryMB: 0, supportedCodecs: [], hardwareAcceleration: false },
      });
      console.log('[RelayMeshClient] Added self to allMetrics on join with default bandwidth values');
    }

    // Complete the join transition
    if (this.stateMachine.getCurrentState() === ConferenceState.JOINING) {
      await this.stateMachine.completeJoin();
    }

    // Update connections based on topology (if topology exists)
    if (message.topology) {
      await this.updateConnections();
    }
    
    // Schedule a delayed update of relay selection data after connections stabilize
    // This gives time for metrics collection to start and initial broadcasts to occur
    setTimeout(() => {
      if (this.stateMachine.getCurrentState() === ConferenceState.CONNECTED) {
        console.log('[RelayMeshClient] Delayed relay selection data update after join');
        this.updateRelaySelectionData();
      }
    }, 2000); // 2 second delay to allow metrics to be collected and broadcast
  }

  private async handleTopologyUpdate(message: TopologyUpdateMessage): Promise<void> {
    console.log('[RelayMeshClient] Received topology update:', message.topology);
    console.log('[RelayMeshClient] Topology groups:', message.topology.groups);
    console.log('[RelayMeshClient] Topology relay nodes:', message.topology.relayNodes);
    console.log('[RelayMeshClient] Topology version:', message.topology.version, 'timestamp:', message.topology.timestamp);
    
    // Only accept topology updates that are newer than our current topology
    // This prevents race conditions when multiple clients broadcast topology updates
    if (this.currentTopology) {
      const currentVersion = this.currentTopology.version;
      const currentTimestamp = this.currentTopology.timestamp;
      const newVersion = message.topology.version;
      const newTimestamp = message.topology.timestamp;
      
      // Compare by version first, then by timestamp as tiebreaker
      const isNewer = newVersion > currentVersion || 
                     (newVersion === currentVersion && newTimestamp > currentTimestamp);
      
      if (!isNewer) {
        console.log('[RelayMeshClient] Ignoring older/duplicate topology update');
        return;
      }
      
      console.log('[RelayMeshClient] Accepting newer topology update');
    }
    
    // Check if our role changed
    const participantId = this.stateMachine.getParticipantId();
    const oldRole = this.currentTopology && participantId && this.currentTopology.relayNodes.includes(participantId) ? 'relay' : 'regular';
    const newRole = participantId && message.topology.relayNodes.includes(participantId) ? 'relay' : 'regular';
    
    this.currentTopology = message.topology;
    this.emit('topologyUpdate', message.topology);
    
    // Emit role change event if role changed
    if (oldRole !== newRole) {
      console.log('[RelayMeshClient] Role changed from', oldRole, 'to', newRole);
      this.currentRole = newRole;
      
      // Clear forwarded streams tracking when role changes
      this.forwardedStreamIds.clear();
      
      this.emit('roleChange', newRole);
      
      // Handle relay engine
      if (newRole === 'relay' && !this.relayEngine) {
        this.relayEngine = new RelayEngine();
        this.relayEngine.startRelay();
      } else if (newRole === 'regular' && this.relayEngine) {
        this.relayEngine.stopRelay();
        this.relayEngine = null;
      }
      
      // CRITICAL: When role changes, close ALL existing connections
      // This ensures connections are recreated with the correct topology
      // For example, when transitioning from relay to regular, we need to
      // disconnect from other relays and connect only to our assigned relay
      if (this.mediaHandler) {
        console.log('[RelayMeshClient] Role changed - closing all connections to recreate with new topology');
        const currentConnections = this.mediaHandler.getActiveConnections();
        for (const remoteId of currentConnections) {
          this.mediaHandler.closePeerConnection(remoteId);
        }
      }
    }

    // If we were joining, complete the join
    if (this.stateMachine.getCurrentState() === ConferenceState.JOINING) {
      await this.stateMachine.completeJoin();
    }

    // Update connections based on new topology
    await this.updateConnections();
  }

  private handleMetricsBroadcast(message: MetricsBroadcastMessage): void {
      console.log('[RelayMeshClient] Received metrics broadcast from:', message.from);

      // If the received metrics have 0 bandwidth and we already have placeholder metrics with non-zero bandwidth,
      // preserve the placeholder bandwidth values until real measurements are available
      const existingMetrics = this.allMetrics.get(message.from);
      let metrics = message.metrics;

      if (existingMetrics && 
          metrics.bandwidth.uploadMbps === 0 && 
          metrics.bandwidth.downloadMbps === 0 &&
          existingMetrics.bandwidth.uploadMbps > 0) {
        metrics = {
          ...metrics,
          bandwidth: existingMetrics.bandwidth
        };
      }

      this.allMetrics.set(message.from, metrics);

      // Evaluate topology - this will update relay selection data and trigger
      // topology changes only if needed (e.g., when relay nodes change)
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
    
    // Add placeholder metrics for the new participant
    // These will be replaced when we receive their metrics broadcasts
    if (!this.allMetrics.has(participantId)) {
      this.allMetrics.set(participantId, {
        participantId: participantId,
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 5.0, downloadMbps: 10.0, measurementConfidence: 0.1 },
        natType: 0, // NATType.OPEN
        latency: { averageRttMs: 50, minRttMs: 50, maxRttMs: 50, measurements: new Map() },
        stability: { packetLossPercent: 0, jitterMs: 0, connectionUptime: 0, reconnectionCount: 0 },
        device: { cpuUsagePercent: 0, availableMemoryMB: 0, supportedCodecs: [], hardwareAcceleration: false },
      });
      console.log('[RelayMeshClient] Added placeholder metrics for new participant:', participantId);
      
      // Schedule a delayed update of relay selection data
      setTimeout(() => {
        if (this.stateMachine.getCurrentState() === ConferenceState.CONNECTED) {
          console.log('[RelayMeshClient] Delayed relay selection data update after participant joined');
          this.updateRelaySelectionData();
        }
      }, 1000); // 1 second delay
    }
    
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

  private async evaluateTopology(): Promise<void> {
    try {
      await this.evaluateTopologyInternal();
    } catch (error) {
      console.error('[RelayMeshClient] Error evaluating topology:', error);
    }
  }

  private async evaluateTopologyInternal(): Promise<void> {
    if (this.stateMachine.getCurrentState() !== ConferenceState.CONNECTED) {
      return;
    }

    // Run selection algorithm
    const config = this.buildSelectionConfig();
    const result = this.selectionAlgorithm.selectRelayNodes(this.allMetrics, config);
    const relayNodeIds = result.selectedIds;

    // Send relay selection data to server for monitoring
    const conferenceId = this.stateMachine.getConferenceId();
    if (this.signalingClient && conferenceId) {
      this.signalingClient.sendRelaySelectionData(conferenceId, result.selectionData);
    }

    // Check if topology needs update
    const currentRelayIds = this.currentTopology?.relayNodes || [];
    // Sort both arrays before comparison to avoid false positives from different ordering
    const relayNodesChanged = !this.arraysEqual(relayNodeIds, currentRelayIds);
    
    console.log('[RelayMeshClient] Relay comparison - new:', [...relayNodeIds].sort(), 'current:', [...currentRelayIds].sort(), 'changed:', relayNodesChanged);
    
    // Check for participant count changes (new/deleted users)
    const participantCountChanged = this.allMetrics.size !== this.lastTopologyMetricsSnapshot.size;
    
    // If relay nodes haven't changed and participant count is the same, check for metric changes
    if (!relayNodesChanged && !participantCountChanged) {
      // Check if metrics have changed significantly
      const metricsChangedSignificantly = this.hasSignificantMetricChange(0.3); // 30% threshold
      
      if (!metricsChangedSignificantly) {
        console.log('[RelayMeshClient] Topology unchanged - same relays, same participants, no significant metric changes');
        return;
      }
    }
    
    // If we get here, something changed - form new topology and check if it's actually different
    if (relayNodesChanged || participantCountChanged) {
      console.log('[RelayMeshClient] Topology update needed - relay nodes changed:', relayNodesChanged, 'participant count changed:', participantCountChanged);
      
      // Leader election: Only the participant with the lowest ID broadcasts topology updates
      // This prevents race conditions when multiple clients try to update topology simultaneously
      const participantId = this.stateMachine.getParticipantId();
      const allParticipantIds = Array.from(this.allMetrics.keys()).sort();
      const leaderId = allParticipantIds[0];
      
      if (participantId !== leaderId) {
        console.log('[RelayMeshClient] Not the leader (leader is', leaderId, '), skipping topology broadcast');
        // Non-leaders still evaluate topology for monitoring, but don't broadcast
        return;
      }
      
      console.log('[RelayMeshClient] We are the leader, forming new topology');
      
      // Form new topology
      const latencyMap = this.buildLatencyMap();
      const allParticipants = Array.from(this.allMetrics.keys());
      
      const newTopology = this.topologyManager.formTopology(
        relayNodeIds,
        allParticipants,
        latencyMap
      );
      
      console.log('[RelayMeshClient] New topology formed:', newTopology);

      // Check if topology actually changed (compare groups, not just relay IDs)
      if (this.topologyEquals(this.currentTopology, newTopology)) {
        console.log('[RelayMeshClient] Topology unchanged - suppressing broadcast');
        // Update snapshot to prevent repeated checks
        this.lastTopologyRelayIds = [...relayNodeIds].sort();
        this.snapshotMetrics();
        return;
      }

      // Broadcast topology update via signaling
      console.log('[RelayMeshClient] Broadcasting topology update');
      this.signalingClient.sendTopologyUpdate(newTopology, 'relay-selection');
      
      // Update our local topology immediately (we won't receive our own broadcast)
      const oldRole = this.currentTopology && participantId && this.currentTopology.relayNodes.includes(participantId) ? 'relay' : 'regular';
      const newRole = participantId && newTopology.relayNodes.includes(participantId) ? 'relay' : 'regular';
      
      this.currentTopology = newTopology;
      this.emit('topologyUpdate', newTopology);
      
      // Emit role change event if role changed
      if (oldRole !== newRole) {
        console.log('[RelayMeshClient] Role changed from', oldRole, 'to', newRole);
        this.currentRole = newRole;
        this.emit('roleChange', newRole);
        
        // Handle relay engine
        if (newRole === 'relay' && !this.relayEngine) {
          this.relayEngine = new RelayEngine();
          this.relayEngine.startRelay();
        } else if (newRole === 'regular' && this.relayEngine) {
          this.relayEngine.stopRelay();
          this.relayEngine = null;
        }
        
        // CRITICAL: When role changes, close ALL existing connections
        // This ensures connections are recreated with the correct topology
        // For example, when transitioning from relay to regular, we need to
        // disconnect from other relays and connect only to our assigned relay
        if (this.mediaHandler) {
          console.log('[RelayMeshClient] Role changed - closing all connections to recreate with new topology');
          const currentConnections = this.mediaHandler.getActiveConnections();
          for (const remoteId of currentConnections) {
            this.mediaHandler.closePeerConnection(remoteId);
          }
        }
      }
      
      // Update connections based on new topology
      await this.updateConnections();
      
      // Remember this topology and metrics snapshot to detect oscillation
      this.lastTopologyRelayIds = [...relayNodeIds].sort();
      this.snapshotMetrics();
    } else {
      console.log('[RelayMeshClient] Topology unchanged - no significant changes detected');
    }
  }

  /**
   * Check if metrics have changed significantly since last topology update
   * Checks all metrics: bandwidth, NAT type, latency, packet loss, jitter, uptime, CPU
   * Uses conservative thresholds to prevent topology thrashing
   * @param threshold - Base percentage threshold (0.3 = 30%)
   * @returns true if any participant's metrics have changed by more than threshold
   */
  private hasSignificantMetricChange(threshold: number): boolean {
    for (const [participantId, metrics] of this.allMetrics) {
      const lastMetrics = this.lastTopologyMetricsSnapshot.get(participantId);
      if (!lastMetrics) {
        // New participant
        return true;
      }
      
      // Check upload bandwidth change (30% relative threshold)
      const uploadChange = Math.abs(metrics.bandwidth.uploadMbps - lastMetrics.uploadMbps) / 
                          Math.max(lastMetrics.uploadMbps, 0.1);
      if (uploadChange > threshold) {
        console.log('[RelayMeshClient] Significant upload bandwidth change for', participantId, ':', 
                   lastMetrics.uploadMbps, '->', metrics.bandwidth.uploadMbps, 
                   '(', (uploadChange * 100).toFixed(1), '%)');
        return true;
      }
      
      // Check download bandwidth change (30% relative threshold)
      const downloadChange = Math.abs(metrics.bandwidth.downloadMbps - lastMetrics.downloadMbps) / 
                            Math.max(lastMetrics.downloadMbps, 0.1);
      if (downloadChange > threshold) {
        console.log('[RelayMeshClient] Significant download bandwidth change for', participantId, ':', 
                   lastMetrics.downloadMbps, '->', metrics.bandwidth.downloadMbps, 
                   '(', (downloadChange * 100).toFixed(1), '%)');
        return true;
      }
      
      // Check NAT type change (any change is significant)
      if (metrics.natType !== lastMetrics.natType) {
        console.log('[RelayMeshClient] NAT type changed for', participantId, ':', 
                   lastMetrics.natType, '->', metrics.natType);
        return true;
      }
      
      // Check latency change (absolute change > 60ms or relative change > 30%)
      const latencyAbsChange = Math.abs(metrics.latency.averageRttMs - lastMetrics.latency);
      const latencyRelChange = latencyAbsChange / Math.max(lastMetrics.latency, 10);
      if (latencyAbsChange > 60 || latencyRelChange > threshold) {
        console.log('[RelayMeshClient] Significant latency change for', participantId, ':', 
                   lastMetrics.latency, '->', metrics.latency.averageRttMs, 'ms',
                   '(', (latencyRelChange * 100).toFixed(1), '%)');
        return true;
      }
      
      // Check packet loss change (absolute change > 5% or relative change > 30%)
      const packetLossAbsChange = Math.abs(metrics.stability.packetLossPercent - lastMetrics.packetLoss);
      const packetLossRelChange = packetLossAbsChange / Math.max(lastMetrics.packetLoss, 0.1);
      if (packetLossAbsChange > 5 || packetLossRelChange > threshold) {
        console.log('[RelayMeshClient] Significant packet loss change for', participantId, ':', 
                   lastMetrics.packetLoss, '->', metrics.stability.packetLossPercent, '%',
                   '(', (packetLossRelChange * 100).toFixed(1), '%)');
        return true;
      }
      
      // Check jitter change (absolute change > 30ms or relative change > 30%)
      const jitterAbsChange = Math.abs(metrics.stability.jitterMs - lastMetrics.jitter);
      const jitterRelChange = jitterAbsChange / Math.max(lastMetrics.jitter, 1);
      if (jitterAbsChange > 30 || jitterRelChange > threshold) {
        console.log('[RelayMeshClient] Significant jitter change for', participantId, ':', 
                   lastMetrics.jitter, '->', metrics.stability.jitterMs, 'ms',
                   '(', (jitterRelChange * 100).toFixed(1), '%)');
        return true;
      }
      
      // Check CPU usage change (absolute change > 25% or relative change > 40%)
      // Higher thresholds for CPU since it fluctuates frequently
      const cpuAbsChange = Math.abs(metrics.device.cpuUsagePercent - lastMetrics.cpuUsage);
      const cpuRelChange = cpuAbsChange / Math.max(lastMetrics.cpuUsage, 1);
      // TODO: Look into this
      // if (cpuAbsChange > 50 || cpuRelChange > 0.8) {
      //   console.log('[RelayMeshClient] Significant CPU usage change for', participantId, ':', 
      //              lastMetrics.cpuUsage, '->', metrics.device.cpuUsagePercent, '%',
      //              '(', (cpuRelChange * 100).toFixed(1), '%)');
      //   return true;
      // }
      
      // Note: Connection uptime always increases, so we don't check it for changes
      // Note: Reconnection count increase would be caught by other metrics degrading
    }
    
    // Check for deleted participants
    for (const participantId of this.lastTopologyMetricsSnapshot.keys()) {
      if (!this.allMetrics.has(participantId)) {
        console.log('[RelayMeshClient] Participant left:', participantId);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Snapshot current metrics for comparison
   */
  private snapshotMetrics(): void {
    this.lastTopologyMetricsSnapshot.clear();
    for (const [participantId, metrics] of this.allMetrics) {
      this.lastTopologyMetricsSnapshot.set(participantId, {
        uploadMbps: metrics.bandwidth.uploadMbps,
        downloadMbps: metrics.bandwidth.downloadMbps,
        natType: metrics.natType,
        latency: metrics.latency.averageRttMs,
        packetLoss: metrics.stability.packetLossPercent,
        jitter: metrics.stability.jitterMs,
        uptime: metrics.stability.connectionUptime,
        cpuUsage: metrics.device.cpuUsagePercent,
      });
    }
  }
  /**
   * Update relay selection data for monitoring without triggering topology changes
   * This is useful when we want to refresh the monitoring dashboard data
   * without disrupting existing connections
   */
  private updateRelaySelectionData(): void {
      if (this.stateMachine.getCurrentState() !== ConferenceState.CONNECTED) {
        return;
      }

      // Run selection algorithm to get current selection data
      const config = this.buildSelectionConfig();
      const result = this.selectionAlgorithm.selectRelayNodes(this.allMetrics, config);

      // Send relay selection data to server for monitoring
      const conferenceId = this.stateMachine.getConferenceId();
      if (this.signalingClient && conferenceId) {
        this.signalingClient.sendRelaySelectionData(conferenceId, result.selectionData);
      }
    }
  /**
   * Forward a newly received stream to all connected peers (relay forwarding)
   * Called when a relay node receives a new remote stream
   *
   * @param stream - The new remote stream to forward
   */
  /**
     * Forward a newly received stream to all connected peers (relay forwarding)
     * Called when a relay node receives a new remote stream
     * 
     * @param stream - The new remote stream to forward
     */
    /**
       * Forward a newly received stream to all connected peers (relay forwarding)
       * Called when a relay node receives a new remote stream
       * 
       * @param stream - The new remote stream to forward
       */
      private forwardNewStreamToConnectedPeers(stream: import('./media-handler').MediaStream): void {
        if (!this.mediaHandler) {
          return;
        }

        const remoteStreams = this.mediaHandler.getRemoteStreams();
        const sourceStream = remoteStreams.get(stream.participantId);

        if (!sourceStream) {
          console.warn(`[RelayMeshClient] Cannot forward stream - source stream not found for ${stream.participantId}`);
          return;
        }

        const connectedPeers = this.mediaHandler.getConnectedPeers();
        console.log(`[RelayMeshClient] Forwarding new stream from ${stream.participantId} to ${connectedPeers.length} connected peers`);

        for (const peerId of connectedPeers) {
          // Don't forward a stream back to its source
          if (peerId !== stream.participantId) {
            const peerConnection = this.mediaHandler.getPeerConnection(peerId);
            if (peerConnection) {
              console.log(`[RelayMeshClient] Adding tracks from ${stream.participantId} to connection with ${peerId}`);
              this.mediaHandler.addRemoteStreamForRelay(peerConnection, sourceStream);

              // Renegotiate the connection to add the new tracks
              this.renegotiateConnection(peerId, peerConnection);
            }
          }
        }
      }

  /**
   * Renegotiate a peer connection (create new offer after adding tracks)
   *
   * @param peerId - The peer to renegotiate with
   * @param peerConnection - The peer connection to renegotiate
   */
  /**
     * Renegotiate a peer connection (create new offer after adding tracks)
     * 
     * @param peerId - The peer to renegotiate with
     * @param peerConnection - The peer connection to renegotiate
     */
    private async renegotiateConnection(peerId: string, peerConnection: RTCPeerConnection): Promise<void> {
      if (!this.signalingClient) {
        return;
      }

      try {
        console.log(`[RelayMeshClient] Renegotiating connection with ${peerId}`);
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        this.signalingClient.sendWebRTCOffer(peerId, offer);
      } catch (error) {
        console.error(`[RelayMeshClient] Failed to renegotiate connection with ${peerId}:`, error);
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
    console.log('[RelayMeshClient] All metrics participants:', Array.from(this.allMetrics.keys()));

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
    
    // For relay nodes with remote streams, only recreate if we have peers to forward to
    const remoteStreams = this.mediaHandler.getRemoteStreams();
    const shouldRecreateForForwarding = this.currentRole === 'relay' && remoteStreams.size > 0;
    
    if (shouldRecreateForForwarding) {
      // Check if we actually have peers to forward to (beyond the sources of our streams)
      const myGroup = this.currentTopology.groups.find(g => g.relayNodeId === participantId);
      const hasGroupMembers = myGroup && myGroup.regularNodeIds.length > 0;
      // In a 2-relay scenario, each relay forwards to the other relay
      const hasOtherRelays = this.currentTopology.relayNodes.length >= 2;
      
      // Count total peers (group members + other relays)
      const totalPeers = (myGroup?.regularNodeIds.length || 0) + (this.currentTopology.relayNodes.length - 1);
      
      // Only recreate if we have multiple peers (need at least 2: one source, one destination)
      // IMPORTANT: In a 2-relay scenario, we need to forward even if we have no group members
      // because the other relay might have group members whose streams we need to forward
      // 
      // Examples:
      // - 2-person (1 relay + 1 regular): totalPeers = 1, no forwarding
      // - 3-person (2 relays, one with 1 member, one with 0): totalPeers = 1 BUT hasOtherRelays = true, so forward
      // - 3-person (1 relay + 2 regulars): totalPeers = 2, forward
      const shouldForward = (totalPeers > 1 || hasOtherRelays) && (hasGroupMembers || hasOtherRelays);
      
      if (shouldForward) {
        console.log(`[RelayMeshClient] Relay has ${remoteStreams.size} remote streams and peers to forward to, recreating all connections`);
        
        // Emit event to notify UI to clear stream cache
        this.emit('connectionsRecreating');
        
        for (const remoteId of currentConnections) {
          if (targetConnections.includes(remoteId)) {
            console.log('[RelayMeshClient] Closing connection to recreate with forwarded streams:', remoteId);
            this.mediaHandler.closePeerConnection(remoteId);
          }
        }
        // Clear current connections list since we're recreating all
        currentConnections.length = 0;
      } else {
        console.log(`[RelayMeshClient] Relay has ${remoteStreams.size} remote streams but no peers to forward to, keeping connections`);
      }
    } else {
      // Normal case: only close connections no longer needed
      for (const remoteId of currentConnections) {
        if (!targetConnections.includes(remoteId)) {
          console.log('[RelayMeshClient] Closing connection to:', remoteId);
          this.mediaHandler.closePeerConnection(remoteId);
        }
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

        // If we're a relay node, also forward all remote streams to this peer
        if (this.currentRole === 'relay') {
          const remoteStreams = this.mediaHandler.getRemoteStreams();
          console.log(`[RelayMeshClient] Relay mode: forwarding ${remoteStreams.size} remote streams to ${remoteId}`);
          
          for (const [sourceParticipantId, remoteStream] of remoteStreams.entries()) {
            // Don't forward a stream back to its source
            if (sourceParticipantId !== remoteId) {
              console.log(`[RelayMeshClient] Forwarding stream from ${sourceParticipantId} to ${remoteId}`);
              this.mediaHandler.addRemoteStreamForRelay(peerConnection, remoteStream);
            }
          }
        }

        // Initiate WebRTC offer
        console.log('[RelayMeshClient] Creating WebRTC offer for:', remoteId);
        this.makingOffer.set(remoteId, true);
        try {
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          this.signalingClient.sendWebRTCOffer(remoteId, offer);
          console.log('[RelayMeshClient] Sent WebRTC offer to:', remoteId);
        } catch (error) {
          console.error('[RelayMeshClient] Error creating offer for:', remoteId, error);
          this.makingOffer.set(remoteId, false);
        }
        // Note: makingOffer flag is cleared when we receive an answer or handle a collision
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
    
    console.log('[RelayMeshClient] getTargetConnections for:', participantId);
    console.log('[RelayMeshClient] Is relay:', isRelay);
    console.log('[RelayMeshClient] Topology groups:', JSON.stringify(this.currentTopology.groups, null, 2));

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
      
      console.log('[RelayMeshClient] Relay connections - other relays:', otherRelays, 'group members:', groupMembers);
      
      return [...otherRelays, ...groupMembers];
    } else {
      // Regular nodes connect only to their assigned relay
      const group = this.currentTopology.groups.find((g) =>
        g.regularNodeIds.includes(participantId)
      );
      
      console.log('[RelayMeshClient] Regular node - assigned group:', group);
      
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
      minBandwidthMbps: 0.1, // Lowered for development - allows selection even with minimal bandwidth
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
        // Handle case where measurements might be a plain object (from JSON serialization)
        // or a Map (from local creation)
        const measurements = metrics.latency.measurements;
        if (measurements instanceof Map) {
          latencyMap.set(participantId, measurements);
        } else if (measurements && typeof measurements === 'object') {
          // Convert plain object to Map
          const map = new Map<string, number>();
          for (const [key, value] of Object.entries(measurements)) {
            if (typeof value === 'number') {
              map.set(key, value);
            }
          }
          latencyMap.set(participantId, map);
        } else {
          // No measurements, use empty Map
          latencyMap.set(participantId, new Map());
        }
      }

      return latencyMap;
    }

  /**
   * Handle incoming WebRTC offer using Perfect Negotiation pattern
   */
  private async handleWebRTCOffer(message: any): Promise<void> {
    if (!this.mediaHandler) {
      console.error('[RelayMeshClient] Cannot handle offer - no media handler');
      return;
    }

    console.log('[RelayMeshClient] Received WebRTC offer from:', message.from);

    try {
      const peerConnections = this.mediaHandler.getPeerConnections();
      let peerConnection = peerConnections.get(message.from);
      
      const myId = this.stateMachine.getParticipantId() || '';
      const theirId = message.from;
      
      // Perfect negotiation: determine politeness based on ID comparison
      const polite = myId > theirId;
      
      // Get or create peer connection
      if (!peerConnection) {
        const peerConfig = this.buildPeerConnectionConfig();
        peerConnection = await this.mediaHandler.createPeerConnection(message.from, peerConfig);
      }

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

      // Perfect negotiation: handle offer collision
      const offerCollision = peerConnection.signalingState !== 'stable' || this.makingOffer.get(message.from);
      
      const ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) {
        console.log('[RelayMeshClient] Impolite peer ignoring offer due to collision');
        return;
      }

      // Polite peer: rollback local offer if there's a collision
      if (polite && offerCollision) {
        console.log('[RelayMeshClient] Polite peer rolling back local offer due to collision');
        await peerConnection.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
        this.makingOffer.set(message.from, false); // Clear the flag after rollback
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

      // Check if we're in the right state to accept an answer
      if (peerConnection.signalingState !== 'have-local-offer') {
        console.log('[RelayMeshClient] Ignoring answer - not in have-local-offer state (current:', peerConnection.signalingState, ')');
        return;
      }

      // Set remote description (the answer)
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));

      console.log('[RelayMeshClient] Set remote description from answer:', message.from);
      
      // Clear the makingOffer flag now that negotiation is complete
      this.makingOffer.set(message.from, false);
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

  /**
   * Compare two topologies for equality
   * Checks relay nodes and group assignments
   */
  private topologyEquals(a: ConnectionTopology | null, b: ConnectionTopology): boolean {
    if (!a) return false;
    
    // Compare relay nodes
    if (!this.arraysEqual(a.relayNodes, b.relayNodes)) {
      return false;
    }
    
    // Compare groups
    if (a.groups.length !== b.groups.length) {
      return false;
    }
    
    // Sort groups by relay ID for consistent comparison
    const sortedGroupsA = [...a.groups].sort((x, y) => x.relayNodeId.localeCompare(y.relayNodeId));
    const sortedGroupsB = [...b.groups].sort((x, y) => x.relayNodeId.localeCompare(y.relayNodeId));
    
    for (let i = 0; i < sortedGroupsA.length; i++) {
      const groupA = sortedGroupsA[i];
      const groupB = sortedGroupsB[i];
      
      if (groupA.relayNodeId !== groupB.relayNodeId) {
        return false;
      }
      
      if (!this.arraysEqual(groupA.regularNodeIds, groupB.regularNodeIds)) {
        return false;
      }
    }
    
    return true;
  }
}
