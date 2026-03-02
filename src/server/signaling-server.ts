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
} from '../shared/types';

/**
 * Configuration for the signaling server
 */
export interface SignalingServerConfig {
  port: number;
  tlsOptions?: {
    key: Buffer;
    cert: Buffer;
  };
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

  constructor(config: SignalingServerConfig) {
    this.config = config;
  }

  /**
   * Start the signaling server
   * Requirement 10.1, 10.2, 10.6, 12.2
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP or HTTPS server based on TLS configuration
        if (this.config.tlsOptions) {
          this.server = https.createServer(this.config.tlsOptions);
        } else {
          this.server = http.createServer();
        }

        // Create WebSocket server
        this.wss = new WebSocketServer({ server: this.server });

        // Handle new connections
        this.wss.on('connection', (ws: WebSocket) => {
          this.handleConnection(ws);
        });

        // Start listening
        this.server.listen(this.config.port, () => {
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
      // Close all participant connections
      this.participants.forEach((participant) => {
        participant.ws.close();
      });
      this.participants.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close(() => {
          // Close HTTP/HTTPS server
          if (this.server) {
            this.server.close(() => {
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else {
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
      return;
    }

    const conferenceId = participant.conferenceId;
    this.participants.delete(participantId);

    // Update conference state
    const conference = this.conferences.get(conferenceId);
    if (conference) {
      conference.participants.delete(participantId);

      // If conference is empty, remove it
      if (conference.participants.size === 0) {
        this.conferences.delete(conferenceId);
      }
    }
  }

  /**
   * Handle incoming signaling message
   * Routes messages to appropriate handlers
   * Requirement 10.1, 10.4, 10.5, 10.6
   */
  private handleMessage(ws: WebSocket, message: SignalingMessage): void {
    switch (message.type) {
      case 'join':
        this.handleJoin(ws, message as JoinMessage);
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
      default:
        console.warn('Unknown message type:', message.type);
    }
  }

  /**
   * Handle participant join
   * Requirement 10.2
   */
  private handleJoin(ws: WebSocket, message: JoinMessage): void {
    const { conferenceId, participantInfo } = message;
    const participantId = participantInfo.id;

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
      conference = this.createConference(conferenceId);
      this.conferences.set(conferenceId, conference);
    }

    // Send current topology to joining participant
    const response = {
      type: 'join-response',
      topology: conference.topology,
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
      return;
    }

    // Broadcast to all other participants in the conference
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
    this.participants.forEach((participant) => {
      if (
        participant.conferenceId === conferenceId &&
        participant.id !== excludeParticipantId &&
        participant.ws.readyState === WebSocket.OPEN
      ) {
        participant.ws.send(JSON.stringify(message));
      }
    });
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
}
