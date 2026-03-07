// Unit tests for SignalingClient edge cases
// Task 13.5: Write unit tests for signaling client edge cases
// Requirements: 10.1, 10.2, 10.6

import { SignalingClient, ConnectionState } from './signaling-client';
import {
  TopologyUpdateMessage,
  MetricsBroadcastMessage,
  ParticipantMetrics,
  NATType,
  ConnectionTopology,
} from '../shared/types';
import WS from 'jest-websocket-mock';

describe('SignalingClient - Edge Cases', () => {
  let server: WS | null;
  let client: SignalingClient;
  const serverUrl = 'ws://localhost:1234';

  beforeEach(() => {
    server = new WS(serverUrl);
    client = new SignalingClient({
      serverUrl,
      participantId: 'test-participant',
      participantName: 'Test Participant',
      reconnectIntervalMs: 100,
      maxReconnectAttempts: 3,
      enforceSecureConnection: false, // Allow ws:// for testing
    });
  });

  afterEach(() => {
    client.disconnect();
    if (server) {
      server.close();
      server = null;
    }
    WS.clean();
  });

  describe('WebSocket disconnection and reconnection', () => {
    it('should detect disconnection and attempt reconnection', async () => {
      // Connect initially
      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(client.getConnectionState()).toBe(ConnectionState.CONNECTED);

      // Track connection state changes
      const stateChanges: ConnectionState[] = [];
      client.onConnectionStateChange((state) => {
        stateChanges.push(state);
      });

      // Simulate server disconnection
      if (server) {
        server.close();
      }

      // Wait for reconnection state
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(client.getConnectionState()).toBe(ConnectionState.RECONNECTING);
      expect(stateChanges).toContain(ConnectionState.RECONNECTING);
    });

    it('should successfully reconnect after disconnection', async () => {
      // Connect initially
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Simulate server disconnection
      if (server) {
        server.close();
        server = null;
      }

      // Wait for reconnection attempt
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(client.getConnectionState()).toBe(ConnectionState.RECONNECTING);

      // Create new server instance for reconnection
      server = new WS(serverUrl);

      // Wait for reconnection to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(client.getConnectionState()).toBe(ConnectionState.CONNECTED);
      expect(client.isConnected()).toBe(true);
    });

    it('should fail after max reconnection attempts', async () => {
      // Connect initially
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Track connection state changes
      const stateChanges: ConnectionState[] = [];
      client.onConnectionStateChange((state) => {
        stateChanges.push(state);
      });

      // Simulate server disconnection without bringing it back
      if (server) {
        server.close();
      }

      // Wait for all reconnection attempts to fail
      // With reconnectIntervalMs=100 and exponential backoff, this should take ~600ms
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(client.getConnectionState()).toBe(ConnectionState.FAILED);
      expect(stateChanges).toContain(ConnectionState.FAILED);
    });

    it('should not attempt reconnection after intentional disconnect', async () => {
      // Connect initially
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Track connection state changes
      const stateChanges: ConnectionState[] = [];
      client.onConnectionStateChange((state) => {
        stateChanges.push(state);
      });

      // Intentionally disconnect
      client.disconnect();

      // Wait to ensure no reconnection attempt
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(client.getConnectionState()).toBe(ConnectionState.DISCONNECTED);
      expect(stateChanges).not.toContain(ConnectionState.RECONNECTING);
    });

    it('should reset reconnection attempts after successful connection', async () => {
      // Connect initially
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Simulate disconnection and reconnection
      if (server) {
        server.close();
        server = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      
      // Create new server for reconnection
      server = new WS(serverUrl);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(client.getConnectionState()).toBe(ConnectionState.CONNECTED);

      // Disconnect again - should have reset attempts
      if (server) {
        server.close();
        server = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(client.getConnectionState()).toBe(ConnectionState.RECONNECTING);
    });
  });

  describe('Message buffering during disconnection', () => {
    it('should queue messages when disconnected', async () => {
      // Don't connect yet
      expect(client.isConnected()).toBe(false);

      // Send messages while disconnected
      client.sendJoin('test-conference', 'test-participant', 'Test User');
      client.broadcastMetrics({
        participantId: 'test-participant',
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
        natType: NATType.FULL_CONE,
        latency: { averageRttMs: 50, minRttMs: 40, maxRttMs: 60, measurements: new Map() },
        stability: { packetLossPercent: 0.5, jitterMs: 10, connectionUptime: 100, reconnectionCount: 0 },
        device: { cpuUsagePercent: 30, availableMemoryMB: 2048, supportedCodecs: ['VP8', 'H264'], hardwareAcceleration: true },
      });

      // Connect and verify messages are sent
      const connectPromise = client.connect();
      if (server) {
        await server.connected;
      }
      await connectPromise;

      // Wait for messages to be flushed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify messages were sent
      const messages = server?.messages || [];
      expect(messages.length).toBe(2);
      
      const joinMessage = JSON.parse(messages[0] as string);
      expect(joinMessage.type).toBe('join');
      expect(joinMessage.conferenceId).toBe('test-conference');

      const metricsMessage = JSON.parse(messages[1] as string);
      expect(metricsMessage.type).toBe('metrics-broadcast');
    });

    it('should flush queued messages after reconnection', async () => {
      // Connect initially
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Clear initial messages
      if (server) {
        server.messages.length = 0;
      }

      // Simulate disconnection
      if (server) {
        server.close();
        server = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send messages while disconnected
      client.sendJoin('test-conference', 'test-participant', 'Test User');
      client.sendWebRTCOffer('peer1', { type: 'offer', sdp: 'test-sdp' });

      // Create new server for reconnection
      server = new WS(serverUrl);
      
      // Wait for reconnection and message flush
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify queued messages were sent after reconnection
      const messages = server?.messages || [];
      expect(messages.length).toBeGreaterThanOrEqual(2);
      
      const joinMessage = JSON.parse(messages[0] as string);
      expect(joinMessage.type).toBe('join');

      const offerMessage = JSON.parse(messages[1] as string);
      expect(offerMessage.type).toBe('webrtc-offer');
    });

    it('should clear message queue on intentional disconnect', async () => {
      // Connect initially
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Disconnect
      client.disconnect();
      if (server) {
        server.close();
        server = null;
      }

      // Send messages while disconnected
      client.sendJoin('test-conference', 'test-participant', 'Test User');

      // Reconnect with new server
      server = new WS(serverUrl);
      await client.connect();

      // Wait for potential message flush
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Message queue should have been cleared on disconnect
      // Only new messages after reconnect would be sent
      expect(server?.messages.length || 0).toBe(0);
    });

    it('should maintain message order in queue', async () => {
      // Don't connect yet
      expect(client.isConnected()).toBe(false);

      // Send multiple messages in specific order
      client.sendJoin('test-conference', 'test-participant', 'Test User');
      client.sendWebRTCOffer('peer1', { type: 'offer', sdp: 'offer-1' });
      client.sendWebRTCAnswer('peer2', { type: 'answer', sdp: 'answer-1' });
      client.sendICECandidate('peer3', { candidate: 'candidate-1' });

      // Connect and verify message order
      const connectPromise = client.connect();
      if (server) {
        await server.connected;
      }
      await connectPromise;

      await new Promise((resolve) => setTimeout(resolve, 50));

      const messages = server?.messages || [];
      expect(messages.length).toBe(4);

      expect(JSON.parse(messages[0] as string).type).toBe('join');
      expect(JSON.parse(messages[1] as string).type).toBe('webrtc-offer');
      expect(JSON.parse(messages[2] as string).type).toBe('webrtc-answer');
      expect(JSON.parse(messages[3] as string).type).toBe('ice-candidate');
    });
  });

  describe('Malformed messages', () => {
    it('should handle invalid JSON gracefully', async () => {
      await client.connect();

      // Set up handler to verify it's not called
      let handlerCalled = false;
      client.onTopologyUpdate(() => {
        handlerCalled = true;
      });

      // Send invalid JSON
      server?.send('{ invalid json }');

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Handler should not be called, connection should remain stable
      expect(handlerCalled).toBe(false);
      expect(client.isConnected()).toBe(true);
    });

    it('should handle unknown message types gracefully', async () => {
      await client.connect();

      // Set up handlers
      let topologyHandlerCalled = false;
      client.onTopologyUpdate(() => {
        topologyHandlerCalled = true;
      });

      // Send message with unknown type
      server?.send(JSON.stringify({
        type: 'unknown-message-type',
        from: 'test',
        timestamp: Date.now(),
        data: 'some data',
      }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Handler should not be called, connection should remain stable
      expect(topologyHandlerCalled).toBe(false);
      expect(client.isConnected()).toBe(true);
    });

    it('should handle messages with missing required fields', async () => {
      await client.connect();

      let handlerCalled = false;
      let receivedMessage: TopologyUpdateMessage | null = null;
      
      client.onTopologyUpdate((message) => {
        handlerCalled = true;
        receivedMessage = message;
      });

      // Send topology update with missing fields
      server?.send(JSON.stringify({
        type: 'topology-update',
        from: 'test',
        // Missing timestamp, topology, reason
      }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Handler is called but receives incomplete message
      expect(handlerCalled).toBe(true);
      expect(receivedMessage).toBeDefined();
      expect(client.isConnected()).toBe(true);
    });

    it('should handle messages with incorrect data types', async () => {
      await client.connect();

      let handlerCalled = false;
      client.onMetricsBroadcast(() => {
        handlerCalled = true;
      });

      // Send metrics broadcast with incorrect types
      server?.send(JSON.stringify({
        type: 'metrics-broadcast',
        from: 'test',
        timestamp: 'not-a-number', // Should be number
        metrics: 'not-an-object', // Should be object
      }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Handler is called despite incorrect types
      expect(handlerCalled).toBe(true);
      expect(client.isConnected()).toBe(true);
    });

    it('should handle empty messages', async () => {
      await client.connect();

      // Send empty string
      server?.send('');

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Connection should remain stable
      expect(client.isConnected()).toBe(true);
    });

    it('should handle null or undefined in message fields', async () => {
      await client.connect();

      let handlerCalled = false;
      let receivedMessage: TopologyUpdateMessage | null = null;
      
      client.onTopologyUpdate((message) => {
        handlerCalled = true;
        receivedMessage = message;
      });

      // Send message with null values
      server?.send(JSON.stringify({
        type: 'topology-update',
        from: null,
        timestamp: null,
        topology: null,
        reason: null,
      }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handlerCalled).toBe(true);
      expect(client.isConnected()).toBe(true);
    });

    it('should handle handler errors without crashing', async () => {
      await client.connect();

      // Register handler that throws error
      client.onTopologyUpdate(() => {
        throw new Error('Handler error');
      });

      // Register second handler to verify it still gets called
      let secondHandlerCalled = false;
      client.onTopologyUpdate(() => {
        secondHandlerCalled = true;
      });

      // Send valid message
      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: ['regular1'] }],
        relayConnections: [],
      };

      server?.send(JSON.stringify({
        type: 'topology-update',
        from: 'test',
        timestamp: Date.now(),
        topology,
        reason: 'relay-selection',
      }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Second handler should still be called despite first handler error
      expect(secondHandlerCalled).toBe(true);
      expect(client.isConnected()).toBe(true);
    });
  });

  describe('Connection state management', () => {
    it('should handle multiple connect calls gracefully', async () => {
      await client.connect();
      expect(client.isConnected()).toBe(true);

      // Try to connect again
      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(client.getConnectionState()).toBe(ConnectionState.CONNECTED);
    });

    it('should handle disconnect when not connected', () => {
      expect(client.isConnected()).toBe(false);

      // Should not throw error
      expect(() => client.disconnect()).not.toThrow();
      expect(client.getConnectionState()).toBe(ConnectionState.DISCONNECTED);
    });

    it('should notify all state change handlers', async () => {
      const handler1States: ConnectionState[] = [];
      const handler2States: ConnectionState[] = [];

      client.onConnectionStateChange((state) => handler1States.push(state));
      client.onConnectionStateChange((state) => handler2States.push(state));

      await client.connect();

      expect(handler1States).toContain(ConnectionState.CONNECTING);
      expect(handler1States).toContain(ConnectionState.CONNECTED);
      expect(handler2States).toContain(ConnectionState.CONNECTING);
      expect(handler2States).toContain(ConnectionState.CONNECTED);
    });
  });

  describe('Message handler registration', () => {
    it('should support multiple handlers for same message type', async () => {
      await client.connect();

      let handler1Called = false;
      let handler2Called = false;

      client.onTopologyUpdate(() => { handler1Called = true; });
      client.onTopologyUpdate(() => { handler2Called = true; });

      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: [],
        groups: [],
        relayConnections: [],
      };

      server?.send(JSON.stringify({
        type: 'topology-update',
        from: 'test',
        timestamp: Date.now(),
        topology,
        reason: 'relay-selection',
      }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler1Called).toBe(true);
      expect(handler2Called).toBe(true);
    });

    it('should handle join response correctly', async () => {
      await client.connect();

      let receivedTopology: ConnectionTopology | null = null;
      client.onJoinResponse((topology) => {
        receivedTopology = topology;
      });

      const topology: ConnectionTopology = {
        version: 1,
        timestamp: Date.now(),
        relayNodes: ['relay1'],
        groups: [{ relayNodeId: 'relay1', regularNodeIds: [] }],
        relayConnections: [],
      };

      server?.send(JSON.stringify({
        type: 'join-response',
        topology,
      }));

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedTopology).toEqual(topology);
    });
  });
});
