// Tests for RelayEngine component

import { RelayEngine, RTCRtpPacket } from './relay-engine';

describe('RelayEngine', () => {
  let relayEngine: RelayEngine;

  beforeEach(() => {
    relayEngine = new RelayEngine();
  });

  describe('startRelay and stopRelay', () => {
    test('should start relay engine', () => {
      expect(relayEngine.isRelayActive()).toBe(false);
      
      relayEngine.startRelay();
      
      expect(relayEngine.isRelayActive()).toBe(true);
    });

    test('should stop relay engine', () => {
      relayEngine.startRelay();
      expect(relayEngine.isRelayActive()).toBe(true);
      
      relayEngine.stopRelay();
      
      expect(relayEngine.isRelayActive()).toBe(false);
    });

    test('should handle multiple start calls gracefully', () => {
      relayEngine.startRelay();
      relayEngine.startRelay(); // Should not throw
      
      expect(relayEngine.isRelayActive()).toBe(true);
    });

    test('should handle multiple stop calls gracefully', () => {
      relayEngine.startRelay();
      relayEngine.stopRelay();
      relayEngine.stopRelay(); // Should not throw
      
      expect(relayEngine.isRelayActive()).toBe(false);
    });
  });

  describe('configureRoutes', () => {
    test('should configure forwarding routes', () => {
      const incomingFromRegular = ['regular1', 'regular2'];
      const outgoingToRelays = ['relay1', 'relay2'];
      const incomingFromRelays = ['relay1', 'relay2'];
      const outgoingToRegular = ['regular1', 'regular2'];

      relayEngine.configureRoutes(
        incomingFromRegular,
        outgoingToRelays,
        incomingFromRelays,
        outgoingToRegular
      );

      const table = relayEngine.getForwardingTable();
      
      expect(table.incomingFromRegular.size).toBe(2);
      expect(table.outgoingToRelays.size).toBe(2);
      expect(table.incomingFromRelays.size).toBe(2);
      expect(table.outgoingToRegular.size).toBe(2);
      
      expect(table.incomingFromRegular.has('regular1')).toBe(true);
      expect(table.outgoingToRelays.has('relay1')).toBe(true);
    });

    test('should clear previous routes when reconfiguring', () => {
      relayEngine.configureRoutes(['regular1'], ['relay1'], ['relay1'], ['regular1']);
      relayEngine.configureRoutes(['regular2'], ['relay2'], ['relay2'], ['regular2']);

      const table = relayEngine.getForwardingTable();
      
      expect(table.incomingFromRegular.has('regular1')).toBe(false);
      expect(table.incomingFromRegular.has('regular2')).toBe(true);
    });

    test('should handle empty route configuration', () => {
      relayEngine.configureRoutes([], [], [], []);

      const table = relayEngine.getForwardingTable();
      
      expect(table.incomingFromRegular.size).toBe(0);
      expect(table.outgoingToRelays.size).toBe(0);
      expect(table.incomingFromRelays.size).toBe(0);
      expect(table.outgoingToRegular.size).toBe(0);
    });
  });

  describe('forwardPacket', () => {
    let mockPacket: RTCRtpPacket;

    beforeEach(() => {
      mockPacket = {
        payload: new ArrayBuffer(100),
        timestamp: Date.now(),
        sequenceNumber: 1,
        ssrc: 12345,
      };
    });

    test('should not forward packets when relay is not active', () => {
      relayEngine.configureRoutes(['regular1'], ['relay1'], [], []);
      
      relayEngine.forwardPacket(mockPacket, 'regular1');
      
      const stats = relayEngine.getRelayStats();
      expect(stats.packetsDropped).toBe(1);
      expect(stats.packetsForwarded).toBe(0);
    });

    test('should forward packet from regular node to relay nodes', () => {
      relayEngine.startRelay();
      relayEngine.configureRoutes(['regular1'], ['relay1', 'relay2'], [], []);
      
      // Create mock peer connections
      const mockConnections = new Map<string, RTCPeerConnection>();
      mockConnections.set('relay1', { connectionState: 'connected' } as RTCPeerConnection);
      mockConnections.set('relay2', { connectionState: 'connected' } as RTCPeerConnection);
      relayEngine.setPeerConnections(mockConnections);
      
      relayEngine.forwardPacket(mockPacket, 'regular1');
      
      const stats = relayEngine.getRelayStats();
      expect(stats.packetsReceived).toBe(1);
      expect(stats.packetsForwarded).toBe(2); // Forwarded to 2 relay nodes
    });

    test('should forward packet from relay node to regular nodes', () => {
      relayEngine.startRelay();
      relayEngine.configureRoutes([], [], ['relay1'], ['regular1', 'regular2']);
      
      // Create mock peer connections
      const mockConnections = new Map<string, RTCPeerConnection>();
      mockConnections.set('regular1', { connectionState: 'connected' } as RTCPeerConnection);
      mockConnections.set('regular2', { connectionState: 'connected' } as RTCPeerConnection);
      relayEngine.setPeerConnections(mockConnections);
      
      relayEngine.forwardPacket(mockPacket, 'relay1');
      
      const stats = relayEngine.getRelayStats();
      expect(stats.packetsReceived).toBe(1);
      expect(stats.packetsForwarded).toBe(2); // Forwarded to 2 regular nodes
    });

    test('should drop packets from unknown sources', () => {
      relayEngine.startRelay();
      relayEngine.configureRoutes(['regular1'], ['relay1'], [], []);
      
      relayEngine.forwardPacket(mockPacket, 'unknown');
      
      const stats = relayEngine.getRelayStats();
      expect(stats.packetsReceived).toBe(1);
      expect(stats.packetsDropped).toBe(1);
      expect(stats.packetsForwarded).toBe(0);
    });

    test('should drop packets when peer connection is missing', () => {
      relayEngine.startRelay();
      relayEngine.configureRoutes(['regular1'], ['relay1'], [], []);
      
      // No peer connections set
      relayEngine.forwardPacket(mockPacket, 'regular1');
      
      const stats = relayEngine.getRelayStats();
      expect(stats.packetsDropped).toBe(1);
    });

    test('should drop packets when peer connection is not connected', () => {
      relayEngine.startRelay();
      relayEngine.configureRoutes(['regular1'], ['relay1'], [], []);
      
      // Create mock peer connection with disconnected state
      const mockConnections = new Map<string, RTCPeerConnection>();
      mockConnections.set('relay1', { connectionState: 'disconnected' } as RTCPeerConnection);
      relayEngine.setPeerConnections(mockConnections);
      
      relayEngine.forwardPacket(mockPacket, 'regular1');
      
      const stats = relayEngine.getRelayStats();
      expect(stats.packetsDropped).toBe(1);
    });
  });

  describe('getRelayStats', () => {
    test('should return initial stats', () => {
      const stats = relayEngine.getRelayStats();
      
      expect(stats.packetsReceived).toBe(0);
      expect(stats.packetsForwarded).toBe(0);
      expect(stats.packetsDropped).toBe(0);
      expect(stats.averageForwardingLatencyMs).toBe(0);
      expect(stats.currentLoad).toBe(0);
    });

    test('should track packet statistics', () => {
      relayEngine.startRelay();
      relayEngine.configureRoutes(['regular1'], ['relay1'], [], []);
      
      const mockConnections = new Map<string, RTCPeerConnection>();
      mockConnections.set('relay1', { connectionState: 'connected' } as RTCPeerConnection);
      relayEngine.setPeerConnections(mockConnections);
      
      const mockPacket: RTCRtpPacket = {
        payload: new ArrayBuffer(100),
        timestamp: Date.now(),
        sequenceNumber: 1,
        ssrc: 12345,
      };
      
      relayEngine.forwardPacket(mockPacket, 'regular1');
      
      const stats = relayEngine.getRelayStats();
      expect(stats.packetsReceived).toBe(1);
      expect(stats.packetsForwarded).toBe(1);
    });

    test('should calculate average forwarding latency', () => {
      relayEngine.startRelay();
      relayEngine.configureRoutes(['regular1'], ['relay1'], [], []);
      
      const mockConnections = new Map<string, RTCPeerConnection>();
      mockConnections.set('relay1', { connectionState: 'connected' } as RTCPeerConnection);
      relayEngine.setPeerConnections(mockConnections);
      
      const mockPacket: RTCRtpPacket = {
        payload: new ArrayBuffer(100),
        timestamp: Date.now(),
        sequenceNumber: 1,
        ssrc: 12345,
      };
      
      // Forward multiple packets
      relayEngine.forwardPacket(mockPacket, 'regular1');
      relayEngine.forwardPacket(mockPacket, 'regular1');
      
      const stats = relayEngine.getRelayStats();
      expect(stats.averageForwardingLatencyMs).toBeGreaterThanOrEqual(0);
    });

    test('should return a copy of stats', () => {
      const stats1 = relayEngine.getRelayStats();
      stats1.packetsReceived = 999;
      
      const stats2 = relayEngine.getRelayStats();
      expect(stats2.packetsReceived).toBe(0);
    });
  });

  describe('resetStats', () => {
    test('should reset all statistics', () => {
      relayEngine.startRelay();
      relayEngine.configureRoutes(['regular1'], ['relay1'], [], []);
      
      const mockConnections = new Map<string, RTCPeerConnection>();
      mockConnections.set('relay1', { connectionState: 'connected' } as RTCPeerConnection);
      relayEngine.setPeerConnections(mockConnections);
      
      const mockPacket: RTCRtpPacket = {
        payload: new ArrayBuffer(100),
        timestamp: Date.now(),
        sequenceNumber: 1,
        ssrc: 12345,
      };
      
      relayEngine.forwardPacket(mockPacket, 'regular1');
      
      let stats = relayEngine.getRelayStats();
      expect(stats.packetsReceived).toBe(1);
      
      relayEngine.resetStats();
      
      stats = relayEngine.getRelayStats();
      expect(stats.packetsReceived).toBe(0);
      expect(stats.packetsForwarded).toBe(0);
      expect(stats.packetsDropped).toBe(0);
      expect(stats.averageForwardingLatencyMs).toBe(0);
      expect(stats.currentLoad).toBe(0);
    });
  });

  describe('integration scenarios', () => {
    test('should handle complete relay workflow', () => {
      // Start relay
      relayEngine.startRelay();
      expect(relayEngine.isRelayActive()).toBe(true);
      
      // Configure routes
      relayEngine.configureRoutes(
        ['regular1', 'regular2'],
        ['relay1', 'relay2'],
        ['relay1', 'relay2'],
        ['regular1', 'regular2']
      );
      
      // Set up peer connections
      const mockConnections = new Map<string, RTCPeerConnection>();
      mockConnections.set('relay1', { connectionState: 'connected' } as RTCPeerConnection);
      mockConnections.set('relay2', { connectionState: 'connected' } as RTCPeerConnection);
      mockConnections.set('regular1', { connectionState: 'connected' } as RTCPeerConnection);
      mockConnections.set('regular2', { connectionState: 'connected' } as RTCPeerConnection);
      relayEngine.setPeerConnections(mockConnections);
      
      // Forward packets from regular nodes
      const packet1: RTCRtpPacket = {
        payload: new ArrayBuffer(100),
        timestamp: Date.now(),
        sequenceNumber: 1,
        ssrc: 12345,
      };
      relayEngine.forwardPacket(packet1, 'regular1');
      
      // Forward packets from relay nodes
      const packet2: RTCRtpPacket = {
        payload: new ArrayBuffer(100),
        timestamp: Date.now(),
        sequenceNumber: 2,
        ssrc: 67890,
      };
      relayEngine.forwardPacket(packet2, 'relay1');
      
      // Check stats
      const stats = relayEngine.getRelayStats();
      expect(stats.packetsReceived).toBe(2);
      expect(stats.packetsForwarded).toBe(4); // 2 to relays + 2 to regulars
      expect(stats.packetsDropped).toBe(0);
      
      // Stop relay
      relayEngine.stopRelay();
      expect(relayEngine.isRelayActive()).toBe(false);
    });
  });
});
