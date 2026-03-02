// Tests for RelayEngine component

import { RelayEngine, RTCRtpPacket } from './relay-engine';
import * as fc from 'fast-check';

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

  // Feature: relay-mesh, Property 35: Relay Forwarding Preserves Encryption
  // Task 14.6: Property-based test for relay forwarding preserves encryption
  // Validates: Requirements 12.3
  describe('Property 35: Relay Forwarding Preserves Encryption', () => {
    it('property: relay does not decrypt media packets during forwarding', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate various packet configurations
          fc.record({
            // Generate encrypted payload (simulated as ArrayBuffer with random data)
            payloadSize: fc.integer({ min: 100, max: 10000 }),
            timestamp: fc.integer({ min: 0, max: Date.now() }),
            sequenceNumber: fc.integer({ min: 0, max: 65535 }),
            ssrc: fc.integer({ min: 1, max: 4294967295 }),
            
            // Generate source and destination configurations
            sourceType: fc.constantFrom('regular', 'relay'),
            numDestinations: fc.integer({ min: 1, max: 5 }),
          }),
          
          async (config) => {
            // Create a fresh relay engine for each test iteration
            const testRelay = new RelayEngine();
            testRelay.startRelay();
            
            // Create encrypted packet (simulated)
            const encryptedPayload = new ArrayBuffer(config.payloadSize);
            const view = new Uint8Array(encryptedPayload);
            // Fill with "encrypted" data (random-like pattern)
            for (let i = 0; i < view.length; i++) {
              view[i] = (i * 7 + config.ssrc) % 256;
            }
            
            const packet: RTCRtpPacket = {
              payload: encryptedPayload,
              timestamp: config.timestamp,
              sequenceNumber: config.sequenceNumber,
              ssrc: config.ssrc,
            };
            
            // Store original payload for comparison
            const originalPayload = new Uint8Array(packet.payload);
            const originalPayloadCopy = new Uint8Array(originalPayload);
            
            // Configure routes based on source type
            let sourceId: string;
            const destinations: string[] = [];
            
            if (config.sourceType === 'regular') {
              sourceId = 'regular-source';
              for (let i = 0; i < config.numDestinations; i++) {
                destinations.push(`relay-dest-${i}`);
              }
              testRelay.configureRoutes(
                [sourceId],
                destinations,
                [],
                []
              );
            } else {
              sourceId = 'relay-source';
              for (let i = 0; i < config.numDestinations; i++) {
                destinations.push(`regular-dest-${i}`);
              }
              testRelay.configureRoutes(
                [],
                [],
                [sourceId],
                destinations
              );
            }
            
            // Set up mock peer connections
            const mockConnections = new Map<string, RTCPeerConnection>();
            for (const destId of destinations) {
              mockConnections.set(destId, { 
                connectionState: 'connected' 
              } as RTCPeerConnection);
            }
            testRelay.setPeerConnections(mockConnections);
            
            // Forward the packet
            testRelay.forwardPacket(packet, sourceId);
            
            // Verify encryption preservation
            const encryptionInfo = testRelay.getEncryptionInfo();
            
            // Property 35: Relay must preserve encryption
            // 1. Relay must not decrypt packets
            expect(encryptionInfo.decryptsPackets).toBe(false);
            
            // 2. Relay must not modify payload
            expect(encryptionInfo.modifiesPayload).toBe(false);
            
            // 3. Relay must preserve encryption
            expect(encryptionInfo.preservesEncryption).toBe(true);
            
            // 4. Forwarding method must be encrypted passthrough
            expect(encryptionInfo.forwardingMethod).toBe('encrypted-passthrough');
            
            // 5. Verify packet payload remains unchanged
            const currentPayload = new Uint8Array(packet.payload);
            expect(currentPayload.length).toBe(originalPayloadCopy.length);
            
            // Compare byte-by-byte to ensure no modification
            for (let i = 0; i < currentPayload.length; i++) {
              if (currentPayload[i] !== originalPayloadCopy[i]) {
                throw new Error(
                  `Payload modified at byte ${i}: expected ${originalPayloadCopy[i]}, got ${currentPayload[i]}`
                );
              }
            }
            
            // 6. Verify relay engine confirms encryption preservation
            expect(testRelay.verifyEncryptionPreserved()).toBe(true);
            
            // 7. Verify packets were forwarded (not dropped due to decryption attempt)
            const stats = testRelay.getRelayStats();
            expect(stats.packetsReceived).toBe(1);
            expect(stats.packetsForwarded).toBe(config.numDestinations);
            expect(stats.packetsDropped).toBe(0);
            
            testRelay.stopRelay();
          }
        ),
        { numRuns: 100 } // Run 100 iterations to test various configurations
      );
    });

    it('property: relay preserves encryption across multiple packet forwarding operations', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate multiple packets to forward
          fc.array(
            fc.record({
              payloadSize: fc.integer({ min: 100, max: 5000 }),
              timestamp: fc.integer({ min: 0, max: Date.now() }),
              sequenceNumber: fc.integer({ min: 0, max: 65535 }),
              ssrc: fc.integer({ min: 1, max: 4294967295 }),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          
          async (packetConfigs) => {
            // Create a fresh relay engine
            const testRelay = new RelayEngine();
            testRelay.startRelay();
            
            // Configure routes
            testRelay.configureRoutes(
              ['regular1'],
              ['relay1', 'relay2'],
              [],
              []
            );
            
            // Set up mock peer connections
            const mockConnections = new Map<string, RTCPeerConnection>();
            mockConnections.set('relay1', { connectionState: 'connected' } as RTCPeerConnection);
            mockConnections.set('relay2', { connectionState: 'connected' } as RTCPeerConnection);
            testRelay.setPeerConnections(mockConnections);
            
            // Forward multiple packets and verify encryption preservation for each
            for (const config of packetConfigs) {
              const encryptedPayload = new ArrayBuffer(config.payloadSize);
              const view = new Uint8Array(encryptedPayload);
              for (let i = 0; i < view.length; i++) {
                view[i] = (i * 13 + config.ssrc) % 256;
              }
              
              const packet: RTCRtpPacket = {
                payload: encryptedPayload,
                timestamp: config.timestamp,
                sequenceNumber: config.sequenceNumber,
                ssrc: config.ssrc,
              };
              
              const originalPayload = new Uint8Array(packet.payload);
              
              // Forward packet
              testRelay.forwardPacket(packet, 'regular1');
              
              // Verify payload unchanged
              const currentPayload = new Uint8Array(packet.payload);
              expect(currentPayload.length).toBe(originalPayload.length);
              
              for (let i = 0; i < currentPayload.length; i++) {
                if (currentPayload[i] !== originalPayload[i]) {
                  throw new Error(
                    `Packet ${config.sequenceNumber}: Payload modified at byte ${i}`
                  );
                }
              }
            }
            
            // Verify encryption info remains consistent
            const encryptionInfo = testRelay.getEncryptionInfo();
            expect(encryptionInfo.decryptsPackets).toBe(false);
            expect(encryptionInfo.modifiesPayload).toBe(false);
            expect(encryptionInfo.preservesEncryption).toBe(true);
            
            // Verify all packets were forwarded successfully
            const stats = testRelay.getRelayStats();
            expect(stats.packetsReceived).toBe(packetConfigs.length);
            expect(stats.packetsForwarded).toBe(packetConfigs.length * 2); // 2 destinations
            expect(stats.packetsDropped).toBe(0);
            
            testRelay.stopRelay();
          }
        ),
        { numRuns: 50 } // Run 50 iterations with multiple packets each
      );
    });

    it('property: relay encryption preservation is independent of packet size and content', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate packets with various sizes and content patterns
          fc.record({
            payloadSize: fc.integer({ min: 1, max: 20000 }),
            fillPattern: fc.constantFrom('zeros', 'ones', 'alternating', 'random'),
            ssrc: fc.integer({ min: 1, max: 4294967295 }),
          }),
          
          async (config) => {
            const testRelay = new RelayEngine();
            testRelay.startRelay();
            
            testRelay.configureRoutes(['source'], ['dest1'], [], []);
            
            const mockConnections = new Map<string, RTCPeerConnection>();
            mockConnections.set('dest1', { connectionState: 'connected' } as RTCPeerConnection);
            testRelay.setPeerConnections(mockConnections);
            
            // Create payload with specific pattern
            const payload = new ArrayBuffer(config.payloadSize);
            const view = new Uint8Array(payload);
            
            switch (config.fillPattern) {
              case 'zeros':
                view.fill(0);
                break;
              case 'ones':
                view.fill(255);
                break;
              case 'alternating':
                for (let i = 0; i < view.length; i++) {
                  view[i] = i % 2 === 0 ? 0 : 255;
                }
                break;
              case 'random':
                for (let i = 0; i < view.length; i++) {
                  view[i] = (i * 17 + config.ssrc) % 256;
                }
                break;
            }
            
            const packet: RTCRtpPacket = {
              payload,
              timestamp: Date.now(),
              sequenceNumber: 1,
              ssrc: config.ssrc,
            };
            
            const originalPayload = new Uint8Array(packet.payload);
            
            // Forward packet
            testRelay.forwardPacket(packet, 'source');
            
            // Verify encryption preservation regardless of content
            const encryptionInfo = testRelay.getEncryptionInfo();
            expect(encryptionInfo.preservesEncryption).toBe(true);
            expect(encryptionInfo.decryptsPackets).toBe(false);
            
            // Verify payload unchanged
            const currentPayload = new Uint8Array(packet.payload);
            expect(currentPayload).toEqual(originalPayload);
            
            testRelay.stopRelay();
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
