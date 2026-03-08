import { WebSocketServer, WebSocket } from 'ws';
import * as https from 'https';
import * as http from 'http';
import {
  SignalingMessage,
  JoinMessage,
  TopologyUpdateMessage,
  MetricsBroadcastMessage,
  WebRTCOfferMessage,
  WebRTCAnswerMessage,
  ICECandidateMessage,
  RelayAssignmentMessage,
  ConnectionTopology,
  Conference,
  SelectionConfig,
  ParticipantMetrics,
} from '../shared/types';
import { AuthProvider, AuthCredentials } from '../shared/auth';

/**
 * Configuration for the signaling server
 * 
 * Task 14.3, Requirement 12.2: TLS encryption for signaling
 * Task 14.7, Requirement 12.4: Participant authentication
 */
export interface SignalingServerConfig {
  port: number;
  tlsOptions?: {
    key: Buffer;
    cert: Buffer;
    // Optional: Certificate authority for client certificate verification
    ca?: Buffer;
    // Optional: Request client certificate for mutual TLS
    requestCert?: boolean;
    // Optional: Reject unauthorized clients
    rejectUnauthorized?: boolean;
  };
  // Enforce TLS - reject non-TLS connections (Requirement 12.2)
  enforceTLS?: boolean; // default: true in production
  // Authentication provider (Requirement 12.4)
  authProvider?: AuthProvider;
  // Require authentication for all operations (Requirement 12.4)
  requireAuth?: boolean; // default: true in production
}

/**
 * Connected participant information
 */
interface ConnectedParticipant {
  id: string;
  name: string;
  conferenceId: string;
  ws: WebSocket;
  connectedAt: number;
  metrics?: ParticipantMetrics; // Optional, updated via metrics broadcasts
}

/**
 * SignalingServer handles WebSocket connections and coordinates
 * topology formation, WebRTC signaling, and relay assignments.
 * 
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 12.2
 */
export class SignalingServer {
  private wss: WebSocketServer | null = null;
  private server: http.Server | https.Server | null = null;
  private participants: Map<string, ConnectedParticipant> = new Map();
  private conferences: Map<string, Conference> = new Map();
  private config: SignalingServerConfig;
  private authenticatedParticipants: Set<string> = new Set(); // Track authenticated participants
  private startTime: number = 0; // Track server start time for uptime

  constructor(config: SignalingServerConfig) {
    this.config = {
      enforceTLS: true, // Default to enforcing TLS (Requirement 12.2)
      requireAuth: true, // Default to requiring authentication (Requirement 12.4)
      ...config,
    };
  }

