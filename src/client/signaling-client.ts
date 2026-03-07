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
  ParticipantMetrics,
} from '../shared/types';
import { EventEmitter } from 'events';

/**
 * Configuration for SignalingClient
 * 
 * Task 14.3, Requirement 12.2: TLS encryption for signaling
 * Task 14.7, Requirement 12.4: Participant authentication
 */
export interface SignalingClientConfig {
  serverUrl: string; // Should use wss:// for secure WebSocket (Requirement 12.2)
  participantId: string;
  participantName: string;
  reconnectIntervalMs?: number; // default: 3000
  maxReconnectAttempts?: number; // default: 10
  // Enforce secure WebSocket (wss://) - reject ws:// connections (Requirement 12.2)
  enforceSecureConnection?: boolean; // default: true in production
  // Authentication token (Requirement 12.4)
  authToken?: string;
}

/**
 * Connection state for the signaling client
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed',
}

/**
 * Message handler type for different message types
 */
type MessageHandler<T extends SignalingMessage> = (message: T) => void;

/**
 * SignalingClient manages WebSocket connection to the signaling server
 * and handles message routing for topology updates, metrics, and WebRTC signaling.
 * 
 * Requirements: 10.1, 10.6
 */
export class SignalingClient extends EventEmitter {
  private config: SignalingClientConfig;
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private messageQueue: string[] = [];
  
  // Message handlers
  private topologyUpdateHandlers: MessageHandler<TopologyUpdateMessage>[] = [];
  private metricsBroadcastHandlers: MessageHandler<MetricsBroadcastMessage>[] = [];
  private webrtcOfferHandlers: MessageHandler<WebRTCOfferMessage>[] = [];
  private webrtcAnswerHandlers: MessageHandler<WebRTCAnswerMessage>[] = [];
  private iceCandidateHandlers: MessageHandler<ICECandidateMessage>[] = [];
  private relayAssignmentHandlers: MessageHandler<RelayAssignmentMessage>[] = [];
  private joinResponseHandlers: Array<(topology: ConnectionTopology) => void> = [];
  
  // Connection state handlers
  private connectionStateHandlers: Array<(state: ConnectionState) => void> = [];

  constructor(config: SignalingClientConfig) {
    super();
    this.config = {
      reconnectIntervalMs: 3000,
      maxReconnectAttempts: 10,
      enforceSecureConnection: true, // Default to enforcing secure connections (Requirement 12.2)
      ...config,
    };
  }

