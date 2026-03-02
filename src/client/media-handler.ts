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
  private localParticipantId: string;

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
   * Create peer connection to another participant (Task 8.2)
   * Configures ICE servers and transport policy
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

    // Create RTCPeerConnection with provided configuration
    const peerConnection = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceTransportPolicy: config.iceTransportPolicy,
    });

    // Set up event handlers for the peer connection
    this.setupPeerConnectionHandlers(peerConnection, remoteParticipantId);

    // Store the peer connection
    this.peerConnections.set(remoteParticipantId, peerConnection);

    return peerConnection;
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
    this.localStream.getTracks().forEach((track) => {
      this.localStream && peerConnection.addTrack(track, this.localStream);
    });
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
    }
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

    // Clear callbacks
    this.remoteStreamCallbacks = [];
  }

  /**
   * Set up event handlers for peer connection (Task 8.5)
   * Handles remote streams and connection state changes
   * 
   * @param peerConnection - The peer connection to set up
   * @param remoteParticipantId - ID of the remote participant
   */
  private setupPeerConnectionHandlers(
    peerConnection: RTCPeerConnection,
    remoteParticipantId: string
  ): void {
    // Handle incoming tracks (remote streams)
    peerConnection.ontrack = (event) => {
      const remoteStream = event.streams[0];

      if (remoteStream) {
        const mediaStream: MediaStream = {
          streamId: remoteStream.id,
          participantId: remoteParticipantId,
          tracks: remoteStream.getTracks(),
          isLocal: false,
        };

        // Notify all registered callbacks
        this.remoteStreamCallbacks.forEach((callback) => {
          callback(mediaStream);
        });
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;

      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        console.warn(
          `Peer connection to ${remoteParticipantId} state changed to: ${state}`
        );
      }
    };

    // Handle ICE connection state changes
    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;

      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        console.warn(
          `ICE connection to ${remoteParticipantId} state changed to: ${state}`
        );
      }
    };
  }
}