  /**
   * Start the signaling server
   * Requirement 10.1, 10.2, 10.6, 12.2
   * 
   * Task 14.3: Enforces TLS for all WebSocket connections when configured
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Enforce TLS in production (Requirement 12.2)
        if (this.config.enforceTLS && !this.config.tlsOptions) {
          reject(new Error(
            'TLS is enforced but tlsOptions not provided. ' +
            'Set enforceTLS: false only for development/testing.'
          ));
          return;
        }

        // Create HTTP or HTTPS server based on TLS configuration
        if (this.config.tlsOptions) {
          // Create HTTPS server with TLS encryption (Requirement 12.2)
          this.server = https.createServer({
            key: this.config.tlsOptions.key,
            cert: this.config.tlsOptions.cert,
            ca: this.config.tlsOptions.ca,
            requestCert: this.config.tlsOptions.requestCert || false,
            rejectUnauthorized: this.config.tlsOptions.rejectUnauthorized || false,
          }, this.handleHttpRequest.bind(this));
          console.log('Signaling server starting with TLS encryption enabled');
        } else {
          // Create HTTP server (only for development/testing)
          this.server = http.createServer(this.handleHttpRequest.bind(this));
          console.warn(
            'WARNING: Signaling server starting WITHOUT TLS encryption. ' +
            'This should only be used for development/testing!'
          );
        }

        // Create WebSocket server
        this.wss = new WebSocketServer({ server: this.server });

        // Handle new connections
        this.wss.on('connection', (ws: WebSocket) => {
          this.handleConnection(ws);
        });

        // Start listening
        this.server.listen(this.config.port, () => {
          this.startTime = Date.now();
          resolve();
        });

        this.server.on('error', (error) => {
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the signaling server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Set a timeout to force resolve after 5 seconds
      const timeout = setTimeout(() => {
        console.warn('Server stop timeout, forcing close');
        resolve();
      }, 5000);

      // Close all participant connections
      this.participants.forEach((participant) => {
        try {
          participant.ws.terminate(); // Force close instead of graceful close
        } catch (error) {
          // Ignore errors during close
        }
      });
      this.participants.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close(() => {
          // Close HTTP/HTTPS server
          if (this.server) {
            // Force close all connections
            this.server.closeAllConnections?.();
            this.server.close(() => {
              clearTimeout(timeout);
              resolve();
            });
          } else {
            clearTimeout(timeout);
            resolve();
          }
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  /**
   * Handle new WebSocket connection
   * Requirement 10.1, 10.6
   */
  private handleConnection(ws: WebSocket): void {
    let participantId: string | null = null;

    // Handle incoming messages
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as SignalingMessage;
        
        // Store participant ID for cleanup
        if (message.type === 'join') {
          participantId = (message as any).participantInfo.id;
        } else if (message.from) {
          participantId = message.from;
        }

        this.handleMessage(ws, message);
      } catch (error) {
        console.error('Error handling message:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      if (participantId) {
        this.handleDisconnection(participantId);
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  }

  /**
   * Handle participant disconnection
   * Requirement 10.1, 10.6
   */
  private handleDisconnection(participantId: string): void {
    const participant = this.participants.get(participantId);
    if (!participant) {
      console.log('[SignalingServer] Disconnect from unknown participant:', participantId);
      return;
    }

    const conferenceId = participant.conferenceId;
    console.log('[SignalingServer] Participant disconnected:', participantId, 'from conference:', conferenceId);
    
    // Notify other participants before removing
    const leftMessage = {
      type: 'participant-left' as const,
      from: 'server',
      timestamp: Date.now(),
      participantId: participantId,
    };
    this.broadcastToConference(conferenceId, leftMessage, participantId);
    
    this.participants.delete(participantId);
    this.authenticatedParticipants.delete(participantId); // Remove from authenticated set

    // Update conference state
    const conference = this.conferences.get(conferenceId);
    if (conference) {
      conference.participants.delete(participantId);
      console.log('[SignalingServer] Conference', conferenceId, 'now has', conference.participants.size, 'participants');

      // If conference is empty, remove it
      if (conference.participants.size === 0) {
        console.log('[SignalingServer] Conference', conferenceId, 'is empty, removing');
        this.conferences.delete(conferenceId);
      }
    }
  }

  /**
   * Handle incoming signaling message
   * Routes messages to appropriate handlers
   * Requirement 10.1, 10.4, 10.5, 10.6, 12.4
   * 
   * Task 14.7: Verifies authentication before allowing operations
   */
  private handleMessage(ws: WebSocket, message: SignalingMessage): void {
    // Join messages are handled separately (they establish authentication)
    if (message.type === 'join') {
      this.handleJoin(ws, message as JoinMessage);
      return;
    }

    // For all other operations, verify participant is authenticated (Requirement 12.4)
    if (this.config.requireAuth && !this.authenticatedParticipants.has(message.from)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Not authenticated. Please join first.',
        code: 'NOT_AUTHENTICATED',
      }));
      return;
    }

    // Route to appropriate handler
    switch (message.type) {
      case 'leave':
        // Handle explicit leave message
        this.handleDisconnection(message.from);
        ws.close();
        break;
      case 'topology-update':
        this.handleTopologyUpdate(message as TopologyUpdateMessage);
        break;
      case 'metrics-broadcast':
        this.handleMetricsBroadcast(message as MetricsBroadcastMessage);
        break;
      case 'webrtc-offer':
        this.handleWebRTCOffer(message as WebRTCOfferMessage);
        break;
      case 'webrtc-answer':
        this.handleWebRTCAnswer(message as WebRTCAnswerMessage);
        break;
      case 'ice-candidate':
        this.handleICECandidate(message as ICECandidateMessage);
        break;
      case 'relay-assignment':
        this.handleRelayAssignment(message as RelayAssignmentMessage);
        break;
      case 'relay-selection-data':
        this.handleRelaySelectionData(message as any);
        break;
      default:
        console.warn('Unknown message type:', message.type);
    }
  }

  /**
   * Handle participant join
   * Requirement 10.2, 12.4
   * 
   * Task 14.7: Authenticates participant before allowing conference access
   */
  private async handleJoin(ws: WebSocket, message: JoinMessage): Promise<void> {
    const { conferenceId, participantInfo } = message;
    const participantId = participantInfo.id;

    console.log('[SignalingServer] Participant joining:', participantId, 'conference:', conferenceId);

    // Authenticate participant (Requirement 12.4)
    if (this.config.requireAuth) {
      if (!message.auth || !this.config.authProvider) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Authentication required',
          code: 'AUTH_REQUIRED',
        }));
        ws.close();
        return;
      }

      const authCredentials: AuthCredentials = {
        participantId,
        token: message.auth.token,
        timestamp: message.auth.timestamp,
      };

      const authResult = await this.config.authProvider.verify(authCredentials);

      if (!authResult.authenticated) {
        ws.send(JSON.stringify({
          type: 'error',
          message: `Authentication failed: ${authResult.error}`,
          code: 'AUTH_FAILED',
        }));
        ws.close();
        return;
      }

      // Mark participant as authenticated
      this.authenticatedParticipants.add(participantId);
    }

    // Store participant connection
    this.participants.set(participantId, {
      id: participantId,
      name: participantInfo.name,
      conferenceId,
      ws,
      connectedAt: Date.now(),
    });

    // Get or create conference
    let conference = this.conferences.get(conferenceId);
    if (!conference) {
      console.log('[SignalingServer] Creating new conference:', conferenceId);
      conference = this.createConference(conferenceId);
      this.conferences.set(conferenceId, conference);
    }

    // Add participant to conference
    conference.participants.set(participantId, {
      id: participantId,
      name: participantInfo.name,
      role: 'regular', // Will be updated by topology manager
      metrics: {
        participantId,
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 5.0, downloadMbps: 10.0, measurementConfidence: 0.1 },
        natType: 0, // NATType.OPEN
        latency: { averageRttMs: 50, minRttMs: 50, maxRttMs: 50, measurements: new Map() },
        stability: { packetLossPercent: 0, jitterMs: 0, connectionUptime: 0, reconnectionCount: 0 },
        device: { cpuUsagePercent: 0, availableMemoryMB: 0, supportedCodecs: [], hardwareAcceleration: false },
      }, // Will be updated by metrics broadcasts
      connections: new Map(),
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    });

    console.log('[SignalingServer] Conference', conferenceId, 'now has', conference.participants.size, 'participants');

    // Notify other participants about the new joiner
    const joinedMessage = {
      type: 'participant-joined' as const,
      from: 'server',
      timestamp: Date.now(),
      participantId: participantId,
      participantName: participantInfo.name,
    };
    this.broadcastToConference(conferenceId, joinedMessage, participantId);

    // Send current topology and existing participants to joining participant
    const existingParticipants = Array.from(conference.participants.entries())
      .filter(([id, _]) => id !== participantId) // Exclude the joining participant
      .map(([id, participant]) => ({
        participantId: id,
        participantName: participant.name,
      }));

    const response = {
      type: 'join-response',
      topology: conference.topology,
      existingParticipants,
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(response));
  }

  /**
   * Create a new conference with default configuration
   * Requirement 10.2
   */
  private createConference(conferenceId: string): Conference {
    const defaultConfig: SelectionConfig = {
      bandwidthWeight: 0.30,
      natWeight: 0.25,
      latencyWeight: 0.20,
      stabilityWeight: 0.15,
      deviceWeight: 0.10,
      minBandwidthMbps: 5,
      maxParticipantsPerRelay: 5,
      reevaluationIntervalMs: 30000,
    };

    const emptyTopology: ConnectionTopology = {
      version: 0,
      timestamp: Date.now(),
      relayNodes: [],
      groups: [],
      relayConnections: [],
    };

    return {
      id: conferenceId,
      participants: new Map(),
      topology: emptyTopology,
      config: defaultConfig,
      createdAt: Date.now(),
      lastTopologyUpdate: Date.now(),
    };
  }

  /**
   * Handle topology update from a participant
   * Broadcasts to affected participants
   * Requirement 10.1
   */
  private handleTopologyUpdate(message: TopologyUpdateMessage): void {
    const senderId = message.from;
    const participant = this.participants.get(senderId);
    
    if (!participant) {
      return;
    }

    const conference = this.conferences.get(participant.conferenceId);
    if (!conference) {
      return;
    }

    // Update stored topology
    conference.topology = message.topology;
    conference.lastTopologyUpdate = Date.now();

    // Broadcast to all participants in the conference
    this.broadcastToConference(participant.conferenceId, message, senderId);
  }

  /**
   * Handle metrics broadcast from a participant
   * Forwards to other participants in the conference
   * Requirement 10.6
   */
  private handleMetricsBroadcast(message: MetricsBroadcastMessage): void {
    const senderId = message.from;
    const participant = this.participants.get(senderId);
    
    if (!participant) {
      console.warn('[SignalingServer] Metrics broadcast from unknown participant:', senderId);
      return;
    }

    console.log('[SignalingServer] Received metrics broadcast from:', senderId, 'in conference:', participant.conferenceId);
    
    // Store the metrics for monitoring API
    participant.metrics = message.metrics;
    
    // Broadcast to all other participants in the conference
    const conference = this.conferences.get(participant.conferenceId);
    if (conference) {
      const participantCount = conference.participants.size;
      console.log('[SignalingServer] Broadcasting to', participantCount - 1, 'other participants');
    }
    
    this.broadcastToConference(participant.conferenceId, message, senderId);
  }

  /**
   * Handle WebRTC offer
   * Routes to target participant
   * Requirement 10.4
   */
  private handleWebRTCOffer(message: WebRTCOfferMessage): void {
    this.routeToParticipant(message.to, message);
  }

  /**
   * Handle WebRTC answer
   * Routes to target participant
   * Requirement 10.5
   */
  private handleWebRTCAnswer(message: WebRTCAnswerMessage): void {
    this.routeToParticipant(message.to, message);
  }

  /**
   * Handle ICE candidate
   * Routes to target participant
   * Requirement 10.5
   */
  private handleICECandidate(message: ICECandidateMessage): void {
    this.routeToParticipant(message.to, message);
  }

  /**
   * Handle relay assignment
   * Broadcasts to affected participants
   * Requirement 10.3
   */
  private handleRelayAssignment(message: RelayAssignmentMessage): void {
    const senderId = message.from;
    const participant = this.participants.get(senderId);
    
    if (!participant) {
      return;
    }

    // Broadcast to all participants in the conference
    this.broadcastToConference(participant.conferenceId, message, senderId);
  }

  /**
   * Handle relay selection data message
   * Stores relay selection information for monitoring
   */
  private handleRelaySelectionData(message: any): void {
    const conference = this.conferences.get(message.conferenceId);
    if (conference) {
      conference.lastRelaySelection = message.selectionData;
      console.log('📊 Stored relay selection data for conference:', message.conferenceId);
    }
  }


  /**
   * Route message to specific participant
   * Requirement 10.6
   */
  private routeToParticipant(participantId: string, message: SignalingMessage): void {
    const participant = this.participants.get(participantId);
    if (participant && participant.ws.readyState === WebSocket.OPEN) {
      participant.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast message to all participants in a conference
   * Optionally exclude sender
   * Requirement 10.1, 10.6
   */
  private broadcastToConference(
    conferenceId: string,
    message: SignalingMessage,
    excludeParticipantId?: string
  ): void {
    let sentCount = 0;
    this.participants.forEach((participant) => {
      if (
        participant.conferenceId === conferenceId &&
        participant.id !== excludeParticipantId &&
        participant.ws.readyState === WebSocket.OPEN
      ) {
        participant.ws.send(JSON.stringify(message));
        sentCount++;
      }
    });
    
    if (message.type === 'metrics-broadcast') {
      console.log('[SignalingServer] Metrics broadcast sent to', sentCount, 'participants');
    }
  }

  /**
   * Get current topology for a conference
   * Requirement 10.2
   */
  getConferenceTopology(conferenceId: string): ConnectionTopology | null {
    const conference = this.conferences.get(conferenceId);
    return conference ? conference.topology : null;
  }

  /**
   * Get list of connected participants in a conference
   */
  getConferenceParticipants(conferenceId: string): string[] {
    const participantIds: string[] = [];
    this.participants.forEach((participant) => {
      if (participant.conferenceId === conferenceId) {
        participantIds.push(participant.id);
      }
    });
    return participantIds;
  }

  /**
   * Check if a participant is connected
   */
  isParticipantConnected(participantId: string): boolean {
    return this.participants.has(participantId);
  }

  /**
   * Check if TLS encryption is enabled (Task 14.3)
   * 
   * @returns True if server is using TLS encryption
   * 
   * Requirement 12.2: All signaling messages must be encrypted using TLS
   */
  isTLSEnabled(): boolean {
    return this.config.tlsOptions !== undefined;
  }

  /**
   * Get server configuration info (Task 14.3, 14.7)
   * Useful for monitoring and diagnostics
   * 
   * @returns Object with server configuration details
   */
  getServerInfo(): {
    tlsEnabled: boolean;
    enforceTLS: boolean;
    authEnabled: boolean;
    requireAuth: boolean;
    port: number;
    activeConnections: number;
    activeConferences: number;
    authenticatedParticipants: number;
  } {
    return {
      tlsEnabled: this.isTLSEnabled(),
      enforceTLS: this.config.enforceTLS || false,
      authEnabled: this.config.authProvider !== undefined,
      requireAuth: this.config.requireAuth || false,
      port: this.config.port,
      activeConnections: this.participants.size,
      activeConferences: this.conferences.size,
      authenticatedParticipants: this.authenticatedParticipants.size,
    };
  }

  /**
   * Check if a participant is authenticated (Task 14.7)
   * 
   * @param participantId - ID of the participant to check
   * @returns True if participant is authenticated
   * 
   * Requirement 12.4: Authentication required before conference operations
   */
  isParticipantAuthenticated(participantId: string): boolean {
    return this.authenticatedParticipants.has(participantId);
  }

  /**
   * Handle HTTP requests for monitoring API
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Only handle GET requests
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const url = req.url || '/';

    // Route to appropriate handler
    if (url === '/api/monitoring') {
      this.handleMonitoringRequest(res);
    } else if (url === '/api/server-info') {
      this.handleServerInfoRequest(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  /**
   * Handle /api/monitoring request
   */
  private handleMonitoringRequest(res: http.ServerResponse): void {
    try {
      const serverInfo = this.getServerInfo();
      const conferences = this.getConferencesData();
      const participants = this.getParticipantsData();
      const relaySelection = this.getRelaySelectionData();

      const data = {
        serverInfo: {
          activeConferences: serverInfo.activeConferences,
          totalParticipants: serverInfo.activeConnections,
          uptime: Date.now() - this.startTime,
        },
        conferences,
        participants,
        relaySelection,
        events: [
          {
            time: Date.now(),
            message: `Server running - ${serverInfo.activeConferences} conferences, ${serverInfo.activeConnections} participants`,
          },
        ],
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (error) {
      console.error('Error in handleMonitoringRequest:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }

  /**
   * Handle /api/server-info request
   */
  private handleServerInfoRequest(res: http.ServerResponse): void {
    try {
      const info = this.getServerInfo();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Get conferences data for monitoring
   */
  private getConferencesData(): any[] {
    const conferences: any[] = [];

    for (const [conferenceId, conference] of this.conferences.entries()) {
      conferences.push({
        id: conferenceId,
        topology: {
          relayNodes: conference.topology.relayNodes,
          groups: conference.topology.groups,
          relayConnections: conference.topology.relayConnections,
        },
      });
    }

    return conferences;
  }

  /**
   * Get participants data for monitoring
   */
  private getParticipantsData(): any[] {
    const participants: any[] = [];

    for (const [conferenceId, conference] of this.conferences.entries()) {
      // Build a set of relay node IDs from topology
      const relayNodeIds = new Set<string>();
      conference.topology.relayNodes.forEach(id => relayNodeIds.add(id));
      conference.topology.groups.forEach(group => {
        relayNodeIds.add(group.relayNodeId);
      });

      for (const [participantId, participant] of conference.participants.entries()) {
        // Check if metrics exist before accessing
        if (!participant.metrics) {
          continue;
        }

        const metrics = participant.metrics;
        
        // Determine role from topology structure
        const role = relayNodeIds.has(participantId) ? 'relay' : 'regular';

        participants.push({
          id: participantId,
          name: participant.name,
          role: role, // Use topology-derived role
          bandwidth: metrics.bandwidth?.uploadMbps || 0,
          latency: metrics.latency?.averageRttMs || 0,
          packetLoss: metrics.stability?.packetLossPercent || 0,
          quality: this.calculateQuality(metrics),
        });
      }
    }

    return participants;
  }

  /**
   * Calculate connection quality from metrics
   */
  private calculateQuality(metrics: ParticipantMetrics): string {
    // Check if required properties exist
    if (!metrics.latency || !metrics.stability) {
      return 'unknown';
    }

    const { latency, stability } = metrics;

    // Poor: high latency or packet loss
    if (latency.averageRttMs > 200 || stability.packetLossPercent > 3) {
      return 'poor';
    }

    // Warning: moderate issues
    if (latency.averageRttMs > 100 || stability.packetLossPercent > 1) {
      return 'warning';
    }

    // Good: acceptable performance
    return 'good';
  }

  /**
   * Get relay selection data from the most recent conference
   */
  private getRelaySelectionData(): any | null {
    // Get the first conference with relay selection data
    for (const [conferenceId, conference] of this.conferences.entries()) {
      if (conference.lastRelaySelection) {
        return conference.lastRelaySelection;
      }
    }
    return null;
  }
}
