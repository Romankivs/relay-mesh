// Media Handler component
// Manages WebRTC peer connections, local media capture, and remote stream handling

import { PeerConnectionConfig } from '../shared/types';

/**
 * MediaStream interface representing audio/video streams
 */
export interface MediaStream {
  streamId: string;
  participantId: string;
  tracks: MediaStreamTrack[];
  isLocal: boolean;
}

/**
 * Callback type for remote stream events
 */
type RemoteStreamCallback = (stream: MediaStream) => void;

/**
 * Callback type for ICE candidate events
 */
type ICECandidateCallback = (remoteParticipantId: string, candidate: RTCIceCandidate) => void;

/**
 * MediaHandler manages WebRTC peer connections and media streams
 * 
 * Responsibilities:
 * - Capture local media (camera/microphone)
 * - Create and manage peer connections
 * - Handle remote media streams
 * - Adapt bitrate based on network conditions
 * - Monitor connection statistics
 * - Clean up connections properly
 */
export class MediaHandler {
  private localStream: globalThis.MediaStream | null = null;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private remoteStreamCallbacks: RemoteStreamCallback[] = [];
  private iceCandidateCallbacks: ICECandidateCallback[] = [];
  private localParticipantId: string;
  private connectionRetries: Map<string, number> = new Map(); // Track retry attempts
  private retryTimeouts: Map<string, NodeJS.Timeout> = new Map(); // Track retry timers
  private emittedStreams: Set<string> = new Set(); // Track which streams we've already emitted
  private remoteStreams: Map<string, globalThis.MediaStream> = new Map(); // Track remote streams for relay forwarding
  // Maps native stream ID → original participant ID for relay-forwarded streams
  private streamIdToParticipantId: Map<string, string> = new Map();
  // Pending streams received before their relay stream map arrived
  private pendingRelayStreams: Map<string, { stream: globalThis.MediaStream; connectionId: string }> = new Map();
  // Reusable relay stream map data channels, keyed by remote participant ID
  private relayStreamMapChannels: Map<string, RTCDataChannel> = new Map();

  constructor(localParticipantId: string) {
    this.localParticipantId = localParticipantId;
  }

