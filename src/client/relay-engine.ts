// Relay Engine component
// Manages media packet forwarding for relay nodes

/**
 * RelayRoute defines the forwarding configuration for media packets
 */
export interface RelayRoute {
  sourceParticipantId: string;
  destinationParticipantIds: string[];
}

/**
 * RelayStats tracks relay node performance metrics
 */
export interface RelayStats {
  packetsReceived: number;
  packetsForwarded: number;
  packetsDropped: number;
  averageForwardingLatencyMs: number;
  currentLoad: number; // 0-1
}

/**
 * RTCRtpPacket represents a media packet (simplified interface)
 * In a real implementation, this would be the actual RTP packet structure
 */
export interface RTCRtpPacket {
  payload: ArrayBuffer;
  timestamp: number;
  sequenceNumber: number;
  ssrc: number;
}

/**
 * ForwardingTable maps source participant IDs to destination participant IDs
 */
interface ForwardingTable {
  incomingFromRegular: Set<string>; // Regular nodes in my group
  outgoingToRelays: Set<string>; // Other relay nodes
  incomingFromRelays: Set<string>; // Other relay nodes
  outgoingToRegular: Set<string>; // Regular nodes in my group
}

/**
 * RelayEngine manages media packet forwarding for relay nodes
 * 
 * Responsibilities:
 * - Start/stop relay functionality
 * - Configure routing tables for packet forwarding
 * - Forward media packets to appropriate destinations
 * - Track relay statistics and performance
 * 
 * Requirements: 5.1, 5.2, 5.4, 5.5, 14.5
 */
export class RelayEngine {
  private isActive: boolean = false;
  private forwardingTable: ForwardingTable = {
    incomingFromRegular: new Set(),
    outgoingToRelays: new Set(),
    incomingFromRelays: new Set(),
    outgoingToRegular: new Set(),
  };

  // Statistics tracking
  private stats: RelayStats = {
    packetsReceived: 0,
    packetsForwarded: 0,
    packetsDropped: 0,
    averageForwardingLatencyMs: 0,
    currentLoad: 0,
  };

  // For calculating average latency
  private latencySum: number = 0;
  private latencyCount: number = 0;

  // Peer connections for forwarding (injected from outside)
  private peerConnections: Map<string, RTCPeerConnection> = new Map();

  constructor() {}

  /**
   * Start relay functionality (Task 9.1)
   * Activates the relay engine to begin forwarding packets
   * 
   * Requirements: 5.1, 5.2
   */
  startRelay(): void {
    if (this.isActive) {
      console.warn('Relay engine is already active');
      return;
    }

    this.isActive = true;
    console.log('Relay engine started');
  }

  /**
   * Stop relay functionality (Task 9.1)
   * Deactivates the relay engine and stops forwarding packets
   * 
   * Requirements: 5.1, 5.2
   */
  stopRelay(): void {
    if (!this.isActive) {
      console.warn('Relay engine is not active');
      return;
    }

    this.isActive = false;
    console.log('Relay engine stopped');
  }

  /**
   * Configure routing table for media forwarding (Task 9.1)
   * Sets up forwarding rules based on topology
   * 
   * @param incomingFromRegular - Regular nodes in my group (sources)
   * @param outgoingToRelays - Other relay nodes (destinations for regular node packets)
   * @param incomingFromRelays - Other relay nodes (sources)
   * @param outgoingToRegular - Regular nodes in my group (destinations for relay packets)
   * 
   * Requirements: 5.1, 5.2
   */
  configureRoutes(
    incomingFromRegular: string[],
    outgoingToRelays: string[],
    incomingFromRelays: string[],
    outgoingToRegular: string[]
  ): void {
    // Clear existing routes
    this.forwardingTable.incomingFromRegular.clear();
    this.forwardingTable.outgoingToRelays.clear();
    this.forwardingTable.incomingFromRelays.clear();
    this.forwardingTable.outgoingToRegular.clear();

    // Configure new routes
    incomingFromRegular.forEach((id) => this.forwardingTable.incomingFromRegular.add(id));
    outgoingToRelays.forEach((id) => this.forwardingTable.outgoingToRelays.add(id));
    incomingFromRelays.forEach((id) => this.forwardingTable.incomingFromRelays.add(id));
    outgoingToRegular.forEach((id) => this.forwardingTable.outgoingToRegular.add(id));

    console.log('Relay routes configured:', {
      incomingFromRegular: incomingFromRegular.length,
      outgoingToRelays: outgoingToRelays.length,
      incomingFromRelays: incomingFromRelays.length,
      outgoingToRegular: outgoingToRegular.length,
    });
  }

