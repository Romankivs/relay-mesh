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
  bandwidthTestDurationMs?: number; // For testing only - reduces startup time
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
  private statsPollingInterval: NodeJS.Timeout | null = null;
  // For bandwidth calculation from RTCStats deltas
  private lastStatsSnapshot: { bytesSent: number; bytesReceived: number; timestamp: number } | null = null;
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
  private forwardedStreamIds: Map<string, string> = new Map(); // participantId → sourcePeer: track which source peer we last forwarded from per participant
  private isRecreatingConnections: boolean = false; // Prevent infinite loop when recreating connections
  private pendingIceCandidates: Map<string, RTCIceCandidateInit[]> = new Map(); // Queue ICE candidates until remote description is set
  private streamMapRefreshInterval: NodeJS.Timeout | null = null; // Periodic stream map refresh for relay nodes
  private lastSentStreamMaps: Map<string, string> = new Map(); // Dedup: last JSON sent per peer
  // Peers for which onnegotiationneeded should be suppressed (updateConnections is still setting up)
  private suppressNegotiationFor: Set<string> = new Set();
  // Short ID for log prefixing — set once participantId is known
  private logId: string = '?';

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
    // Set short log ID for easy identification in multi-tab scenarios
    this.logId = participantId.slice(-8);
    await this.stateMachine.startJoin(conferenceId, participantId);

    try {
      // Update signaling client with actual participant ID
      this.signalingClient['config'].participantId = participantId;
      
      // Initialize metrics collector with actual participant ID
      this.metricsCollector = new MetricsCollector({
        participantId,
        ...(this.config.bandwidthTestDurationMs !== undefined && {
          bandwidthTestDurationMs: this.config.bandwidthTestDurationMs,
        }),
      });
      
      // Set up metrics collector events
      this.metricsCollector.onMetricsUpdate((metrics) => {
        this.handleLocalMetricsUpdate(metrics);
      });

      // Initialize media handler with actual participant ID
      this.mediaHandler = new MediaHandler(participantId);
      
      // Set up media handler events
      this.mediaHandler.onRemoteStream((stream) => {
        console.log(`[RMC:${this.logId}] remoteStream from=${stream.participantId.slice(-8)} stream=${stream.streamId.slice(0,8)} role=${this.currentRole}`);
        
        // ALWAYS emit the remote stream event so the UI can display it
        // This is critical - relays need to display streams they receive, not just forward them
        this.emit('remoteStream', stream);
        
        // If we're a relay node, check if this is a new stream we need to forward
        if (this.currentRole === 'relay' && this.mediaHandler && this.currentTopology) {
          const participantId = this.stateMachine.getParticipantId();
          if (!participantId) return;
          
          // Key by participantId only — once we've forwarded a participant's stream,
          // don't re-forward when the other relay sends a new synthetic stream ID
          // for the same participant (which happens on every renegotiation).
          const streamKey = `${stream.participantId}-${stream.streamId}`;
          
          console.log(`[RMC:${this.logId}][onRemoteStream] received stream from ${stream.participantId.slice(-8)} streamId=${stream.streamId.slice(0,8)} alreadyForwarded=${this.forwardedStreamIds.has(stream.participantId)}`);
          
          // Only trigger reconnection if this is a NEW participant stream we haven't forwarded
          if (!this.forwardedStreamIds.has(stream.participantId)) {
            console.log(`[RMC:${this.logId}][onRemoteStream] NEW stream from ${stream.participantId.slice(-8)}, forwarding`);
            // Store current sourcePeer (may be '' if relay-stream-map not yet received; streamResolved will update)
            const currentSourcePeer = this.mediaHandler.getStreamSourcePeer(stream.participantId) ?? '';
            this.forwardedStreamIds.set(stream.participantId, currentSourcePeer);
            
            const connectedPeers = this.mediaHandler.getConnectedPeers();
            const myGroup = this.currentTopology.groups.find(g => g.relayNodeId === participantId);
            const hasGroupMembers = myGroup && myGroup.regularNodeIds.length > 0;
            const hasOtherRelays = this.currentTopology.relayNodes.filter(id => id !== participantId).length > 0;
            const totalPeers = (myGroup?.regularNodeIds.length || 0) + (this.currentTopology.relayNodes.length - 1);
            const shouldForward = (totalPeers > 1 || hasOtherRelays) && (hasGroupMembers || hasOtherRelays);
            
            console.log(`[RMC:${this.logId}][onRemoteStream] connectedPeers=${connectedPeers.length} hasGroupMembers=${hasGroupMembers} hasOtherRelays=${hasOtherRelays} shouldForward=${shouldForward}`);
            
            if (connectedPeers.length > 0 && shouldForward) {
              this.forwardNewStreamToConnectedPeers(stream);
            } else {
              console.log(`[RMC:${this.logId}][onRemoteStream] NOT forwarding: peers=${connectedPeers.length} shouldForward=${shouldForward}`);
            }
          } else {
            console.log(`[RMC:${this.logId}][onRemoteStream] ${stream.participantId.slice(-8)} already forwarded, skipping`);
          }
        }
      });

      // Set up ICE candidate handler
      this.mediaHandler.onICECandidate((remoteParticipantId, candidate) => {
        this.signalingClient.sendICECandidate(remoteParticipantId, candidate);
      });

      // When the browser fires onnegotiationneeded (e.g. after addTrack for relay forwarding),
      // create a new offer so the remote peer learns about the new tracks.
      this.mediaHandler.onNegotiationNeeded((peerId, pc) => {
        if (this.currentRole === 'relay') {
          if (this.suppressNegotiationFor.has(peerId)) {
            console.log(`[RMC:${this.logId}][negotiationNeeded] suppressed for ${peerId.slice(-8)} (updateConnections in progress)`);
            return;
          }
          const senders = pc.getSenders();
          console.log(`[RMC:${this.logId}][negotiationNeeded] triggered for ${peerId.slice(-8)} signalingState=${pc.signalingState} senders=${senders.length} tracks=[${senders.map(s => s.track?.kind ?? 'null').join(', ')}]`);
          this.renegotiateConnection(peerId, pc);
        }
      });

      // When a relay-stream-map reveals a participant we don't know about yet,
      // emit participantJoined so the UI can register their name/display.
      this.mediaHandler.onUnknownParticipant((unknownId) => {
        if (!this.allMetrics.has(unknownId)) {
          console.log(`[RMC:${this.logId}] Discovered unknown participant via relay-stream-map: ${unknownId}`);
          this.allMetrics.set(unknownId, {
            participantId: unknownId,
            timestamp: Date.now(),
            bandwidth: { uploadMbps: 5.0, downloadMbps: 10.0, measurementConfidence: 0.1 },
            natType: 0,
            latency: { averageRttMs: 50, minRttMs: 50, maxRttMs: 50, measurements: new Map() },
            stability: { packetLossPercent: 0, jitterMs: 0, connectionUptime: 0, reconnectionCount: 0 },
            device: { cpuUsagePercent: 0, availableMemoryMB: 0, supportedCodecs: [], hardwareAcceleration: false },
          });
          this.emit('participantJoined', { participantId: unknownId, participantName: undefined });
        }
      });

      // When a stream resolves (pending→attributed), relay nodes:
      // 1. Forward the stream tracks to all connected peers (if not already forwarded)
      // 2. Send updated stream maps so peers can re-attribute already-emitted streams
      this.mediaHandler.onStreamResolved((resolvedParticipantId, resolvedStream) => {
        if (this.currentRole !== 'relay' || !this.mediaHandler) return;
        const myId = this.stateMachine.getParticipantId();
        if (!myId) return;

        const connectedPeers = this.mediaHandler.getConnectedPeers();
        console.log(`[RMC:${this.logId}][streamResolved] ${resolvedParticipantId.slice(-8)} resolved streamId=${resolvedStream.id.slice(0,8)}, forwarding+mapping to ${connectedPeers.length} peers: [${connectedPeers.map(p => p.slice(-8)).join(', ')}]`);

        // Check if we've already forwarded this participant's stream from the same source peer.
        // If the source peer changed (participant reconnected via different relay), re-forward.
        // Get the peer we received this stream from (to avoid forwarding back to source)
        const sourcePeer = this.mediaHandler.getStreamSourcePeer(resolvedParticipantId);
        const lastForwardedSourcePeer = this.forwardedStreamIds.get(resolvedParticipantId);
        const alreadyForwarded = lastForwardedSourcePeer !== undefined && lastForwardedSourcePeer === sourcePeer;
        console.log(`[RMC:${this.logId}][streamResolved] alreadyForwarded=${alreadyForwarded} lastSourcePeer=${lastForwardedSourcePeer?.slice(-8) ?? 'none'} currentSourcePeer=${sourcePeer?.slice(-8) ?? 'unknown'}`);

        console.log(`[RMC:${this.logId}][streamResolved] sourcePeer for ${resolvedParticipantId.slice(-8)} is ${sourcePeer?.slice(-8) ?? 'unknown'}`);

        for (const peerId of connectedPeers) {
          if (peerId === resolvedParticipantId) {
            console.log(`[RMC:${this.logId}][streamResolved] skipping source peer ${peerId.slice(-8)} (stream owner)`);
            continue;
          }

          // Don't forward back to the peer we received this stream from
          if (sourcePeer && peerId === sourcePeer) {
            console.log(`[RMC:${this.logId}][streamResolved] skipping source peer ${peerId.slice(-8)} (received from this peer)`);
            continue;
          }

          const pc = this.mediaHandler.getPeerConnection(peerId);
          if (!pc) {
            console.warn(`[RMC:${this.logId}][streamResolved] no PC for ${peerId.slice(-8)}`);
            continue;
          }

          // Forward tracks if not already done
          if (!alreadyForwarded) {
            console.log(`[RMC:${this.logId}][streamResolved] forwarding tracks of ${resolvedParticipantId.slice(-8)} to ${peerId.slice(-8)}`);
            // Don't send stream map in callback - it will be sent after renegotiation completes in handleWebRTCAnswer
            this.mediaHandler.addRemoteStreamForRelay(pc, resolvedStream, resolvedParticipantId);
            // onnegotiationneeded will fire and trigger renegotiation
          } else {
            // Already forwarded — just send updated stream map
            const streamMap = this.buildStreamMapForPeer(peerId);
            if (Object.keys(streamMap).length > 0) {
              console.log(`[RMC:${this.logId}][streamResolved] sending updated map to ${peerId.slice(-8)}:`, streamMap);
              this.mediaHandler.sendRelayStreamMap(peerId, pc, streamMap);
            }
          }
        }

        // Mark as forwarded (participantId → sourcePeer) so we can detect source peer changes
        if (!alreadyForwarded) {
          this.forwardedStreamIds.set(resolvedParticipantId, sourcePeer ?? '');
          console.log(`[RMC:${this.logId}][streamResolved] marked ${resolvedParticipantId.slice(-8)} as forwarded from sourcePeer=${sourcePeer?.slice(-8) ?? 'unknown'}`);
        }
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

      // Poll RTCStats from active peer connections every 2s to feed real latency/stability data
      this.statsPollingInterval = setInterval(async () => {
        if (!this.metricsCollector || !this.mediaHandler) return;
        const peerConnections = this.mediaHandler.getPeerConnections();
        if (peerConnections.size === 0) return;

        let totalBytesSent = 0;
        let totalBytesReceived = 0;
        let maxAvailableUploadBps = 0;
        let maxAvailableDownloadBps = 0;

        for (const [peerId, pc] of peerConnections) {
          if (pc.connectionState !== 'connected') continue;
          try {
            const stats = await pc.getStats();
            // Feed stability metrics (packet loss, jitter)
            this.metricsCollector.updateStability(stats);
            // Feed latency and accumulate bytes for bandwidth
            stats.forEach((report: any) => {
              if (report.type === 'remote-inbound-rtp' && typeof report.roundTripTime === 'number') {
                this.metricsCollector!.updateLatency(peerId, report.roundTripTime * 1000);
              }
              if (report.type === 'candidate-pair' && report.state === 'succeeded' &&
                  typeof report.currentRoundTripTime === 'number') {
                this.metricsCollector!.updateLatency(peerId, report.currentRoundTripTime * 1000);
              }
              if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                // Collect available bitrate estimates (channel capacity, not current usage)
                if (typeof report.availableOutgoingBitrate === 'number' && report.availableOutgoingBitrate > 0) {
                  maxAvailableUploadBps = Math.max(maxAvailableUploadBps, report.availableOutgoingBitrate);
                }
                if (typeof report.availableIncomingBitrate === 'number' && report.availableIncomingBitrate > 0) {
                  maxAvailableDownloadBps = Math.max(maxAvailableDownloadBps, report.availableIncomingBitrate);
                }
              }
              if (report.type === 'outbound-rtp' && typeof report.bytesSent === 'number') {
                totalBytesSent += report.bytesSent;
              }
              if (report.type === 'inbound-rtp' && typeof report.bytesReceived === 'number') {
                totalBytesReceived += report.bytesReceived;
              }
            });
          } catch {
            // ignore stats errors for individual connections
          }
        }

        // Prefer availableOutgoingBitrate / availableIncomingBitrate (channel capacity estimate)
        // over byte-delta calculation (current usage) when available.
        // Note: availableIncomingBitrate is rarely reported by browsers, so we fall back
        // to the delta method for download even when availableOutgoingBitrate is present.
        if (maxAvailableUploadBps > 0 || maxAvailableDownloadBps > 0) {
          this.metricsCollector.updateAvailableBandwidth(
            maxAvailableUploadBps / 1_000_000,
            maxAvailableDownloadBps / 1_000_000,
          );
        }

        // Derive bandwidth from byte deltas between polls
        const now = Date.now();
        if (this.lastStatsSnapshot && totalBytesSent + totalBytesReceived > 0) {
          const dtSec = (now - this.lastStatsSnapshot.timestamp) / 1000;
          if (dtSec > 0) {
            const uploadMbps = ((totalBytesSent - this.lastStatsSnapshot.bytesSent) * 8) / (dtSec * 1_000_000);
            const downloadMbps = ((totalBytesReceived - this.lastStatsSnapshot.bytesReceived) * 8) / (dtSec * 1_000_000);
            // Use delta-based upload only if availableOutgoingBitrate is not available
            // Always use delta-based download since availableIncomingBitrate is rarely reported
            if (maxAvailableUploadBps === 0) {
              this.metricsCollector.updateBandwidth(
                Math.max(0, uploadMbps),
                Math.max(0, downloadMbps),
              );
            } else {
              // Upload from availableOutgoingBitrate already set, update download from delta
              this.metricsCollector.updateBandwidth(
                maxAvailableUploadBps / 1_000_000,
                Math.max(0, downloadMbps),
              );
            }
          }
        }
        if (totalBytesSent + totalBytesReceived > 0) {
          this.lastStatsSnapshot = { bytesSent: totalBytesSent, bytesReceived: totalBytesReceived, timestamp: now };
        }

        // Snapshot updated values into currentMetrics and broadcast immediately
        await this.metricsCollector.snapshotFromRTCStats();
      }, 2000);

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
      this.lastSentStreamMaps.clear();
      
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

      if (this.statsPollingInterval) {
        clearInterval(this.statsPollingInterval);
        this.statsPollingInterval = null;
      }

      if (this.metricsUpdateInterval) {
        clearInterval(this.metricsUpdateInterval);
        this.metricsUpdateInterval = null;
      }

      if (this.streamMapRefreshInterval) {
        clearInterval(this.streamMapRefreshInterval);
        this.streamMapRefreshInterval = null;
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

  /** Force cleanup all resources regardless of state. Use in test teardown. */
  destroy(): void {
    if (this.statsPollingInterval) { clearInterval(this.statsPollingInterval); this.statsPollingInterval = null; }
    if (this.metricsUpdateInterval) { clearInterval(this.metricsUpdateInterval); this.metricsUpdateInterval = null; }
    if (this.streamMapRefreshInterval) { clearInterval(this.streamMapRefreshInterval); this.streamMapRefreshInterval = null; }
    if (this.relayEngine) { this.relayEngine.stopRelay(); this.relayEngine = null; }
    if (this.mediaHandler) { this.mediaHandler.closeAllConnections(); this.mediaHandler = null; }
    if (this.metricsCollector) { this.metricsCollector.stopCollection(); this.metricsCollector = null; }
    // disconnect() clears reconnect timers and closes the WebSocket
    this.signalingClient.disconnect();
    // Also terminate the raw socket for immediate closure
    const ws = (this.signalingClient as any).ws;
    if (ws && typeof ws.terminate === 'function') ws.terminate();
    this.removeAllListeners();
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
      for (const participant of message.existingParticipants) {
        this.emit('participantJoined', {
          participantId: participant.participantId,
          participantName: participant.participantName,
        });
        if (!this.allMetrics.has(participant.participantId)) {
          this.allMetrics.set(participant.participantId, {
            participantId: participant.participantId,
            timestamp: Date.now(),
            bandwidth: { uploadMbps: 5.0, downloadMbps: 10.0, measurementConfidence: 0.1 },
            natType: 0,
            latency: { averageRttMs: 50, minRttMs: 50, maxRttMs: 50, measurements: new Map() },
            stability: { packetLossPercent: 0, jitterMs: 0, connectionUptime: 0, reconnectionCount: 0 },
            device: { cpuUsagePercent: 0, availableMemoryMB: 0, supportedCodecs: [], hardwareAcceleration: false },
          });
        }
      }
    }

    // Immediately add our own participant to allMetrics so count is correct
    // This will be replaced with actual metrics once collection starts
    const participantId = this.stateMachine.getParticipantId();
    if (participantId && !this.allMetrics.has(participantId)) {
      this.allMetrics.set(participantId, {
        participantId,
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 5.0, downloadMbps: 10.0, measurementConfidence: 0.1 },
        natType: 0,
        latency: { averageRttMs: 50, minRttMs: 50, maxRttMs: 50, measurements: new Map() },
        stability: { packetLossPercent: 0, jitterMs: 0, connectionUptime: 0, reconnectionCount: 0 },
        device: { cpuUsagePercent: 0, availableMemoryMB: 0, supportedCodecs: [], hardwareAcceleration: false },
      });
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
    console.log(`[RMC:${this.logId}] topology-update v${message.topology.version} relays=${message.topology.relayNodes.map(r=>r.slice(-8))} groups=${JSON.stringify(message.topology.groups.map(g=>({r:g.relayNodeId.slice(-8),m:g.regularNodeIds.map(m=>m.slice(-8))})))}`);
    
    if (this.currentTopology) {
      const isNewer = message.topology.version > this.currentTopology.version || 
                     (message.topology.version === this.currentTopology.version && message.topology.timestamp > this.currentTopology.timestamp);
      if (!isNewer) {
        console.log(`[RMC:${this.logId}] Ignoring older/duplicate topology`);
        return;
      }
    }
    
    // Check if our role changed
    const participantId = this.stateMachine.getParticipantId();
    const oldRole = this.currentTopology && participantId && this.currentTopology.relayNodes.includes(participantId) ? 'relay' : 'regular';
    const newRole = participantId && message.topology.relayNodes.includes(participantId) ? 'relay' : 'regular';
    
    this.currentTopology = message.topology;
    // Sync lastTopologyRelayIds so non-leaders don't perpetually see relayNodesChanged=true
    this.lastTopologyRelayIds = [...message.topology.relayNodes].sort();
    this.emit('topologyUpdate', message.topology);
    
    // When we're a relay and the topology changes (even if role stays relay),
    // clear forwardedStreamIds so we re-forward streams to the new peer set.
    // Example: A=relay leaves → B stays relay but now has A's old group members
    // as its own group. B must forward C's stream to A (new regular) even though
    // B already has C in forwardedStreamIds from the old topology.
    if (this.currentRole === 'relay' && oldRole === 'relay' && newRole === 'relay') {
      console.log(`[RMC:${this.logId}] Relay topology changed — clearing forwardedStreamIds to re-forward to new peer set`);
      this.forwardedStreamIds.clear();
      this.lastSentStreamMaps.clear();
      // Re-trigger forwarding for all currently known remote streams.
      // updateConnections() handles NEW connections, but for EXISTING connections
      // (peers B was already connected to) we must explicitly push the streams.
      // Use setTimeout(0) so updateConnections() runs first and establishes any
      // new connections before we try to forward to them.
      if (this.mediaHandler) {
        const streamsToForward = Array.from(this.mediaHandler.getRemoteStreams().entries());
        setTimeout(() => {
          if (!this.mediaHandler || this.currentRole !== 'relay') return;
          for (const [sourceParticipantId, remoteStream] of streamsToForward) {
            const connectedPeers = this.mediaHandler.getConnectedPeers();
            for (const peerId of connectedPeers) {
              if (peerId === sourceParticipantId) continue;
              // Don't forward back to the peer we received this stream from
              const sourcePeer = this.mediaHandler.getStreamSourcePeer(sourceParticipantId);
              if (sourcePeer && peerId === sourcePeer) {
                console.log(`[RMC:${this.logId}] [topology-change-fwd] skipping ${sourceParticipantId.slice(-8)} → ${peerId.slice(-8)} (received from this peer)`);
                continue;
              }
              const pc = this.mediaHandler.getPeerConnection(peerId);
              if (!pc) continue;
              console.log(`[RMC:${this.logId}] [topology-change-fwd] forwarding ${sourceParticipantId.slice(-8)} → ${peerId.slice(-8)}`);
              this.mediaHandler.addRemoteStreamForRelay(pc, remoteStream, sourceParticipantId);
              this.forwardedStreamIds.set(sourceParticipantId, this.mediaHandler.getStreamSourcePeer(sourceParticipantId) ?? '');
            }
            // Stream maps will be sent after renegotiation completes in handleWebRTCAnswer
          }
        }, 500); // 500ms: let updateConnections() finish establishing new connections first
      }
    }

    // Emit role change event if role changed
    if (oldRole !== newRole) {
      console.log('[RelayMeshClient] Role changed from', oldRole, 'to', newRole);
      this.currentRole = newRole;
      
      // Clear forwarded streams tracking when role changes
      this.forwardedStreamIds.clear();
      this.lastSentStreamMaps.clear();
      
      this.emit('roleChange', newRole);
      
      // Re-emit remote streams so the UI can rebuild its video elements after role change.
      // IMPORTANT: Do NOT snapshot streams here. updateConnections() (called below) will close
      // the old relay connection and remove streams received through it. Re-reading remoteStreams
      // after a delay ensures we only re-emit streams with live tracks.
      // Use a delay longer than updateConnections() teardown (~0ms) but short enough to feel instant.
      if (this.mediaHandler) {
        setTimeout(() => {
          if (!this.mediaHandler) return;
          const liveStreams = Array.from(this.mediaHandler.getRemoteStreams().entries());
          console.log(`[RelayMeshClient] Re-emitting ${liveStreams.length} live remote streams after role change`);
          for (const [sourceParticipantId, remoteStream] of liveStreams) {
            const mediaStream: import('./media-handler').MediaStream = {
              streamId: remoteStream.id,
              participantId: sourceParticipantId,
              tracks: remoteStream.getTracks(),
              isLocal: false,
            };
            this.emit('remoteStream', mediaStream);
          }
        }, 100); // 100ms: after updateConnections() closes stale connections and removes dead streams
      }
      
      // Handle relay engine
      if (newRole === 'relay' && !this.relayEngine) {
        this.relayEngine = new RelayEngine();
        this.relayEngine.startRelay();
        // Start periodic stream map refresh so regular nodes get late-arriving streams
        if (!this.streamMapRefreshInterval) {
          this.streamMapRefreshInterval = setInterval(() => this.broadcastStreamMaps(), 1000);
        }
      } else if (newRole === 'regular' && this.relayEngine) {
        this.relayEngine.stopRelay();
        this.relayEngine = null;
        if (this.streamMapRefreshInterval) {
          clearInterval(this.streamMapRefreshInterval);
          this.streamMapRefreshInterval = null;
        }
      }

      // When transitioning regular→relay, existing connections were set up without
      // forwarding. We must now forward all known streams to existing peers, and send
      // stream maps so they can attribute the forwarded streams correctly.
      // Use setTimeout so updateConnections() runs first and establishes any NEW
      // connections (e.g. to the other relay) before we push streams to existing ones.
      if (oldRole === 'regular' && newRole === 'relay' && this.mediaHandler) {
        // NOTE: Do NOT snapshot streams here. updateConnections() (called below) will close
        // the old relay connection, which removes all streams received through it from
        // remoteStreams. A stale snapshot would contain dead tracks from the closed connection.
        // Instead, re-read remoteStreams at setTimeout time so we only forward live streams.
        console.log(`[RMC:${this.logId}] regular→relay: will forward live streams to existing peers after updateConnections`);
        setTimeout(() => {
          if (!this.mediaHandler || this.currentRole !== 'relay') return;
          // Re-read at execution time — only streams still present are live (not from closed connections)
          const liveStreams = Array.from(this.mediaHandler.getRemoteStreams().entries());
          const connectedPeers = this.mediaHandler.getConnectedPeers();
          console.log(`[RMC:${this.logId}] regular→relay fwd: peers=[${connectedPeers.map(p=>p.slice(-8)).join(',')}] streams=[${liveStreams.map(([id])=>id.slice(-8)).join(',')}]`);
          for (const [sourceParticipantId, remoteStream] of liveStreams) {
            for (const peerId of connectedPeers) {
              if (peerId === sourceParticipantId) continue;
              // Don't forward back to the peer we received this stream from
              const sourcePeer = this.mediaHandler.getStreamSourcePeer(sourceParticipantId);
              if (sourcePeer && peerId === sourcePeer) {
                console.log(`[RMC:${this.logId}] regular→relay fwd: skipping ${sourceParticipantId.slice(-8)} → ${peerId.slice(-8)} (received from this peer)`);
                continue;
              }
              const pc = this.mediaHandler.getPeerConnection(peerId);
              if (!pc) continue;
              console.log(`[RMC:${this.logId}] regular→relay fwd: ${sourceParticipantId.slice(-8)} → ${peerId.slice(-8)}`);
              // Don't send stream map in callback - it will be sent after renegotiation completes in handleWebRTCAnswer
              this.mediaHandler.addRemoteStreamForRelay(pc, remoteStream, sourceParticipantId);
              this.forwardedStreamIds.set(sourceParticipantId, this.mediaHandler.getStreamSourcePeer(sourceParticipantId) ?? '');
            }
          }
          // Stream maps will be sent after renegotiation completes in handleWebRTCAnswer
        }, 500);
      }
      
      // updateConnections() below will diff current vs target connections and
      // close/open only what's needed — no need to nuke everything here.
    }

    // If we were joining, complete the join
    if (this.stateMachine.getCurrentState() === ConferenceState.JOINING) {
      await this.stateMachine.completeJoin();
    }

    // Update connections based on new topology
    await this.updateConnections();
  }

  private handleMetricsBroadcast(message: MetricsBroadcastMessage): void {

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
      // Note: evaluateTopology will skip if connections are being recreated
      this.evaluateTopology();
    }

  private handleParticipantLeft(message: any): void {
    const participantId = message.participantId;
    console.log(`[RMC:${this.logId}] participant left: ${participantId.slice(-8)}`);
    this.allMetrics.delete(participantId);
    if (this.mediaHandler) {
      this.mediaHandler.removeRemoteStream(participantId);
      this.forwardedStreamIds.delete(participantId);
    }
    this.lastSentStreamMaps.delete(participantId);
    this.emit('participantLeft', participantId);
    this.evaluateTopology();
  }

  private handleParticipantJoined(message: any): void {
    const participantId = message.participantId;
    console.log(`[RMC:${this.logId}] participant joined: ${participantId.slice(-8)}`);
    if (!this.allMetrics.has(participantId)) {
      this.allMetrics.set(participantId, {
        participantId,
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 5.0, downloadMbps: 10.0, measurementConfidence: 0.1 },
        natType: 0,
        latency: { averageRttMs: 50, minRttMs: 50, maxRttMs: 50, measurements: new Map() },
        stability: { packetLossPercent: 0, jitterMs: 0, connectionUptime: 0, reconnectionCount: 0 },
        device: { cpuUsagePercent: 0, availableMemoryMB: 0, supportedCodecs: [], hardwareAcceleration: false },
      });
      setTimeout(() => {
        if (this.stateMachine.getCurrentState() === ConferenceState.CONNECTED) {
          this.updateRelaySelectionData();
        }
      }, 1000);
    }
    if (this.metricsCollector && this.stateMachine.getCurrentState() === ConferenceState.CONNECTED) {
      try {
        this.signalingClient.broadcastMetrics(this.metricsCollector.getCurrentMetrics());
      } catch (_) {}
    }
    this.emit('participantJoined', { participantId, participantName: message.participantName });
  }

  private async handleRelayAssignment(message: RelayAssignmentMessage): Promise<void> {
    this.currentRole = message.role;
    this.emit('roleChange', message.role);

    if (message.role === 'relay') {
      // Initialize relay engine
      this.relayEngine = new RelayEngine();
      this.relayEngine.startRelay();
      if (!this.streamMapRefreshInterval) {
        this.streamMapRefreshInterval = setInterval(() => this.broadcastStreamMaps(), 1000);
      }
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

    // Prevent topology evaluation while connections are being recreated
    // This avoids infinite loops where metrics broadcasts during recreation
    // trigger new topology updates and more recreations
    if (this.isRecreatingConnections) {
      console.log('[RelayMeshClient] Skipping topology evaluation - connections are being recreated');
      return;
    }

    // Run selection algorithm, passing current relays for hysteresis
    const config = this.buildSelectionConfig();
    const currentRelayIds = this.currentTopology?.relayNodes || [];
    const result = this.selectionAlgorithm.selectRelayNodes(this.allMetrics, config, currentRelayIds);
    const relayNodeIds = result.selectedIds;

    // Send relay selection data to server for monitoring
    const conferenceId = this.stateMachine.getConferenceId();
    if (this.signalingClient && conferenceId) {
      this.signalingClient.sendRelaySelectionData(conferenceId, result.selectionData);
    }

    // Check if topology needs update
    // Compare against lastTopologyRelayIds (what we last broadcast) rather than
    // currentRelayIds (which can change as we receive topology updates from others),
    // to prevent oscillation feedback loops.
    const relayNodesChanged = !this.arraysEqual(relayNodeIds, this.lastTopologyRelayIds);
    
    console.log(`[RMC:${this.logId}] relays: new=${[...relayNodeIds].sort().map(r=>r.slice(-8))} last=${[...this.lastTopologyRelayIds].sort().map(r=>r.slice(-8))} changed=${relayNodesChanged}`);
    // Check for participant count changes (new/deleted users)
    const participantCountChanged = this.allMetrics.size !== this.lastTopologyMetricsSnapshot.size;
    
    // If relay nodes haven't changed and participant count is the same, check for metric changes
    if (!relayNodesChanged && !participantCountChanged) {
      // Check if metrics have changed significantly
      const metricsChangedSignificantly = this.hasSignificantMetricChange(0.3); // 30% threshold
      
      if (!metricsChangedSignificantly) {
        return;
      }
    }
    
    // If we get here, something changed - form new topology and check if it's actually different
    if (relayNodesChanged || participantCountChanged) {
      console.log(`[RMC:${this.logId}] topology change: relays=${relayNodesChanged} count=${participantCountChanged}`);
      
      // Leader election: Only the participant with the lowest ID broadcasts topology updates
      // This prevents race conditions when multiple clients try to update topology simultaneously
      const participantId = this.stateMachine.getParticipantId();
      const allParticipantIds = Array.from(this.allMetrics.keys()).sort();
      const leaderId = allParticipantIds[0];
      
      if (participantId !== leaderId) {
        this.snapshotMetrics();
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
      
      console.log(`[RMC:${this.logId}] new topology: relays=${newTopology.relayNodes.map(r=>r.slice(-8))} groups=${JSON.stringify(newTopology.groups.map(g=>({r:g.relayNodeId.slice(-8),m:g.regularNodeIds.map(m=>m.slice(-8))})))}`);

      if (this.topologyEquals(this.currentTopology, newTopology)) {
        this.lastTopologyRelayIds = [...relayNodeIds].sort();
        this.snapshotMetrics();
        await this.updateConnections();
        return;
      }

      console.log(`[RMC:${this.logId}] broadcasting topology update`);
      this.signalingClient.sendTopologyUpdate(newTopology, 'relay-selection');
      
      // Update our local topology immediately (we won't receive our own broadcast)
      const oldRole = this.currentTopology && participantId && this.currentTopology.relayNodes.includes(participantId) ? 'relay' : 'regular';
      const newRole = participantId && newTopology.relayNodes.includes(participantId) ? 'relay' : 'regular';
      
      this.currentTopology = newTopology;
      this.emit('topologyUpdate', newTopology);
      
      // Emit role change event if role changed
      if (oldRole !== newRole) {
        console.log(`[RMC:${this.logId}] role: ${oldRole} → ${newRole}`);
        this.currentRole = newRole;
        this.emit('roleChange', newRole);
        
        // Handle relay engine
        if (newRole === 'relay' && !this.relayEngine) {
          this.relayEngine = new RelayEngine();
          this.relayEngine.startRelay();
          if (!this.streamMapRefreshInterval) {
            this.streamMapRefreshInterval = setInterval(() => this.broadcastStreamMaps(), 1000);
          }
        } else if (newRole === 'regular' && this.relayEngine) {
          this.relayEngine.stopRelay();
          this.relayEngine = null;
          if (this.streamMapRefreshInterval) {
            clearInterval(this.streamMapRefreshInterval);
            this.streamMapRefreshInterval = null;
          }
        }
        
        // updateConnections() below will diff current vs target connections and
        // close/open only what's needed — no need to nuke everything here.
      }
      
      // Update connections based on new topology
      await this.updateConnections();
      
      // Remember this topology and metrics snapshot to detect oscillation
      this.lastTopologyRelayIds = [...relayNodeIds].sort();
      this.snapshotMetrics();
    } else {
      // Still ensure connections match the current topology (may have been disrupted)
      await this.updateConnections();
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
   * Broadcast the current stream map to all connected peers.
   * Called periodically on relay nodes to ensure late-arriving streams get attributed correctly.
   */
  /**
   * Build the full stream map to send to a peer.
   * Includes all resolved remote streams (excluding the peer itself as source),
   * plus the relay's own local stream so the receiver can attribute it immediately
   * without waiting for the 3000ms timeout.
   */
  private buildStreamMapForPeer(peerId: string): Record<string, string> {
    if (!this.mediaHandler) return {};
    const myId = this.stateMachine.getParticipantId();
    const streamMap: Record<string, string> = {};

    // Include all resolved remote streams (not from this peer)
    const remoteStreams = this.mediaHandler.getRemoteStreams();
    for (const [sourceId, stream] of remoteStreams.entries()) {
      if (sourceId !== peerId) {
        streamMap[stream.id] = sourceId;
      }
    }

    // Include the relay's own local stream so the receiver doesn't need the 3000ms fallback
    if (myId) {
      const localStream = this.mediaHandler.getLocalStream();
      if (localStream) {
        streamMap[localStream.id] = myId;
      }
    }

    console.log(`[RMC:${this.logId}][buildStreamMap] for peer=${peerId.slice(-8)} remoteStreams=[${Array.from(remoteStreams.entries()).map(([id,s])=>`${id.slice(-8)}→${s.id.slice(0,8)}`).join(',')}] result=`, streamMap);
    return streamMap;
  }

  private broadcastStreamMaps(): void {
    if (this.currentRole !== 'relay' || !this.mediaHandler) return;
    const remoteStreams = this.mediaHandler.getRemoteStreams();
    const pendingStreams = this.mediaHandler.getPendingStreams();
    const connectedPeers = this.mediaHandler.getConnectedPeers();

    // Detailed diagnostic log every tick
    console.log(`[RMC:${this.logId}][bcast] remoteStreams=[${Array.from(remoteStreams.entries()).map(([id, s]) => `${id.slice(-8)}→${s.id.slice(0,8)}`).join(', ')}] pending=[${Array.from(pendingStreams.entries()).map(([sid, p]) => `${sid.slice(0,8)}←${p.connectionId.slice(-8)}`).join(', ')}] peers=[${connectedPeers.map(p => p.slice(-8)).join(', ')}]`);

    for (const peerId of connectedPeers) {
      const pc = this.mediaHandler.getPeerConnection(peerId);
      if (!pc) continue;
      const streamMap = this.buildStreamMapForPeer(peerId);
      if (Object.keys(streamMap).length === 0) continue;

      // Only send if the map content changed since last send to this peer
      const mapJson = JSON.stringify(streamMap);
      if (this.lastSentStreamMaps.get(peerId) === mapJson) continue;

      this.lastSentStreamMaps.set(peerId, mapJson);
      this.mediaHandler.sendRelayStreamMap(peerId, pc, streamMap);
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
        const tag = `[RMC:${this.logId}][fwdLate]`;
        console.log(`${tag} LATE ARRIVAL: stream from ${stream.participantId.slice(-8)} arrived after connections established`);
        if (!this.mediaHandler) {
          console.warn(`${tag} no mediaHandler`);
          return;
        }

        const remoteStreams = this.mediaHandler.getRemoteStreams();
        console.log(`${tag} remoteStreams keys=[${Array.from(remoteStreams.keys()).map(k => k.slice(-8)).join(', ')}]`);
        console.log(`${tag} forwardedStreamIds=[${Array.from(this.forwardedStreamIds.entries()).map(([k, v]) => `${k.slice(-8)}:${v.slice(0,8)}`).join(', ')}]`);
        const sourceStream = remoteStreams.get(stream.participantId);

        if (!sourceStream) {
          console.warn(`${tag} source stream NOT FOUND for ${stream.participantId.slice(-8)} (${remoteStreams.size} entries in map)`);
          return;
        }

        console.log(`${tag} sourceStream id=${sourceStream.id.slice(0,8)} tracks=${sourceStream.getTracks().map(t => t.kind).join(',')}`);

        const connectedPeers = this.mediaHandler.getConnectedPeers();
        console.log(`${tag} forwarding stream from ${stream.participantId.slice(-8)} to ${connectedPeers.length} connected peers=[${connectedPeers.map(p => p.slice(-8)).join(', ')}]`);

        // Get the peer we received this stream from (to avoid forwarding back to source)
        const sourcePeer = this.mediaHandler.getStreamSourcePeer(stream.participantId);
        console.log(`${tag} sourcePeer for ${stream.participantId.slice(-8)} is ${sourcePeer?.slice(-8) ?? 'unknown'}`);

        let forwardedCount = 0;
        let skippedCount = 0;

        for (const peerId of connectedPeers) {
          if (peerId === stream.participantId) {
            console.log(`${tag} skipping ${peerId.slice(-8)} (stream owner)`);
            skippedCount++;
            continue;
          }

          // Don't forward back to the peer we received this stream from
          if (sourcePeer && peerId === sourcePeer) {
            console.log(`${tag} skipping ${peerId.slice(-8)} (received from this peer)`);
            skippedCount++;
            continue;
          }

          const peerConnection = this.mediaHandler.getPeerConnection(peerId);
          if (!peerConnection) {
            console.warn(`${tag} no peerConnection for ${peerId.slice(-8)}`);
            skippedCount++;
            continue;
          }

          const sendersBefore = peerConnection.getSenders().map(s => s.track?.kind ?? 'null');
          console.log(`${tag} → ${peerId.slice(-8)} signalingState=${peerConnection.signalingState} connectionState=${peerConnection.connectionState} sendersBefore=[${sendersBefore.join(', ')}]`);

          // Don't send stream map in callback - it will be sent after renegotiation completes in handleWebRTCAnswer
          this.mediaHandler.addRemoteStreamForRelay(peerConnection, sourceStream, stream.participantId);
          forwardedCount++;
          
          const sendersAfter = peerConnection.getSenders().map(s => s.track?.kind ?? 'null');
          console.log(`${tag} → ${peerId.slice(-8)} sendersAfter=[${sendersAfter.join(', ')}]`);
        }

        console.log(`${tag} COMPLETE: forwarded to ${forwardedCount} peers, skipped ${skippedCount} peers`);
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
    private async renegotiateConnection(peerId: string, peerConnection: RTCPeerConnection, attempt: number = 0): Promise<void> {
      if (!this.signalingClient) return;

      try {
        console.log(`[RMC:${this.logId}][renegotiate] peerId=${peerId.slice(-8)} signalingState=${peerConnection.signalingState} connectionState=${peerConnection.connectionState} attempt=${attempt}`);

        if (peerConnection.connectionState === 'closed') {
          console.log(`[RMC:${this.logId}][renegotiate] ABORTED for ${peerId.slice(-8)} - connection closed`);
          return;
        }

        if (peerConnection.signalingState !== 'stable') {
          if (attempt >= 5) {
            console.warn(`[RMC:${this.logId}][renegotiate] GIVING UP for ${peerId.slice(-8)} after ${attempt} attempts`);
            return;
          }
          console.log(`[RMC:${this.logId}][renegotiate] DEFERRED for ${peerId.slice(-8)} - not stable, retry ${attempt + 1} in 500ms`);
          setTimeout(() => this.renegotiateConnection(peerId, peerConnection, attempt + 1), 500);
          return;
        }

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        this.signalingClient.sendWebRTCOffer(peerId, offer);
        console.log(`[RMC:${this.logId}][renegotiate] offer sent to ${peerId.slice(-8)}`);
      } catch (error) {
        console.error(`[RMC:${this.logId}][renegotiate] FAILED for ${peerId.slice(-8)}:`, error);
      }
    }


  private async updateConnections(): Promise<void> {
    if (!this.currentTopology || !this.mediaHandler) return;
    const participantId = this.stateMachine.getParticipantId();
    if (!participantId) return;
    const localStream = this.mediaHandler.getLocalStream();
    if (!localStream) return;

    const targetConnections = this.getTargetConnections(participantId);
    const currentConnections = this.mediaHandler.getActiveConnections();
    console.log(`[RMC:${this.logId}] updateConn role=${this.currentRole} target=[${targetConnections.map(r=>r.slice(-8))}] current=[${currentConnections.map(r=>r.slice(-8))}]`);
    
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

      // Only recreate connections if the target set actually changed.
      // If we already have exactly the right connections, tearing them down just
      // to rebuild them causes unnecessary churn and stream interruptions.
      const targetSet = new Set(targetConnections);
      const currentSet = new Set(currentConnections);
      const connectionsChanged = targetConnections.some(id => !currentSet.has(id)) ||
                                 currentConnections.some(id => !targetSet.has(id));
      
      if (shouldForward && connectionsChanged) {
        for (const remoteId of currentConnections) {
          if (!targetConnections.includes(remoteId)) {
            console.log(`[RMC:${this.logId}] closing stale connection: ${remoteId.slice(-8)}`);
            this.mediaHandler.closePeerConnection(remoteId);
          }
        }
      } else if (shouldForward && !connectionsChanged) {
        for (const remoteId of currentConnections) {
          if (!targetConnections.includes(remoteId)) {
            this.mediaHandler.closePeerConnection(remoteId);
          }
        }
      }
    } else {
      for (const remoteId of currentConnections) {
        if (!targetConnections.includes(remoteId)) {
          this.mediaHandler.closePeerConnection(remoteId);
        }
      }
    }

    const peerConfig = this.buildPeerConnectionConfig();
    for (const remoteId of targetConnections) {
      if (currentConnections.includes(remoteId)) {
        continue;
      }
      {
        console.log(`[RMC:${this.logId}] creating PC to ${remoteId.slice(-8)} role=${this.currentRole}`);
        const peerConnection = await this.mediaHandler.createPeerConnection(remoteId, peerConfig);
        
        // Suppress onnegotiationneeded for this peer while we're setting up tracks.
        // We'll send the offer manually once all tracks are added.
        this.suppressNegotiationFor.add(remoteId);

        console.log(`[RMC:${this.logId}] adding local stream to new PC ${remoteId.slice(-8)} localStreamId=${localStream.id} tracks=[${localStream.getTracks().map(t => `${t.kind}:${t.id.slice(-8)}`).join(',')}]`);
        this.mediaHandler.addLocalStream(peerConnection, {
          streamId: localStream.id,
          participantId: participantId,
          tracks: localStream.getTracks(),
          isLocal: true,
        });

        if (this.currentRole === 'relay') {
          const remoteStreams = this.mediaHandler.getRemoteStreams();
          const pendingStreams = this.mediaHandler.getPendingStreams();
          
          // Get the peer we're creating a connection to (to avoid forwarding back to source)
          const sourcePeerForNewConnection = this.mediaHandler.getStreamSourcePeer(remoteId);
          
          console.log(`[RMC:${this.logId}][newConn] forwarding ${remoteStreams.size} resolved + ${pendingStreams.size} pending to NEW connection ${remoteId.slice(-8)}`);
          if (remoteStreams.size > 0) {
            console.log(`[RMC:${this.logId}][newConn] available resolved streams: [${Array.from(remoteStreams.keys()).map(p => p.slice(-8)).join(', ')}]`);
          }
          if (pendingStreams.size > 0) {
            console.log(`[RMC:${this.logId}][newConn] available pending streams: [${Array.from(pendingStreams.keys()).map(s => s.slice(0,8)).join(', ')}]`);
          }

          // Collect promises so we can wait for all canvas pipelines before sending the offer.
          // This ensures the offer includes all forwarded tracks (no renegotiation needed).
          const trackReadyPromises: Promise<void>[] = [];

          for (const [sourceParticipantId, _snapshotStream] of remoteStreams.entries()) {
            // Skip if this is the peer we're connecting to (don't forward their own stream back)
            if (sourceParticipantId === remoteId) {
              console.log(`[RMC:${this.logId}][newConn] skipping resolved stream from ${sourceParticipantId.slice(-8)} - same as target peer`);
              continue;
            }
            
            // Skip if we received this stream FROM the peer we're connecting to (avoid forwarding loop)
            const streamSourcePeer = this.mediaHandler.getStreamSourcePeer(sourceParticipantId);
            if (streamSourcePeer === remoteId) {
              console.log(`[RMC:${this.logId}][newConn] skipping resolved stream from ${sourceParticipantId.slice(-8)} - received from target peer ${remoteId.slice(-8)}`);
              continue;
            }
            
            console.log(`[RMC:${this.logId}][newConn] forwarding resolved stream from ${sourceParticipantId.slice(-8)} (streamId=${_snapshotStream.id.slice(0,8)}) to ${remoteId.slice(-8)}`);
            const capturedPeerId = remoteId;
            const capturedPc = peerConnection;
            const capturedSourceId = sourceParticipantId;
            const p = new Promise<void>((resolve) => {
              // Re-read remoteStreams at call time — a previous canvas pipeline for another
              // peer may have already updated remoteStreams[sourceId] to a synthetic stream.
              // Using the synthetic avoids re-running the canvas pipeline on a re-relay stream
              // (which would hit the 500ms timeout and forward dead tracks).
              const currentStream = this.mediaHandler!.getRemoteStreams().get(capturedSourceId) ?? _snapshotStream;
              console.log(`[RMC:${this.logId}][newConn] calling addRemoteStreamForRelay for ${capturedSourceId.slice(-8)} stream=${currentStream.id.slice(0,8)} to ${capturedPeerId.slice(-8)}`);
              this.mediaHandler!.addRemoteStreamForRelay(capturedPc, currentStream, capturedSourceId, () => {
                console.log(`[RMC:${this.logId}][newConn] addRemoteStreamForRelay callback for ${capturedSourceId.slice(-8)} to ${capturedPeerId.slice(-8)} - tracks added`);
                // Just signal completion - stream map will be sent after offer/answer in handleWebRTCAnswer
                resolve();
              });
            });
            trackReadyPromises.push(p);
          }

          for (const [nativeStreamId, pending] of pendingStreams.entries()) {
            const sourceId = pending.connectionId;
            if (sourceId !== remoteId && !remoteStreams.has(sourceId)) {
              console.log(`[RMC:${this.logId}][newConn] forwarding pending stream ${nativeStreamId.slice(0,8)} from ${sourceId.slice(-8)} to ${remoteId.slice(-8)}`);
              const capturedPeerId = remoteId;
              const capturedPc = peerConnection;
              const p = new Promise<void>((resolve) => {
                this.mediaHandler!.addRemoteStreamForRelay(capturedPc, pending.stream, sourceId, () => {
                  console.log(`[RMC:${this.logId}][newConn] addRemoteStreamForRelay callback for pending ${sourceId.slice(-8)} to ${capturedPeerId.slice(-8)} - tracks added`);
                  // Just signal completion - stream map will be sent after offer/answer in handleWebRTCAnswer
                  resolve();
                });
              });
              trackReadyPromises.push(p);
            } else {
              if (sourceId === remoteId) {
                console.log(`[RMC:${this.logId}][newConn] skipping pending stream ${nativeStreamId.slice(0,8)} from ${sourceId.slice(-8)} - same as target peer`);
              } else {
                console.log(`[RMC:${this.logId}][newConn] skipping pending stream ${nativeStreamId.slice(0,8)} from ${sourceId.slice(-8)} - already in resolved streams`);
              }
            }
          }

          // Wait for all canvas pipelines to complete before sending the offer.
          // This ensures the offer SDP includes all forwarded tracks so no renegotiation is needed.
          if (trackReadyPromises.length > 0) {
            console.log(`[RMC:${this.logId}][newConn] waiting for ${trackReadyPromises.length} canvas pipeline(s) before offer to ${remoteId.slice(-8)}`);
            await Promise.all(trackReadyPromises);
            console.log(`[RMC:${this.logId}][newConn] all ${trackReadyPromises.length} pipeline(s) ready, proceeding with offer to ${remoteId.slice(-8)}`);
          } else {
            console.log(`[RMC:${this.logId}][newConn] no remote streams to forward to ${remoteId.slice(-8)} (only local stream)`);
          }

          // Don't send stream map here - it will be sent after answer is received in handleWebRTCAnswer
        }

        // All tracks added — lift suppression and send the offer
        this.suppressNegotiationFor.delete(remoteId);

        if (peerConnection.signalingState !== 'stable') {
          console.log(`[RMC:${this.logId}] skipping offer for ${remoteId.slice(-8)}: state=${peerConnection.signalingState}`);
        } else {
          this.makingOffer.set(remoteId, true);
          try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            this.signalingClient.sendWebRTCOffer(remoteId, offer);
            console.log(`[RMC:${this.logId}] offer sent to ${remoteId.slice(-8)}`);
          } catch (error) {
            console.error(`[RMC:${this.logId}] offer error for ${remoteId.slice(-8)}:`, error);
            this.makingOffer.set(remoteId, false);
          }
        }
      }
    }
    
    // For existing connections where we're a relay, ensure local stream is present
    // This handles the case where a relay has no remote streams to forward but still
    // needs to send its own local stream to connected peers (e.g. relay with no members)
    if (this.currentRole === 'relay') {
      console.log(`[RMC:${this.logId}][localStreamCheck] checking ${targetConnections.length} target connections`);
      for (const remoteId of targetConnections) {
        if (currentConnections.includes(remoteId)) {
          const pc = this.mediaHandler.getPeerConnection(remoteId);
          if (pc) {
            const senders = pc.getSenders();
            const localTrackIds = localStream.getTracks().map(t => t.id);
            const senderTrackIds = senders.map(s => s.track?.id || 'null');
            console.log(`[RMC:${this.logId}][localStreamCheck] ${remoteId.slice(-8)}: localTracks=[${localTrackIds.join(',')}] senderTracks=[${senderTrackIds.join(',')}]`);
            
            const hasLocalTracks = senders.some(s => s.track && localStream.getTracks().some(t => t.id === s.track?.id));
            if (!hasLocalTracks) {
              console.log(`[RMC:${this.logId}][localStreamCheck] MISSING local stream on existing connection ${remoteId.slice(-8)} - adding now`);
              this.mediaHandler.addLocalStream(pc, {
                streamId: localStream.id,
                participantId: participantId,
                tracks: localStream.getTracks(),
                isLocal: true,
              });
              // Trigger renegotiation to send the new tracks
              if (pc.signalingState === 'stable') {
                console.log(`[RMC:${this.logId}][localStreamCheck] triggering renegotiation for ${remoteId.slice(-8)} to send local stream`);
                this.renegotiateConnection(remoteId, pc);
              } else {
                console.log(`[RMC:${this.logId}][localStreamCheck] cannot renegotiate ${remoteId.slice(-8)} - signalingState=${pc.signalingState}`);
              }
            } else {
              console.log(`[RMC:${this.logId}][localStreamCheck] ${remoteId.slice(-8)} already has local tracks ✓`);
            }
          } else {
            console.log(`[RMC:${this.logId}][localStreamCheck] ${remoteId.slice(-8)} - no peer connection found`);
          }
        } else {
          console.log(`[RMC:${this.logId}][localStreamCheck] ${remoteId.slice(-8)} - new connection (will be created)`);
        }
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
    
    // isRecreatingConnections is no longer used for full teardown, but kept as a guard
    // against topology re-evaluation loops during connection setup.
    setTimeout(() => {
      this.isRecreatingConnections = false;
    }, 500);
  }

  private getTargetConnections(participantId: string): string[] {
    if (!this.currentTopology) return [];
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
      const otherRelays = this.currentTopology.relayNodes.filter((id) => id !== participantId);
      const group = this.currentTopology.groups.find((g) => g.relayNodeId === participantId);
      const groupMembers = group?.regularNodeIds || [];
      return [...otherRelays, ...groupMembers];
    } else {
      const group = this.currentTopology.groups.find((g) =>
        g.regularNodeIds.includes(participantId)
      );
      if (group) {
        return [group.relayNodeId];
      }
      if (this.currentTopology.relayNodes.length > 0) {
        const fallbackRelay = this.currentTopology.relayNodes[0];
        console.log(`[RMC:${this.logId}] no group yet, fallback relay: ${fallbackRelay.slice(-8)}`);
        return [fallbackRelay];
      }
      return [];
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

    console.log(`[RMC:${this.logId}][handleWebRTCOffer] Received offer from ${message.from.slice(-8)}`);

    try {
      const peerConnections = this.mediaHandler.getPeerConnections();
      let peerConnection = peerConnections.get(message.from);
      
      const myId = this.stateMachine.getParticipantId() || '';
      const theirId = message.from;
      
      // Perfect negotiation: determine politeness based on ID comparison
      const polite = myId > theirId;
      
      console.log(`[RMC:${this.logId}][handleWebRTCOffer] from ${message.from.slice(-8)} polite=${polite} existingPC=${!!peerConnection} signalingState=${peerConnection?.signalingState ?? 'none'}`);
      
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
      console.log(`[RMC:${this.logId}][handleWebRTCOffer] setting remote description from ${message.from.slice(-8)}, offer has ${message.offer.sdp.split('m=').length - 1} media sections`);
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      } catch (sdpError: any) {
        // m-line count/order mismatch: the remote peer's offer has a different number of
        // media sections than our local description (e.g. we added forwarded tracks they
        // don't know about yet). Close and let them retry — they'll create a fresh PC.
        const msg = sdpError?.message ?? String(sdpError);
        if (msg.includes('m-line') || msg.includes('media section') || msg.includes('BUNDLE')) {
          console.warn(`[RMC:${this.logId}][handleWebRTCOffer] m-line mismatch from ${message.from.slice(-8)}, closing PC to force fresh negotiation: ${msg}`);
          this.mediaHandler.closePeerConnection(message.from);
        } else {
          console.error(`[RMC:${this.logId}][handleWebRTCOffer] setRemoteDescription failed from ${message.from.slice(-8)}:`, sdpError);
        }
        return;
      }
      console.log(`[RMC:${this.logId}][handleWebRTCOffer] remote description set from ${message.from.slice(-8)}, signalingState=${peerConnection.signalingState}`);

      // Process any queued ICE candidates now that remote description is set
      const queuedCandidates = this.pendingIceCandidates.get(message.from);
      if (queuedCandidates && queuedCandidates.length > 0) {
        console.log(`[RelayMeshClient] Processing ${queuedCandidates.length} queued ICE candidates for:`, message.from);
        for (const candidate of queuedCandidates) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (error) {
            console.error('[RelayMeshClient] Error adding queued ICE candidate:', error);
          }
        }
        this.pendingIceCandidates.delete(message.from);
      }

      // Create and send answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      // Send answer back
      this.signalingClient.sendWebRTCAnswer(message.from, answer);

      console.log(`[RMC:${this.logId}][handleWebRTCOffer] Sent answer to ${message.from.slice(-8)}`);

      // After sending the answer, send updated relay-stream-map so the peer
      // can attribute the tracks we're sending. This mirrors the logic in handleWebRTCAnswer.
      if (this.currentRole === 'relay' && this.mediaHandler) {
        const streamMap = this.buildStreamMapForPeer(message.from);
        if (Object.keys(streamMap).length > 0) {
          console.log(`[RMC:${this.logId}][handleWebRTCOffer] sending relay-stream-map to ${message.from.slice(-8)} after answer:`, streamMap);
          this.mediaHandler.sendRelayStreamMap(message.from, peerConnection, streamMap);
        }
      }
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

      // Process any queued ICE candidates now that remote description is set
      const queuedCandidates = this.pendingIceCandidates.get(message.from);
      if (queuedCandidates && queuedCandidates.length > 0) {
        console.log(`[RelayMeshClient] Processing ${queuedCandidates.length} queued ICE candidates for:`, message.from);
        for (const candidate of queuedCandidates) {
          try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (error) {
            console.error('[RelayMeshClient] Error adding queued ICE candidate:', error);
          }
        }
        this.pendingIceCandidates.delete(message.from);
      }

      console.log('[RelayMeshClient] Set remote description from answer:', message.from);
      
      // Clear the makingOffer flag now that negotiation is complete
      this.makingOffer.set(message.from, false);

      // After renegotiation completes, send updated relay-stream-map so the peer
      // can attribute the tracks it just received via ontrack. This ensures the map
      // arrives AFTER the tracks, not before (which would cause "no pending stream" warnings).
      if (this.currentRole === 'relay' && this.mediaHandler) {
        const streamMap = this.buildStreamMapForPeer(message.from);
        if (Object.keys(streamMap).length > 0) {
          console.log(`[RMC:${this.logId}][handleWebRTCAnswer] sending relay-stream-map to ${message.from.slice(-8)} after renegotiation:`, streamMap);
          this.mediaHandler.sendRelayStreamMap(message.from, peerConnection, streamMap);
        }
      }
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

      // Queue ICE candidates if remote description is not set yet
      if (!peerConnection.remoteDescription) {
        console.log('[RelayMeshClient] Queueing ICE candidate - remote description not set yet');
        if (!this.pendingIceCandidates.has(message.from)) {
          this.pendingIceCandidates.set(message.from, []);
        }
        this.pendingIceCandidates.get(message.from)!.push(message.candidate);
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
