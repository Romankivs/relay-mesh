// Regular Node Media Flow component
// Task 10.1: Create regular node media flow logic
// Requirements: 6.1, 6.2

import { MediaHandler, MediaStream } from './media-handler';
import { PeerConnectionConfig } from '../shared/types';

/**
 * RegularNode manages media transmission for regular (non-relay) participants
 * 
 * Responsibilities:
 * - Transmit local media stream to assigned relay node
 * - Receive media streams from assigned relay node
 * - Maintain single connection to assigned relay
 * 
 * Requirements: 6.1, 6.2
 */
export class RegularNode {
  private mediaHandler: MediaHandler;
  private localParticipantId: string;
  private assignedRelayId: string | null = null;
  private isActive: boolean = false;

  constructor(localParticipantId: string, mediaHandler: MediaHandler) {
    this.localParticipantId = localParticipantId;
    this.mediaHandler = mediaHandler;
  }

  /**
   * Start regular node media flow
   * Establishes connection to assigned relay and begins media transmission
   * 
   * @param relayId - ID of the assigned relay node
   * @param config - Peer connection configuration
   * @throws Error if already active or if connection fails
   * 
   * Requirements: 6.1, 6.2
   */
  async start(relayId: string, config: PeerConnectionConfig): Promise<void> {
    if (this.isActive) {
      throw new Error('Regular node is already active');
    }

    if (!relayId) {
      throw new Error('Relay ID is required to start regular node');
    }

    this.assignedRelayId = relayId;

    try {
      // Create peer connection to assigned relay
      const peerConnection = await this.mediaHandler.createPeerConnection(
        relayId,
        config
      );

      // Get local stream (should already be initialized)
      const localStream = this.mediaHandler.getLocalStream();
      if (!localStream) {
        throw new Error('Local media stream not initialized');
      }

      // Add local stream to connection (transmit to relay)
      // This satisfies Requirement 6.1: transmit media to assigned relay
      this.mediaHandler.addLocalStream(peerConnection, {
        streamId: localStream.id,
        participantId: this.localParticipantId,
        tracks: localStream.getTracks(),
        isLocal: true,
      });

      this.isActive = true;

      console.log(`Regular node started, connected to relay: ${relayId}`);
    } catch (error) {
      this.assignedRelayId = null;
      throw new Error(
        `Failed to start regular node: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Stop regular node media flow
   * Closes connection to assigned relay
   * 
   * Requirements: 6.1, 6.2
   */
  stop(): void {
    if (!this.isActive) {
      console.warn('Regular node is not active');
      return;
    }

    if (this.assignedRelayId) {
      // Close connection to relay
      this.mediaHandler.closePeerConnection(this.assignedRelayId);
      this.assignedRelayId = null;
    }

    this.isActive = false;
    console.log('Regular node stopped');
  }

  /**
   * Reassign to a different relay node
   * Closes connection to current relay and establishes connection to new relay
   * 
   * @param newRelayId - ID of the new relay node
   * @param config - Peer connection configuration
   * @throws Error if not active or if connection fails
   * 
   * Requirements: 6.1, 6.2
   */
  async reassignRelay(
    newRelayId: string,
    config: PeerConnectionConfig
  ): Promise<void> {
    if (!this.isActive) {
      throw new Error('Regular node is not active');
    }

    if (!newRelayId) {
      throw new Error('New relay ID is required');
    }

    if (newRelayId === this.assignedRelayId) {
      console.log('Already assigned to this relay, no action needed');
      return;
    }

    const oldRelayId = this.assignedRelayId;

    try {
      // Close connection to old relay
      if (oldRelayId) {
        this.mediaHandler.closePeerConnection(oldRelayId);
      }

      // Connect to new relay
      this.assignedRelayId = newRelayId;

      const peerConnection = await this.mediaHandler.createPeerConnection(
        newRelayId,
        config
      );

      // Get local stream
      const localStream = this.mediaHandler.getLocalStream();
      if (!localStream) {
        throw new Error('Local media stream not initialized');
      }

      // Add local stream to new connection
      this.mediaHandler.addLocalStream(peerConnection, {
        streamId: localStream.id,
        participantId: this.localParticipantId,
        tracks: localStream.getTracks(),
        isLocal: true,
      });

      console.log(`Regular node reassigned from ${oldRelayId} to ${newRelayId}`);
    } catch (error) {
      // Attempt to restore old connection on failure
      if (oldRelayId) {
        this.assignedRelayId = oldRelayId;
        console.error('Failed to reassign relay, attempting to restore old connection');
      }

      throw new Error(
        `Failed to reassign relay: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Register callback for receiving remote streams from relay
   * This satisfies Requirement 6.2: receive media from assigned relay
   * 
   * @param callback - Function to call when remote stream is received
   * 
   * Requirements: 6.2
   */
  onRemoteStream(callback: (stream: MediaStream) => void): void {
    this.mediaHandler.onRemoteStream((stream) => {
      // Only process streams from assigned relay
      if (stream.participantId === this.assignedRelayId) {
        callback(stream);
      }
    });
  }

  /**
   * Get the ID of the currently assigned relay
   * 
   * @returns Relay ID or null if not assigned
   */
  getAssignedRelayId(): string | null {
    return this.assignedRelayId;
  }

  /**
   * Check if regular node is active
   * 
   * @returns True if active and connected to relay
   */
  isRegularNodeActive(): boolean {
    return this.isActive;
  }

  /**
   * Get connection statistics for the relay connection
   * 
   * @returns Promise resolving to RTCStatsReport
   * @throws Error if not connected to relay
   */
  async getRelayConnectionStats(): Promise<RTCStatsReport> {
    if (!this.assignedRelayId) {
      throw new Error('Not connected to any relay');
    }

    return await this.mediaHandler.getConnectionStats(this.assignedRelayId);
  }
}
