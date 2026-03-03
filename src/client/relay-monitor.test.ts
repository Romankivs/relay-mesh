// Unit tests for Relay Monitor
// Task 18.2: Implement relay failure detection

import { RelayMonitor } from './relay-monitor';
import { MediaHandler } from './media-handler';

// Mock MediaHandler
jest.mock('./media-handler');

describe('RelayMonitor - Task 18.2', () => {
  let monitor: RelayMonitor;
  let mockMediaHandler: jest.Mocked<MediaHandler>;
  let mockPeerConnections: Map<string, RTCPeerConnection>;

  beforeEach(() => {
    // Create mock peer connections map
    mockPeerConnections = new Map();

    // Create mock MediaHandler
    mockMediaHandler = {
      getPeerConnections: jest.fn(() => mockPeerConnections),
    } as any;

    monitor = new RelayMonitor(mockMediaHandler);
    jest.useFakeTimers();
  });

  afterEach(() => {
    monitor.cleanup();
    jest.useRealTimers();
  });

  describe('Relay registration and monitoring', () => {
    it('should register relay nodes for monitoring', () => {
      monitor.registerRelay('relay-1');
      monitor.registerRelay('relay-2');

      const health = monitor.getAllRelayHealth();
      expect(health.size).toBe(2);
      expect(health.has('relay-1')).toBe(true);
      expect(health.has('relay-2')).toBe(true);
    });

    it('should unregister relay nodes from monitoring', () => {
      monitor.registerRelay('relay-1');
      monitor.registerRelay('relay-2');

      monitor.unregisterRelay('relay-1');

      const health = monitor.getAllRelayHealth();
      expect(health.size).toBe(1);
      expect(health.has('relay-1')).toBe(false);
      expect(health.has('relay-2')).toBe(true);
    });

    it('should start and stop monitoring', () => {
      monitor.startMonitoring();
      // Verify monitoring is active (interval is set)
      expect(monitor['monitoringInterval']).not.toBeNull();

      monitor.stopMonitoring();
      // Verify monitoring is stopped
      expect(monitor['monitoringInterval']).toBeNull();
    });
  });

  describe('Connection health tracking', () => {
    it('should update relay health when connection state changes', () => {
      monitor.registerRelay('relay-1');

      monitor.updateRelayHealth('relay-1', 'connected', 'connected');

      const health = monitor.getRelayHealth('relay-1');
      expect(health?.connectionState).toBe('connected');
      expect(health?.iceConnectionState).toBe('connected');
      expect(health?.consecutiveFailures).toBe(0);
    });

    it('should reset failure counter when connection becomes healthy', () => {
      monitor.registerRelay('relay-1');

      // Simulate some failures
      const health = monitor.getRelayHealth('relay-1');
      if (health) {
        health.consecutiveFailures = 2;
      }

      // Connection becomes healthy
      monitor.updateRelayHealth('relay-1', 'connected', 'connected');

      expect(health?.consecutiveFailures).toBe(0);
    });

    it('should update last seen timestamp when connection is healthy', () => {
      monitor.registerRelay('relay-1');

      const beforeUpdate = Date.now();
      monitor.updateRelayHealth('relay-1', 'connected', 'connected');
      const afterUpdate = Date.now();

      const health = monitor.getRelayHealth('relay-1');
      expect(health?.lastSeen).toBeGreaterThanOrEqual(beforeUpdate);
      expect(health?.lastSeen).toBeLessThanOrEqual(afterUpdate);
    });
  });

  describe('Relay failure detection (Requirement 7.2)', () => {
    it('should detect relay disconnection within 5 seconds', () => {
      // Register relay
      monitor.registerRelay('relay-1');

      // Create mock peer connection in failed state
      const mockPeerConnection = {
        connectionState: 'failed',
        iceConnectionState: 'failed',
      } as RTCPeerConnection;

      mockPeerConnections.set('relay-1', mockPeerConnection);

      // Set up failure callback
      const failureCallback = jest.fn();
      monitor.onRelayFailure(failureCallback);

      // Start monitoring
      monitor.startMonitoring();

      // Advance time by 1 second (first health check)
      jest.advanceTimersByTime(1000);
      expect(failureCallback).not.toHaveBeenCalled(); // Not enough consecutive failures

      // Advance time by 1 second (second health check)
      jest.advanceTimersByTime(1000);
      expect(failureCallback).toHaveBeenCalledWith('relay-1', 'Connection failed');
    });

    it('should detect relay disconnection after 5 seconds of inactivity', () => {
      // Register relay
      monitor.registerRelay('relay-1');

      // Create mock peer connection in disconnected state
      const mockPeerConnection = {
        connectionState: 'disconnected',
        iceConnectionState: 'disconnected',
      } as RTCPeerConnection;

      mockPeerConnections.set('relay-1', mockPeerConnection);

      // Set up failure callback
      const failureCallback = jest.fn();
      monitor.onRelayFailure(failureCallback);

      // Start monitoring
      monitor.startMonitoring();

      // Advance time by 4 seconds - should not trigger failure yet
      jest.advanceTimersByTime(4000);
      expect(failureCallback).not.toHaveBeenCalled();

      // Advance time by 2 more seconds (total 6 seconds) - should trigger failure
      jest.advanceTimersByTime(2000);
      
      // Need 2 consecutive failures, so advance one more second
      jest.advanceTimersByTime(1000);
      
      expect(failureCallback).toHaveBeenCalledWith(
        'relay-1',
        'Connection disconnected for > 5 seconds'
      );
    });

    it('should not trigger failure if connection recovers before threshold', () => {
      // Register relay
      monitor.registerRelay('relay-1');

      // Create mock peer connection in disconnected state (mutable)
      const mockPeerConnection: any = {
        connectionState: 'disconnected',
        iceConnectionState: 'disconnected',
      };

      mockPeerConnections.set('relay-1', mockPeerConnection);

      // Set up failure callback
      const failureCallback = jest.fn();
      monitor.onRelayFailure(failureCallback);

      // Start monitoring
      monitor.startMonitoring();

      // Advance time by 3 seconds
      jest.advanceTimersByTime(3000);

      // Connection recovers
      mockPeerConnection.connectionState = 'connected';
      mockPeerConnection.iceConnectionState = 'connected';

      // Advance time by 3 more seconds
      jest.advanceTimersByTime(3000);

      // Should not have triggered failure
      expect(failureCallback).not.toHaveBeenCalled();
    });

    it('should handle multiple relay failures independently', () => {
      // Register multiple relays
      monitor.registerRelay('relay-1');
      monitor.registerRelay('relay-2');
      monitor.registerRelay('relay-3');

      // Create mock peer connections
      const mockPeerConnection1 = {
        connectionState: 'failed',
        iceConnectionState: 'failed',
      } as RTCPeerConnection;

      const mockPeerConnection2 = {
        connectionState: 'connected',
        iceConnectionState: 'connected',
      } as RTCPeerConnection;

      const mockPeerConnection3 = {
        connectionState: 'failed',
        iceConnectionState: 'failed',
      } as RTCPeerConnection;

      mockPeerConnections.set('relay-1', mockPeerConnection1);
      mockPeerConnections.set('relay-2', mockPeerConnection2);
      mockPeerConnections.set('relay-3', mockPeerConnection3);

      // Set up failure callback
      const failureCallback = jest.fn();
      monitor.onRelayFailure(failureCallback);

      // Start monitoring
      monitor.startMonitoring();

      // Advance time to trigger failures (2 seconds for 2 consecutive checks)
      jest.advanceTimersByTime(2000);

      // Should have detected failures for relay-1 and relay-3, but not relay-2
      expect(failureCallback).toHaveBeenCalledTimes(2);
      expect(failureCallback).toHaveBeenCalledWith('relay-1', 'Connection failed');
      expect(failureCallback).toHaveBeenCalledWith('relay-3', 'Connection failed');
    });

    it('should not trigger duplicate failures for the same relay', () => {
      // Register relay
      monitor.registerRelay('relay-1');

      // Create mock peer connection in failed state
      const mockPeerConnection = {
        connectionState: 'failed',
        iceConnectionState: 'failed',
      } as RTCPeerConnection;

      mockPeerConnections.set('relay-1', mockPeerConnection);

      // Set up failure callback
      const failureCallback = jest.fn();
      monitor.onRelayFailure(failureCallback);

      // Start monitoring
      monitor.startMonitoring();

      // Advance time to trigger failure (2 seconds for 2 consecutive checks)
      jest.advanceTimersByTime(2000);
      expect(failureCallback).toHaveBeenCalledTimes(1);

      // Advance more time - should not trigger again
      jest.advanceTimersByTime(5000);
      expect(failureCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cleanup', () => {
    it('should cleanup all monitoring state', () => {
      monitor.registerRelay('relay-1');
      monitor.registerRelay('relay-2');
      monitor.startMonitoring();

      const failureCallback = jest.fn();
      monitor.onRelayFailure(failureCallback);

      monitor.cleanup();

      // Verify all state is cleared
      expect(monitor.getAllRelayHealth().size).toBe(0);
      expect(monitor['monitoringInterval']).toBeNull();
      expect(monitor['failureCallbacks'].length).toBe(0);
    });
  });
});