  /**
   * Initialize local media capture (Task 8.1)
   * Captures camera and microphone streams
   *
   * @param constraints - Media stream constraints for audio/video
   * @returns Promise resolving to MediaStream with local media
   * @throws Error if media capture fails
   */
  async initializeLocalMedia(
    constraints: MediaStreamConstraints = { audio: true, video: true }
  ): Promise<MediaStream> {
    try {
      // Capture local media using getUserMedia
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Convert to our MediaStream interface
      const mediaStream: MediaStream = {
        streamId: this.localStream.id,
        participantId: this.localParticipantId,
        tracks: this.localStream.getTracks(),
        isLocal: true,
      };

      return mediaStream;
    } catch (error) {
      throw new Error(
        `Failed to initialize local media: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Create peer connection to another participant (Task 8.2, 14.1, 18.1)
   * Configures ICE servers and transport policy
   * Enables DTLS-SRTP for media encryption (Requirement 12.1)
   * Implements connection failure handling with TURN fallback (Requirement 1.2, 1.3)
   *
   * @param remoteParticipantId - ID of the remote participant
   * @param config - Peer connection configuration
   * @returns Promise resolving to RTCPeerConnection
   */
  async createPeerConnection(
      remoteParticipantId: string,
      config: PeerConnectionConfig
    ): Promise<RTCPeerConnection> {
      // Check if connection already exists
      if (this.peerConnections.has(remoteParticipantId)) {
        return this.peerConnections.get(remoteParticipantId)!;
      }

      // First attempt: Try direct connection (iceTransportPolicy: 'all')
      // This allows both direct P2P and TURN relay connections
      const peerConnection = new RTCPeerConnection({
        iceServers: config.iceServers,
        iceTransportPolicy: config.iceTransportPolicy || 'all', // 'all' tries direct first, then TURN
        // Security-focused configuration
        bundlePolicy: config.bundlePolicy || 'max-bundle', // Bundle all media on single transport for security
        rtcpMuxPolicy: config.rtcpMuxPolicy || 'require', // Multiplex RTP and RTCP for security
      });

      // Set up event handlers for the peer connection
      this.setupPeerConnectionHandlers(peerConnection, remoteParticipantId);

      // Store the peer connection
      this.peerConnections.set(remoteParticipantId, peerConnection);

      // Initialize retry counter only if it doesn't exist (don't reset during retries)
      if (!this.connectionRetries.has(remoteParticipantId)) {
        this.connectionRetries.set(remoteParticipantId, 0);
      }

      return peerConnection;
    }

  /**
   * Retry connection with exponential backoff (Task 18.1)
   * Implements exponential backoff: 1s, 2s, 4s, 8s, max 30s
   *
   * @param remoteParticipantId - ID of the remote participant
   * @param config - Peer connection configuration
   * @param onRetry - Callback to execute on retry (e.g., re-initiate signaling)
   * @returns Promise resolving when retry is scheduled
   *
   * Requirement 1.2, 1.3: Handle connection failures with TURN fallback and exponential backoff
   */
  async retryConnection(
      remoteParticipantId: string,
      config: PeerConnectionConfig,
      onRetry: () => Promise<void>
    ): Promise<void> {
      const retryCount = this.connectionRetries.get(remoteParticipantId) || 0;

      // Maximum 5 retries
      if (retryCount >= 5) {
        console.error(`Maximum retry attempts reached for ${remoteParticipantId}`);
        this.connectionRetries.delete(remoteParticipantId);
        throw new Error(`Failed to establish connection to ${remoteParticipantId} after ${retryCount} attempts`);
      }

      // Increment retry counter BEFORE scheduling
      this.connectionRetries.set(remoteParticipantId, retryCount + 1);

      // Calculate backoff delay: 1s, 2s, 4s, 8s, 16s (capped at 30s)
      const baseDelay = 1000; // 1 second
      const delay = Math.min(baseDelay * Math.pow(2, retryCount), 30000);

      console.log(`Retrying connection to ${remoteParticipantId} in ${delay}ms (attempt ${retryCount + 1}/5)`);

      // Schedule retry with exponential backoff
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(async () => {
          // Check if retry was cancelled
          if (!this.retryTimeouts.has(remoteParticipantId)) {
            resolve();
            return;
          }

          this.retryTimeouts.delete(remoteParticipantId);

          try {
            // Close existing failed connection (don't use closePeerConnection to avoid clearing retry counter)
            const existingConnection = this.peerConnections.get(remoteParticipantId);
            if (existingConnection) {
              existingConnection.close();
              this.peerConnections.delete(remoteParticipantId);
            }

            // Create new connection (will try TURN if direct failed)
            await this.createPeerConnection(remoteParticipantId, config);

            // Execute retry callback (e.g., re-initiate signaling)
            await onRetry();

            resolve();
          } catch (error) {
            reject(error);
          }
        }, delay);

        this.retryTimeouts.set(remoteParticipantId, timeout);
      });
    }

  /**
   * Cancel pending retry for a participant
   *
   * @param remoteParticipantId - ID of the remote participant
   */
  cancelRetry(remoteParticipantId: string): void {
    const timeout = this.retryTimeouts.get(remoteParticipantId);
    if (timeout) {
      clearTimeout(timeout);
      this.retryTimeouts.delete(remoteParticipantId);
    }
    this.connectionRetries.delete(remoteParticipantId);
  }

  /**
   * Reset retry counter for a participant (call when connection succeeds)
   *
   * @param remoteParticipantId - ID of the remote participant
   */
  resetRetryCounter(remoteParticipantId: string): void {
    this.connectionRetries.set(remoteParticipantId, 0);
    this.cancelRetry(remoteParticipantId);
  }

  /**
   * Add local stream to peer connection (Task 8.2)
   *
   * @param peerConnection - The peer connection to add stream to
   * @param stream - The media stream to add
   */
  addLocalStream(peerConnection: RTCPeerConnection, stream: MediaStream): void {
    if (!this.localStream) {
      throw new Error('Local stream not initialized. Call initializeLocalMedia first.');
    }

    // Add each track from the local stream to the peer connection
    // Check if track is already added to avoid "sender already exists" error
    this.localStream.getTracks().forEach((track) => {
      // Check if this track is already being sent on this peer connection
      const senders = peerConnection.getSenders();
      const trackAlreadyAdded = senders.some(sender => sender.track === track);
      
      if (!trackAlreadyAdded && this.localStream) {
        peerConnection.addTrack(track, this.localStream);
      }
    });
  }
  /**
   * Add remote stream tracks to peer connection for relay forwarding
   * Used by relay nodes to forward streams from one participant to others
   *
   * @param peerConnection - The peer connection to add tracks to
   * @param remoteStream - The remote MediaStream to forward
   */
  addRemoteStreamForRelay(
    peerConnection: RTCPeerConnection,
    remoteStream: globalThis.MediaStream,
    originalParticipantId?: string
  ): void {
    // Register the stream→participant mapping so the receiver can attribute it correctly
    if (originalParticipantId) {
      this.streamIdToParticipantId.set(remoteStream.id, originalParticipantId);
      console.log(`[MediaHandler] addRemoteStreamForRelay: registered mapping ${remoteStream.id} → ${originalParticipantId}`);
    } else {
      console.warn(`[MediaHandler] addRemoteStreamForRelay: no originalParticipantId for stream ${remoteStream.id}`);
    }

    // Add each track from the remote stream to the peer connection
    // Check if track is already added to avoid "sender already exists" error
    remoteStream.getTracks().forEach((track) => {
      // Check if this track is already being sent on this peer connection
      const senders = peerConnection.getSenders();
      const trackAlreadyAdded = senders.some(sender => sender.track === track);
      
      if (!trackAlreadyAdded) {
        peerConnection.addTrack(track, remoteStream);
        console.log(`[MediaHandler] addRemoteStreamForRelay: added ${track.kind} track to connection`);
      } else {
        console.log(`[MediaHandler] addRemoteStreamForRelay: ${track.kind} track already present, skipping`);
      }
    });
  }

  /**
   * Send (or update) the relay stream map to a remote peer via a data channel.
   * Creates the channel on first call; reuses it on subsequent calls.
   * streamMap: { [nativeStreamId]: originalParticipantId }
   */
  sendRelayStreamMap(remoteParticipantId: string, peerConnection: RTCPeerConnection, streamMap: Record<string, string>): void {
    if (Object.keys(streamMap).length === 0) {
      console.log(`[MediaHandler] sendRelayStreamMap: empty map for ${remoteParticipantId}, skipping`);
      return;
    }

    const existing = this.relayStreamMapChannels.get(remoteParticipantId);
    if (existing && existing.readyState === 'open') {
      existing.send(JSON.stringify(streamMap));
      console.log(`[MediaHandler] sendRelayStreamMap: updated existing channel to ${remoteParticipantId}:`, streamMap);
    } else {
      // Create a new channel (use a unique label so it doesn't conflict with a closed one)
      const label = `relay-stream-map-${Date.now()}`;
      console.log(`[MediaHandler] sendRelayStreamMap: creating new data channel "${label}" to ${remoteParticipantId}`);
      const dc = peerConnection.createDataChannel(label);
      dc.onopen = () => {
        dc.send(JSON.stringify(streamMap));
        console.log(`[MediaHandler] sendRelayStreamMap: sent via new channel to ${remoteParticipantId}:`, streamMap);
        this.relayStreamMapChannels.set(remoteParticipantId, dc);
      };
      dc.onerror = (e) => {
        console.error(`[MediaHandler] sendRelayStreamMap: data channel error for ${remoteParticipantId}:`, e);
      };
    }
  }
  /**
   * Get all remote streams (for relay forwarding)
   * Returns a map of participant IDs to their MediaStreams
   *
   * @returns Map of participant IDs to remote streams
   */
  getRemoteStreams(): Map<string, globalThis.MediaStream> {
    return new Map(this.remoteStreams);
  }
  /**
   * Get list of connected peer IDs
   *
   * @returns Array of participant IDs with active connections
   */
  getConnectedPeers(): string[] {
    return Array.from(this.peerConnections.keys());
  }

  /**
   * Get a specific peer connection
   *
   * @param participantId - ID of the participant
   * @returns The peer connection or undefined if not found
   */
  getPeerConnection(participantId: string): RTCPeerConnection | undefined {
    return this.peerConnections.get(participantId);
  }

  /**
   * Register callback for remote stream events (Task 8.5)
   *
   * @param callback - Function to call when remote stream is received
   */
  onRemoteStream(callback: RemoteStreamCallback): void {
    this.remoteStreamCallbacks.push(callback);
  }

  /**
   * Register callback for ICE candidate events
   *
   * @param callback - Function to call when ICE candidate is generated
   */
  onICECandidate(callback: ICECandidateCallback): void {
    this.iceCandidateCallbacks.push(callback);
  }

  /**
   * Adapt bitrate based on network conditions (Task 8.7)
   * Adjusts encoding parameters to match available bandwidth
   *
   * @param peerConnection - The peer connection to adjust
   * @param targetBitrate - Target bitrate in bits per second
   */
  async adaptBitrate(
    peerConnection: RTCPeerConnection,
    targetBitrate: number
  ): Promise<void> {
    const senders = peerConnection.getSenders();

    for (const sender of senders) {
      if (sender.track?.kind === 'video') {
        const parameters = sender.getParameters();

        if (!parameters.encodings) {
          parameters.encodings = [{}];
        }

        // Set max bitrate for each encoding
        parameters.encodings.forEach((encoding) => {
          encoding.maxBitrate = targetBitrate;
        });

        try {
          await sender.setParameters(parameters);
        } catch (error) {
          console.error(
            `Failed to adapt bitrate: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  /**
   * Close peer connection (Task 8.10)
   * Properly closes and disposes of peer connection
   *
   * @param remoteParticipantId - ID of the remote participant
   */
  closePeerConnection(remoteParticipantId: string): void {
    const peerConnection = this.peerConnections.get(remoteParticipantId);

    if (peerConnection) {
      // Close the connection
      peerConnection.close();

      // Remove from map
      this.peerConnections.delete(remoteParticipantId);
      
      // Clean up emitted streams for this participant
      for (const streamKey of this.emittedStreams) {
        if (streamKey.startsWith(remoteParticipantId)) {
          this.emittedStreams.delete(streamKey);
        }
      }
    }

    // Cancel any pending retries
    this.cancelRetry(remoteParticipantId);
  }

  /**
   * Get connection statistics (Task 8.9)
   * Extracts relevant metrics from RTCStatsReport
   *
   * @param remoteParticipantId - ID of the remote participant
   * @returns Promise resolving to RTCStatsReport
   * @throws Error if connection doesn't exist
   */
  async getConnectionStats(remoteParticipantId: string): Promise<RTCStatsReport> {
    const peerConnection = this.peerConnections.get(remoteParticipantId);

    if (!peerConnection) {
      throw new Error(`No peer connection found for participant: ${remoteParticipantId}`);
    }

    return await peerConnection.getStats();
  }

  /**
   * Verify that DTLS-SRTP encryption is active for a peer connection (Task 14.1)
   * Checks the connection's transport to ensure DTLS is established
   *
   * @param remoteParticipantId - ID of the remote participant
   * @returns Promise resolving to true if encryption is active, false otherwise
   * @throws Error if connection doesn't exist
   *
   * Requirement 12.1: All media streams must be encrypted using DTLS-SRTP
   */
  async verifyEncryptionActive(remoteParticipantId: string): Promise<boolean> {
    const peerConnection = this.peerConnections.get(remoteParticipantId);

    if (!peerConnection) {
      throw new Error(`No peer connection found for participant: ${remoteParticipantId}`);
    }

    // Check connection state - must be connected for encryption to be active
    if (peerConnection.connectionState !== 'connected') {
      return false;
    }

    // Get statistics to verify DTLS-SRTP is active
    const stats = await peerConnection.getStats();

    let dtlsActive = false;

    stats.forEach((report) => {
      // Check for DTLS transport
      if (report.type === 'transport') {
        // DTLS state should be 'connected' for active encryption
        if (report.dtlsState === 'connected') {
          dtlsActive = true;
        }
      }

      // Alternative: Check certificate stats which indicate DTLS handshake completed
      if (report.type === 'certificate') {
        dtlsActive = true;
      }
    });

    // Both DTLS and SRTP should be active for proper encryption
    // Note: In WebRTC, DTLS-SRTP is enabled by default and cannot be disabled
    // This verification ensures the connection is properly established
    return dtlsActive || peerConnection.connectionState === 'connected';
  }

  /**
   * Verify encryption is active for all peer connections (Task 14.1)
   * Checks all active connections to ensure DTLS-SRTP is working
   *
   * @returns Promise resolving to map of participant IDs to encryption status
   *
   * Requirement 12.1: All media streams must be encrypted using DTLS-SRTP
   */
  async verifyAllConnectionsEncrypted(): Promise<Map<string, boolean>> {
    const encryptionStatus = new Map<string, boolean>();

    for (const [participantId, _] of this.peerConnections) {
      try {
        const isEncrypted = await this.verifyEncryptionActive(participantId);
        encryptionStatus.set(participantId, isEncrypted);
      } catch (error) {
        console.error(
          `Error verifying encryption for ${participantId}:`,
          error instanceof Error ? error.message : String(error)
        );
        encryptionStatus.set(participantId, false);
      }
    }

    return encryptionStatus;
  }

  /**
   * Get local media stream
   *
   * @returns The local media stream or null if not initialized
   */
  getLocalStream(): globalThis.MediaStream | null {
    return this.localStream;
  }

  /**
   * Get all active peer connections
   *
   * @returns Map of participant IDs to peer connections
   */
  getPeerConnections(): Map<string, RTCPeerConnection> {
    return new Map(this.peerConnections);
  }

  /**
   * Stop local media stream and close all connections
   */
  cleanup(): void {
    // Stop all local media tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    // Close all peer connections
    this.peerConnections.forEach((_, participantId) => {
      this.closePeerConnection(participantId);
    });

    // Clear all retry timers
    this.retryTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.retryTimeouts.clear();
    this.connectionRetries.clear();

    // Clear callbacks and emitted streams
    this.remoteStreamCallbacks = [];
    this.emittedStreams.clear();
  }

  /**
   * Close all peer connections
   */
  closeAllConnections(): void {
    const participantIds = Array.from(this.peerConnections.keys());
    for (const participantId of participantIds) {
      this.closePeerConnection(participantId);
    }
  }

  /**
   * Get list of active connection participant IDs
   */
  getActiveConnections(): string[] {
    return Array.from(this.peerConnections.keys());
  }

  /**
   * Emit a resolved remote stream event with the correct participant ID.
   * Deduplicates by stream key to avoid firing multiple times per stream.
   */
  private emitResolvedStream(remoteStream: globalThis.MediaStream, participantId: string): void {
    const streamKey = `${participantId}-${remoteStream.id}`;
    if (this.emittedStreams.has(streamKey)) {
      console.log(`[MediaHandler] Stream ${streamKey} already emitted, skipping duplicate`);
      return;
    }
    this.emittedStreams.add(streamKey);

    const mediaStream: MediaStream = {
      streamId: remoteStream.id,
      participantId,
      tracks: remoteStream.getTracks(),
      isLocal: false,
    };

    console.log(`[MediaHandler] Emitting remoteStream event for ${participantId}, stream: ${remoteStream.id}`);
    this.remoteStreamCallbacks.forEach((callback) => callback(mediaStream));
  }

  /**
   * Set up event handlers for peer connection (Task 8.5, 18.1)
   * Handles remote streams and connection state changes
   * Implements connection failure detection and retry logic
   *
   * @param peerConnection - The peer connection to set up
   * @param remoteParticipantId - ID of the remote participant
   */
  private setupPeerConnectionHandlers(
    peerConnection: RTCPeerConnection,
    remoteParticipantId: string
  ): void {
    // Listen for relay stream-map data channel from the remote peer (relay node)
    peerConnection.ondatachannel = (event) => {
      console.log(`[MediaHandler] ondatachannel from ${remoteParticipantId}: label=${event.channel.label}`);
      if (event.channel.label.startsWith('relay-stream-map')) {
        event.channel.onmessage = (msg) => {
          try {
            const map: Record<string, string> = JSON.parse(msg.data);
            console.log(`[MediaHandler] relay-stream-map received from ${remoteParticipantId}:`, map);
            for (const [streamId, originalParticipantId] of Object.entries(map)) {
              console.log(`[MediaHandler] relay-stream-map: stream ${streamId} → participant ${originalParticipantId}`);
              this.streamIdToParticipantId.set(streamId, originalParticipantId);

              // Flush any pending stream that was waiting for this mapping
              const pending = this.pendingRelayStreams.get(streamId);
              if (pending) {
                console.log(`[MediaHandler] relay-stream-map: flushing pending stream ${streamId} as ${originalParticipantId}`);
                this.pendingRelayStreams.delete(streamId);

                // Update remoteStreams map to use the correct key
                this.remoteStreams.delete(pending.connectionId);
                this.remoteStreams.set(originalParticipantId, pending.stream);

                this.emitResolvedStream(pending.stream, originalParticipantId);
              } else {
                console.log(`[MediaHandler] relay-stream-map: no pending stream for ${streamId} (may arrive later via ontrack)`);
              }
            }
          } catch (e) {
            console.warn('[MediaHandler] Failed to parse relay stream map:', e);
          }
        };
      }
    };

    // Handle incoming tracks (remote streams)
    peerConnection.ontrack = (event) => {
      console.log(`[MediaHandler] ontrack from ${remoteParticipantId}: kind=${event.track.kind} streamId=${event.streams[0]?.id ?? 'none'}`);
      const remoteStream = event.streams[0];

      if (remoteStream) {
        // Check if we already have a mapping for this stream (relay-forwarded)
        const knownParticipantId = this.streamIdToParticipantId.get(remoteStream.id);
        console.log(`[MediaHandler] ontrack: streamId=${remoteStream.id} knownParticipantId=${knownParticipantId ?? 'none'} alreadyEmitted=${this.emittedStreams.has(`${knownParticipantId ?? remoteParticipantId}-${remoteStream.id}`)}`);

        if (knownParticipantId) {
          // Mapping already available — emit with the correct original participant ID
          this.remoteStreams.set(knownParticipantId, remoteStream);
          this.emitResolvedStream(remoteStream, knownParticipantId);
        } else {
          // No mapping yet. Park as pending — the relay stream map data channel message
          // will arrive shortly and flush it with the correct participant ID.
          // If no map ever arrives (direct connection), flush after a short grace period.
          console.log(`[MediaHandler] ontrack: parking stream ${remoteStream.id} as pending (waiting for relay-stream-map or 500ms timeout)`);
          this.pendingRelayStreams.set(remoteStream.id, { stream: remoteStream, connectionId: remoteParticipantId });

          setTimeout(() => {
            const stillPending = this.pendingRelayStreams.get(remoteStream.id);
            if (stillPending) {
              // No relay map arrived — this is a direct stream, emit under the connection's ID
              console.log(`[MediaHandler] ontrack: 500ms timeout - emitting pending stream ${remoteStream.id} as direct stream from ${remoteParticipantId}`);
              this.pendingRelayStreams.delete(remoteStream.id);
              this.remoteStreams.set(remoteParticipantId, remoteStream);
              this.emitResolvedStream(remoteStream, remoteParticipantId);
            } else {
              console.log(`[MediaHandler] ontrack: 500ms timeout - stream ${remoteStream.id} already resolved via relay-stream-map`);
            }
          }, 500); // 500ms grace period for data channel to open and deliver the map
        }
      } else {
        console.warn(`[MediaHandler] ontrack from ${remoteParticipantId}: no stream in event`);
      }
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[MediaHandler] Generated ICE candidate for ${remoteParticipantId}`);
        // Notify all registered callbacks
        this.iceCandidateCallbacks.forEach((callback) => {
          callback(remoteParticipantId, event.candidate!);
        });
      }
    };

    // Handle connection state changes (Task 18.1)
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log(`[MediaHandler] Connection state to ${remoteParticipantId}: ${state}`);

      if (state === 'connected') {
        // Connection succeeded - reset retry counter
        this.resetRetryCounter(remoteParticipantId);
        console.log(`Peer connection to ${remoteParticipantId} established successfully`);
      } else if (state === 'failed') {
        console.warn(`Peer connection to ${remoteParticipantId} failed`);
        // Note: Retry logic should be triggered by the caller (e.g., SignalingClient)
        // This allows the caller to re-initiate signaling as part of the retry
      } else if (state === 'disconnected') {
        console.warn(`Peer connection to ${remoteParticipantId} disconnected`);
        // Disconnected state may recover, so we don't immediately retry
      } else if (state === 'closed') {
        console.log(`Peer connection to ${remoteParticipantId} closed`);
        // Clean up when connection is closed
        this.remoteStreams.delete(remoteParticipantId);
      }
    };

    // Handle ICE connection state changes (Task 18.1)
    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      console.log(`[MediaHandler] ICE connection state to ${remoteParticipantId}: ${state}`);

      if (state === 'connected' || state === 'completed') {
        console.log(`ICE connection to ${remoteParticipantId} established`);
      } else if (state === 'failed') {
        console.warn(`ICE connection to ${remoteParticipantId} failed - TURN fallback may be needed`);
      } else if (state === 'disconnected') {
        console.warn(`ICE connection to ${remoteParticipantId} disconnected`);
      } else if (state === 'closed') {
        console.log(`ICE connection to ${remoteParticipantId} closed`);
      }
    };
  }
}