  /**
   * Connect to the signaling server
   * Requirement 10.1, 10.6, 12.2
   * 
   * Task 14.3: Enforces secure WebSocket (wss://) connections when configured
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connectionState === ConnectionState.CONNECTED) {
        resolve();
        return;
      }

      // Enforce secure WebSocket connection (Requirement 12.2)
      if (this.config.enforceSecureConnection && !this.config.serverUrl.startsWith('wss://')) {
        reject(new Error(
          'Secure connection is enforced but server URL does not use wss://. ' +
          'Set enforceSecureConnection: false only for development/testing.'
        ));
        return;
      }

      // Warn if using insecure connection
      if (!this.config.serverUrl.startsWith('wss://')) {
        console.warn(
          'WARNING: Connecting to signaling server WITHOUT TLS encryption (ws://). ' +
          'This should only be used for development/testing!'
        );
      }

      this.setConnectionState(ConnectionState.CONNECTING);

      try {
        this.ws = new WebSocket(this.config.serverUrl);

        this.ws.onopen = () => {
          this.setConnectionState(ConnectionState.CONNECTED);
          this.reconnectAttempts = 0;
          
          // Send queued messages
          this.flushMessageQueue();
          
          // Emit connected event
          this.emit('connected');
          
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = () => {
          this.handleDisconnection();
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          if (this.connectionState === ConnectionState.CONNECTING) {
            reject(new Error('Failed to connect to signaling server'));
          }
        };
      } catch (error) {
        this.setConnectionState(ConnectionState.FAILED);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the signaling server
   * Requirement 10.6
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setConnectionState(ConnectionState.DISCONNECTED);
    this.reconnectAttempts = 0;
    this.messageQueue = [];
  }

  /**
   * Handle WebSocket disconnection and attempt reconnection
   * Requirement 10.6
   */
  private handleDisconnection(): void {
    if (this.connectionState === ConnectionState.DISCONNECTED) {
      return; // Intentional disconnect, don't reconnect
    }

    this.ws = null;
    
    // Emit disconnected event
    this.emit('disconnected');

    // Attempt reconnection if within retry limit
    if (this.reconnectAttempts < (this.config.maxReconnectAttempts || 10)) {
      this.setConnectionState(ConnectionState.RECONNECTING);
      this.reconnectAttempts++;

      const delay = (this.config.reconnectIntervalMs || 3000) * Math.min(this.reconnectAttempts, 5);
      
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch((error) => {
          console.error('Reconnection failed:', error);
        });
      }, delay);
    } else {
      this.setConnectionState(ConnectionState.FAILED);
    }
  }

  /**
   * Send a message to the signaling server
   * Queues messages if not connected
   * Requirement 10.1, 10.6
   */
  private sendMessage(message: SignalingMessage): void {
    const messageStr = JSON.stringify(message);

    if (this.ws && this.connectionState === ConnectionState.CONNECTED) {
      this.ws.send(messageStr);
    } else {
      // Queue message for later delivery
      this.messageQueue.push(messageStr);
    }
  }

  /**
   * Flush queued messages when connection is established
   */
  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.ws && this.connectionState === ConnectionState.CONNECTED) {
      const message = this.messageQueue.shift();
      if (message) {
        this.ws.send(message);
      }
    }
  }

  /**
   * Handle incoming message from signaling server
   * Dispatches to appropriate handlers
   * Requirement 10.1, 10.6
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as SignalingMessage;
      
      // Emit generic message event
      this.emit('message', message);

      switch (message.type) {
        case 'join-response':
          this.handleJoinResponse(message as any);
          break;
        case 'topology-update':
          this.dispatchToHandlers(this.topologyUpdateHandlers, message as TopologyUpdateMessage);
          break;
        case 'metrics-broadcast':
          this.dispatchToHandlers(this.metricsBroadcastHandlers, message as MetricsBroadcastMessage);
          break;
        case 'webrtc-offer':
          this.dispatchToHandlers(this.webrtcOfferHandlers, message as WebRTCOfferMessage);
          break;
        case 'webrtc-answer':
          this.dispatchToHandlers(this.webrtcAnswerHandlers, message as WebRTCAnswerMessage);
          break;
        case 'ice-candidate':
          this.dispatchToHandlers(this.iceCandidateHandlers, message as ICECandidateMessage);
          break;
        case 'relay-assignment':
          this.dispatchToHandlers(this.relayAssignmentHandlers, message as RelayAssignmentMessage);
          break;
        default:
          console.warn('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  /**
   * Handle join response from server
   */
  private handleJoinResponse(message: { topology: ConnectionTopology }): void {
    this.joinResponseHandlers.forEach((handler) => {
      try {
        handler(message.topology);
      } catch (error) {
        console.error('Error in join response handler:', error);
      }
    });
  }

  /**
   * Dispatch message to registered handlers
   */
  private dispatchToHandlers<T extends SignalingMessage>(
    handlers: MessageHandler<T>[],
    message: T
  ): void {
    handlers.forEach((handler) => {
      try {
        handler(message);
      } catch (error) {
        console.error('Error in message handler:', error);
      }
    });
  }

  /**
   * Set connection state and notify handlers
   */
  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.connectionStateHandlers.forEach((handler) => {
      try {
        handler(state);
      } catch (error) {
        console.error('Error in connection state handler:', error);
      }
    });
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if connected to signaling server
   */
  isConnected(): boolean {
    return this.connectionState === ConnectionState.CONNECTED;
  }

  /**
   * Check if using secure WebSocket connection (Task 14.3)
   * 
   * @returns True if using wss:// (TLS encrypted)
   * 
   * Requirement 12.2: All signaling messages must be encrypted using TLS
   */
  isSecureConnection(): boolean {
    return this.config.serverUrl.startsWith('wss://');
  }

  /**
   * Get connection info (Task 14.3)
   * Useful for monitoring and diagnostics
   * 
   * @returns Object with connection details
   */
  /**
     * Get connection info (Task 14.3, 14.7)
     * Useful for monitoring and diagnostics
     * 
     * @returns Object with connection details
     */
    getConnectionInfo(): {
      serverUrl: string;
      isSecure: boolean;
      hasAuthToken: boolean;
      connectionState: ConnectionState;
      reconnectAttempts: number;
      queuedMessages: number;
    } {
      return {
        serverUrl: this.config.serverUrl,
        isSecure: this.isSecureConnection(),
        hasAuthToken: this.config.authToken !== undefined,
        connectionState: this.connectionState,
        reconnectAttempts: this.reconnectAttempts,
        queuedMessages: this.messageQueue.length,
      };
    }

  /**
   * Register handler for connection state changes
   */
  onConnectionStateChange(handler: (state: ConnectionState) => void): void {
    this.connectionStateHandlers.push(handler);
  }

  /**
   * Register handler for join responses
   */
  onJoinResponse(handler: (topology: ConnectionTopology) => void): void {
    this.joinResponseHandlers.push(handler);
  }

  /**
   * Register handler for topology updates
   * Requirement 10.1
   */
  onTopologyUpdate(handler: MessageHandler<TopologyUpdateMessage>): void {
    this.topologyUpdateHandlers.push(handler);
  }

  /**
   * Register handler for metrics broadcasts
   * Requirement 2.7, 3.9
   */
  onMetricsBroadcast(handler: MessageHandler<MetricsBroadcastMessage>): void {
    this.metricsBroadcastHandlers.push(handler);
  }

  /**
   * Register handler for WebRTC offers
   */
  onWebRTCOffer(handler: MessageHandler<WebRTCOfferMessage>): void {
    this.webrtcOfferHandlers.push(handler);
  }

  /**
   * Register handler for WebRTC answers
   */
  onWebRTCAnswer(handler: MessageHandler<WebRTCAnswerMessage>): void {
    this.webrtcAnswerHandlers.push(handler);
  }

  /**
   * Register handler for ICE candidates
   */
  onICECandidate(handler: MessageHandler<ICECandidateMessage>): void {
    this.iceCandidateHandlers.push(handler);
  }

  /**
   * Register handler for relay assignments
   */
  onRelayAssignment(handler: MessageHandler<RelayAssignmentMessage>): void {
    this.relayAssignmentHandlers.push(handler);
  }

  /**
   * Send join message to server
   * Requirement 10.2, 12.4
   * 
   * Task 14.7: Includes authentication credentials
   */
  sendJoin(conferenceId: string, participantId: string, participantName: string): void {
    const message: JoinMessage = {
      type: 'join',
      from: participantId,
      timestamp: Date.now(),
      conferenceId,
      participantInfo: {
        id: participantId,
        name: participantName,
      },
      // Include authentication if token is provided (Requirement 12.4)
      auth: this.config.authToken ? {
        token: this.config.authToken,
        timestamp: Date.now(),
      } : undefined,
    };
    this.sendMessage(message);
  }

  /**
   * Send topology update to server
   * Requirement 10.1
   */
  sendTopologyUpdate(
    topology: ConnectionTopology,
    reason: 'relay-selection' | 'participant-join' | 'participant-leave' | 'relay-failure'
  ): void {
    const message: TopologyUpdateMessage = {
      type: 'topology-update',
      from: this.config.participantId,
      timestamp: Date.now(),
      topology,
      reason,
    };
    this.sendMessage(message);
  }

  /**
   * Broadcast metrics to other participants
   * Requirement 2.7, 3.9
   */
  broadcastMetrics(metrics: ParticipantMetrics): void {
    const message: MetricsBroadcastMessage = {
      type: 'metrics-broadcast',
      from: this.config.participantId,
      timestamp: Date.now(),
      metrics,
    };
    console.log('[SignalingClient] Broadcasting metrics:', this.config.participantId);
    this.sendMessage(message);
  }

  /**
   * Send WebRTC offer to another participant
   * Requirement 10.4
   */
  sendWebRTCOffer(to: string, offer: RTCSessionDescriptionInit): void {
    const message: WebRTCOfferMessage = {
      type: 'webrtc-offer',
      from: this.config.participantId,
      timestamp: Date.now(),
      to,
      offer,
    };
    this.sendMessage(message);
  }

  /**
   * Send WebRTC answer to another participant
   * Requirement 10.5
   */
  sendWebRTCAnswer(to: string, answer: RTCSessionDescriptionInit): void {
    const message: WebRTCAnswerMessage = {
      type: 'webrtc-answer',
      from: this.config.participantId,
      timestamp: Date.now(),
      to,
      answer,
    };
    this.sendMessage(message);
  }

  /**
   * Send ICE candidate to another participant
   * Requirement 10.5
   */
  sendICECandidate(to: string, candidate: RTCIceCandidateInit): void {
    const message: ICECandidateMessage = {
      type: 'ice-candidate',
      from: this.config.participantId,
      timestamp: Date.now(),
      to,
      candidate,
    };
    this.sendMessage(message);
  }

  /**
   * Send relay assignment message
   * Requirement 10.3
   */
  sendRelayAssignment(assignedRelayId: string, role: 'relay' | 'regular'): void {
    const message: RelayAssignmentMessage = {
      type: 'relay-assignment',
      from: this.config.participantId,
      timestamp: Date.now(),
      assignedRelayId,
      role,
    };
    this.sendMessage(message);
  }


  /**
   * Update authentication token (Task 14.7)
   * Allows updating the token without recreating the client
   *
   * @param token - New authentication token
   *
   * Requirement 12.4: Authentication required before conference operations
   */
  setAuthToken(token: string): void {
    this.config.authToken = token;
  }

  /**
   * Send leave message to server
   */
  sendLeave(participantId: string): Promise<void> {
    return new Promise((resolve) => {
      const message: SignalingMessage = {
        type: 'leave',
        from: participantId,
        timestamp: Date.now(),
      };
      
      if (this.ws && this.connectionState === ConnectionState.CONNECTED) {
        this.ws.send(JSON.stringify(message));
        // Give the message time to be sent
        setTimeout(resolve, 50);
      } else {
        resolve();
      }
    });
  }

  /**
   * Check if client has authentication token (Task 14.7)
   *
   * @returns True if authentication token is set
   */
  hasAuthToken(): boolean {
    return this.config.authToken !== undefined && this.config.authToken.length > 0;
  }

}