  /**
   * Forward media packet based on source and configured routes (Task 9.2)
   * 
   * Forwarding logic:
   * - If packet from regular node in my group: forward to all other relay nodes
   * - If packet from another relay node: forward to all regular nodes in my group
   * 
   * @param packet - The RTP packet to forward
   * @param sourceId - ID of the participant who sent the packet
   * 
   * Requirements: 5.1, 5.2, 5.4
   */
  forwardPacket(packet: RTCRtpPacket, sourceId: string): void {
    if (!this.isActive) {
      console.warn('Relay engine is not active, dropping packet');
      this.stats.packetsDropped++;
      return;
    }

    const startTime = performance.now();
    this.stats.packetsReceived++;

    let destinations: string[] = [];

    // Determine destinations based on source
    if (this.forwardingTable.incomingFromRegular.has(sourceId)) {
      // Packet from regular node in my group -> forward to other relay nodes
      destinations = Array.from(this.forwardingTable.outgoingToRelays);
    } else if (this.forwardingTable.incomingFromRelays.has(sourceId)) {
      // Packet from another relay node -> forward to regular nodes in my group
      destinations = Array.from(this.forwardingTable.outgoingToRegular);
    } else {
      // Unknown source, drop packet
      console.warn(`Received packet from unknown source: ${sourceId}`);
      this.stats.packetsDropped++;
      return;
    }

    // Forward to all destinations
    let forwardedCount = 0;
    for (const destId of destinations) {
      const success = this.sendPacketToPeer(destId, packet);
      if (success) {
        forwardedCount++;
      } else {
        this.stats.packetsDropped++;
      }
    }

    this.stats.packetsForwarded += forwardedCount;

    // Update latency statistics
    const latency = performance.now() - startTime;
    this.latencySum += latency;
    this.latencyCount++;
    this.stats.averageForwardingLatencyMs = this.latencySum / this.latencyCount;

    // Update load (simplified: based on packets per second)
    // In a real implementation, this would be more sophisticated
    this.updateLoad();
  }

  /**
   * Get relay statistics (Task 9.5)
   * Returns current performance metrics
   * 
   * @returns Current relay statistics
   * 
   * Requirements: 5.5, 14.5
   */
  getRelayStats(): RelayStats {
    return { ...this.stats };
  }

  /**
   * Reset relay statistics
   * Useful for testing or periodic resets
   */
  resetStats(): void {
    this.stats = {
      packetsReceived: 0,
      packetsForwarded: 0,
      packetsDropped: 0,
      averageForwardingLatencyMs: 0,
      currentLoad: 0,
    };
    this.latencySum = 0;
    this.latencyCount = 0;
  }

  /**
   * Check if relay is active
   * 
   * @returns True if relay is currently active
   */
  isRelayActive(): boolean {
    return this.isActive;
  }

  /**
   * Get current forwarding table configuration
   * Useful for debugging and testing
   * 
   * @returns Current forwarding table
   */
  getForwardingTable(): ForwardingTable {
    return {
      incomingFromRegular: new Set(this.forwardingTable.incomingFromRegular),
      outgoingToRelays: new Set(this.forwardingTable.outgoingToRelays),
      incomingFromRelays: new Set(this.forwardingTable.incomingFromRelays),
      outgoingToRegular: new Set(this.forwardingTable.outgoingToRegular),
    };
  }

  /**
   * Set peer connections for forwarding
   * This is called externally to provide the actual WebRTC connections
   * 
   * @param connections - Map of participant IDs to peer connections
   */
  setPeerConnections(connections: Map<string, RTCPeerConnection>): void {
    this.peerConnections = connections;
  }

  /**
   * Send packet to a specific peer (Task 9.2)
   * In a real implementation, this would use RTCRtpSender or data channels
   * 
   * @param peerId - ID of the peer to send to
   * @param packet - The packet to send
   * @returns True if packet was sent successfully
   * 
   * Requirements: 5.1, 5.2, 5.4
   */
  private sendPacketToPeer(peerId: string, packet: RTCRtpPacket): boolean {
    const connection = this.peerConnections.get(peerId);

    if (!connection) {
      console.warn(`No peer connection found for: ${peerId}`);
      return false;
    }

    // Check connection state
    if (connection.connectionState !== 'connected') {
      console.warn(`Peer connection to ${peerId} is not connected: ${connection.connectionState}`);
      return false;
    }

    // In a real implementation, we would send the packet via:
    // 1. RTCRtpSender for media packets (requires insertable streams API)
    // 2. RTCDataChannel for control packets
    // 
    // For now, we simulate successful sending
    // The actual packet forwarding would happen at the WebRTC layer
    
    return true;
  }

  /**
   * Update current load metric (Task 9.5)
   * Calculates load based on forwarding activity
   * 
   * Requirements: 5.5, 14.5
   */
  private updateLoad(): void {
    // Simplified load calculation
    // In a real implementation, this would consider:
    // - Packets per second
    // - Bandwidth usage
    // - CPU usage
    // - Number of active streams
    
    const totalPackets = this.stats.packetsReceived;
    const forwardingRatio = totalPackets > 0 
      ? this.stats.packetsForwarded / totalPackets 
      : 0;

    // Load is a combination of forwarding ratio and absolute packet count
    // Normalized to 0-1 range
    const packetLoad = Math.min(totalPackets / 10000, 1.0); // Assume 10k packets = full load
    this.stats.currentLoad = (forwardingRatio * 0.5) + (packetLoad * 0.5);
  }
}
