// Integration tests for conference lifecycle
// Task 22.4: Write integration tests for conference lifecycle
// Requirements: 1.1, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6

import { RelayMeshClient } from './relay-mesh-client';
import { RelayMeshServer } from '../server/relay-mesh-server';
import { ConferenceState } from './conference-state-machine';
import { NATType } from '../shared/types';
import type { ParticipantMetrics } from '../shared/types';

describe('Conference Lifecycle Integration Tests', () => {
  let server: RelayMeshServer;
  let clients: RelayMeshClient[] = [];
  const serverPort = 8091;
  const serverUrl = `ws://localhost:${serverPort}`;

  beforeAll(async () => {
    // Start server
    server = new RelayMeshServer({
      port: serverPort,
      host: 'localhost',
      tlsEnabled: false,
      authRequired: false,
    });
    await server.start();
  });

  afterAll(async () => {
    // Stop server with error handling
    if (server) {
      try {
        await server.stop();
      } catch (error) {
        console.error('Error stopping server in afterAll:', error);
      }
    }
    // Give extra time for cleanup
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 60000); // 60 second timeout for server shutdown

  afterEach(async () => {
    // Clean up all clients
    for (const client of clients) {
      try {
        if (client.getCurrentState() === ConferenceState.CONNECTED) {
          await Promise.race([
            client.leaveConference(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('leave timeout')), 3000)),
          ]);
        }
      } catch (error) {
        // Ignore errors during cleanup
      }
      client.destroy();
    }
    clients = [];

    // Wait for cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe('Complete conference flow: create → join → media → leave → end', () => {
    it('should complete full lifecycle with single participant', async () => {
      const client = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });
      clients.push(client);

      // Track state transitions
      const stateTransitions: ConferenceState[] = [];
      client['stateMachine'].onStateChange((event) => {
        stateTransitions.push(event.to);
      });

      // Initial state should be IDLE
      expect(client.getCurrentState()).toBe(ConferenceState.IDLE);

      // Join conference
      const conferenceInfo = await client.joinConference('test-conference-1');
      expect(conferenceInfo).toBeDefined();
      expect(conferenceInfo.conferenceId).toBe('test-conference-1');
      expect(conferenceInfo.participantId).toBeDefined();

      // Should be in CONNECTED state
      expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      expect(stateTransitions).toContain(ConferenceState.JOINING);
      expect(stateTransitions).toContain(ConferenceState.CONNECTED);

      // Verify server knows about participant
      const serverInfo = server.getConferenceInfo('test-conference-1');
      expect(serverInfo.participants).toContain(conferenceInfo.participantId);

      // Leave conference
      await client.leaveConference();

      // Should be back to IDLE state
      expect(client.getCurrentState()).toBe(ConferenceState.IDLE);
      expect(stateTransitions).toContain(ConferenceState.LEAVING);
      expect(stateTransitions).toContain(ConferenceState.IDLE);

      // Verify state transition order
      const expectedOrder = [
        ConferenceState.JOINING,
        ConferenceState.CONNECTED,
        ConferenceState.LEAVING,
        ConferenceState.IDLE,
      ];
      expect(stateTransitions).toEqual(expectedOrder);
    });

    it('should complete full lifecycle with multiple participants', async () => {
      const conferenceId = 'test-conference-multi';
      const participantCount = 3;

      // Create and join multiple participants
      for (let i = 0; i < participantCount; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
        enforceSecureConnection: false,
        });
        clients.push(client);

        const conferenceInfo = await client.joinConference(conferenceId);
        expect(conferenceInfo.conferenceId).toBe(conferenceId);
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }

      // Verify all participants are in the conference
      const serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(participantCount);

      // Verify each client knows about the conference
      for (const client of clients) {
        const info = client.getConferenceInfo();
        expect(info).toBeDefined();
        expect(info!.conferenceId).toBe(conferenceId);
      }

      // Leave conference one by one
      for (const client of clients) {
        await client.leaveConference();
        expect(client.getCurrentState()).toBe(ConferenceState.IDLE);
      }

      // Wait for server to process all leaves
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify conference is cleaned up
      const finalInfo = server.getConferenceInfo(conferenceId);
      expect(finalInfo.participants.length).toBe(0);
    });

    it('should handle join within 10 seconds (Requirement 8.1)', async () => {
      const client = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });
      clients.push(client);

      const startTime = Date.now();
      await client.joinConference('test-conference-timing');
      const joinDuration = Date.now() - startTime;

      // Should complete within 10 seconds (10000ms)
      expect(joinDuration).toBeLessThan(10000);
      expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
    });
  });

  describe('Multiple participants joining and leaving', () => {
    it('should handle participants joining sequentially', async () => {
      const conferenceId = 'test-conference-sequential';

      // Join first participant
      const client1 = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });
      clients.push(client1);
      await client1.joinConference(conferenceId);

      let serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(1);

      // Join second participant
      const client2 = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 2',
        enforceSecureConnection: false,
      });
      clients.push(client2);
      await client2.joinConference(conferenceId);

      serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(2);

      // Join third participant
      const client3 = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 3',
        enforceSecureConnection: false,
      });
      clients.push(client3);
      await client3.joinConference(conferenceId);

      serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(3);

      // All should be connected
      expect(client1.getCurrentState()).toBe(ConferenceState.CONNECTED);
      expect(client2.getCurrentState()).toBe(ConferenceState.CONNECTED);
      expect(client3.getCurrentState()).toBe(ConferenceState.CONNECTED);
    });

    it('should handle participants joining concurrently', async () => {
      const conferenceId = 'test-conference-concurrent';
      const participantCount = 5;

      // Create all clients
      const joinPromises = [];
      for (let i = 0; i < participantCount; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
        enforceSecureConnection: false,
        });
        clients.push(client);
        joinPromises.push(client.joinConference(conferenceId));
      }

      // Wait for all to join
      await Promise.all(joinPromises);

      // Verify all joined successfully
      const serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(participantCount);

      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }
    });

    it('should handle regular node leaving without affecting topology (Requirement 8.5)', async () => {
      const conferenceId = 'test-conference-regular-leave';

      // Join multiple participants
      for (let i = 0; i < 4; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
        enforceSecureConnection: false,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
      }

      // Wait for topology to stabilize
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Get initial topology
      const initialTopology = server.getConferenceInfo(conferenceId).topology;
      const initialParticipantCount = server.getConferenceInfo(conferenceId).participants.length;

      // Identify a regular node (not a relay)
      let regularNodeIndex = -1;
      for (let i = 0; i < clients.length; i++) {
        const info = clients[i].getConferenceInfo();
        if (info && info.role === 'regular') {
          regularNodeIndex = i;
          break;
        }
      }

      // If we found a regular node, have it leave
      if (regularNodeIndex >= 0) {
        const leavingClient = clients[regularNodeIndex];
        await leavingClient.leaveConference();

        // Wait for topology update
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify other participants still connected
        for (let i = 0; i < clients.length; i++) {
          if (i !== regularNodeIndex) {
            expect(clients[i].getCurrentState()).toBe(ConferenceState.CONNECTED);
          }
        }

        // Verify participant count decreased by 1
        const newParticipantCount = server.getConferenceInfo(conferenceId).participants.length;
        expect(newParticipantCount).toBe(initialParticipantCount - 1);
      }
    });

    it('should handle participants leaving in different orders', async () => {
      const conferenceId = 'test-conference-leave-order';

      // Join 5 participants
      for (let i = 0; i < 5; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
        enforceSecureConnection: false,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
      }

      let serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(5);

      // Leave in reverse order: last joined leaves first
      await clients[4].leaveConference();
      await new Promise((resolve) => setTimeout(resolve, 50));
      serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(4);

      // Leave from middle
      await clients[2].leaveConference();
      await new Promise((resolve) => setTimeout(resolve, 50));
      serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(3);

      // Leave first participant
      await clients[0].leaveConference();
      await new Promise((resolve) => setTimeout(resolve, 50));
      serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(2);

      // Remaining participants should still be connected
      expect(clients[1].getCurrentState()).toBe(ConferenceState.CONNECTED);
      expect(clients[3].getCurrentState()).toBe(ConferenceState.CONNECTED);
    });

    it('should handle all participants leaving simultaneously', async () => {
      const conferenceId = 'test-conference-simultaneous-leave';

      // Join multiple participants
      for (let i = 0; i < 4; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
        enforceSecureConnection: false,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
      }

      // All leave simultaneously
      const leavePromises = clients.map((client) => client.leaveConference());
      await Promise.all(leavePromises);

      // All should be in IDLE state
      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.IDLE);
      }

      // Wait for server cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Conference should be empty
      const serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(0);
    });

    it('should handle rapid join-leave cycles', async () => {
      const conferenceId = 'test-conference-rapid-cycles';

      // Participant joins and leaves rapidly
      for (let cycle = 0; cycle < 3; cycle++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant Cycle ${cycle + 1}`,
        enforceSecureConnection: false,
        });

        await client.joinConference(conferenceId);
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);

        await client.leaveConference();
        expect(client.getCurrentState()).toBe(ConferenceState.IDLE);

        // Small delay between cycles
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // Conference should be empty after all cycles
      const serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(0);
    });
  });

  describe('Relay failover during active conference', () => {
    it('should detect relay node leaving and trigger failover (Requirement 8.6)', async () => {
      const conferenceId = 'test-conference-relay-failover';

      // Join enough participants to have relay nodes (need at least 4 for relay selection)
      for (let i = 0; i < 6; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
        enforceSecureConnection: false,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
      }

      // Wait for topology to form with relay nodes
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Find a relay node
      let relayNodeIndex = -1;
      for (let i = 0; i < clients.length; i++) {
        const info = clients[i].getConferenceInfo();
        if (info && info.role === 'relay') {
          relayNodeIndex = i;
          break;
        }
      }

      if (relayNodeIndex >= 0) {
        const relayClient = clients[relayNodeIndex];
        const relayParticipantId = relayClient.getConferenceInfo()!.participantId;

        // Track topology updates on remaining clients
        const topologyUpdates: number[] = [];
        for (let i = 0; i < clients.length; i++) {
          if (i !== relayNodeIndex) {
            clients[i]['signalingClient'].onTopologyUpdate(() => {
              topologyUpdates.push(i);
            });
          }
        }

        // Relay node leaves
        await relayClient.leaveConference();

        // Wait for failover to complete
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Verify remaining participants received topology updates
        expect(topologyUpdates.length).toBeGreaterThan(0);

        // Verify remaining participants are still connected
        for (let i = 0; i < clients.length; i++) {
          if (i !== relayNodeIndex) {
            expect(clients[i].getCurrentState()).toBe(ConferenceState.CONNECTED);
          }
        }

        // Verify relay is no longer in conference
        const serverInfo = server.getConferenceInfo(conferenceId);
        expect(serverInfo.participants).not.toContain(relayParticipantId);
      }
    });

    it('should maintain conference when relay node fails', async () => {
      const conferenceId = 'test-conference-relay-failure';

      // Join participants
      for (let i = 0; i < 5; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
        enforceSecureConnection: false,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
      }

      // Wait for topology to stabilize
      await new Promise((resolve) => setTimeout(resolve, 500));

      const initialParticipantCount = server.getConferenceInfo(conferenceId).participants.length;

      // Find and remove a relay node
      let relayNodeIndex = -1;
      for (let i = 0; i < clients.length; i++) {
        const info = clients[i].getConferenceInfo();
        if (info && info.role === 'relay') {
          relayNodeIndex = i;
          break;
        }
      }

      if (relayNodeIndex >= 0) {
        await clients[relayNodeIndex].leaveConference();

        // Wait for failover
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Verify conference continues with remaining participants
        const newParticipantCount = server.getConferenceInfo(conferenceId).participants.length;
        expect(newParticipantCount).toBe(initialParticipantCount - 1);

        // All remaining participants should still be connected
        for (let i = 0; i < clients.length; i++) {
          if (i !== relayNodeIndex) {
            expect(clients[i].getCurrentState()).toBe(ConferenceState.CONNECTED);
          }
        }
      }
    });

    it('should handle multiple relay failures in sequence', async () => {
      const conferenceId = 'test-conference-multiple-relay-failures';

      // Join enough participants to have multiple relays
      for (let i = 0; i < 8; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
        enforceSecureConnection: false,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
      }

      // Wait for topology with multiple relays
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Find all relay nodes
      const relayIndices: number[] = [];
      for (let i = 0; i < clients.length; i++) {
        const info = clients[i].getConferenceInfo();
        if (info && info.role === 'relay') {
          relayIndices.push(i);
        }
      }

      // Remove relays one by one
      for (const relayIndex of relayIndices.slice(0, 2)) {
        // Remove up to 2 relays
        await clients[relayIndex].leaveConference();
        await new Promise((resolve) => setTimeout(resolve, 800));

        // Verify remaining participants still connected
        for (let i = 0; i < clients.length; i++) {
          if (!relayIndices.slice(0, relayIndices.indexOf(relayIndex) + 1).includes(i)) {
            expect(clients[i].getCurrentState()).toBe(ConferenceState.CONNECTED);
          }
        }
      }
    });
  });

  describe('Connection cleanup on leave (Requirement 8.4)', () => {
    it('should close connections within 2 seconds of participant leaving', async () => {
      const conferenceId = 'test-conference-cleanup';

      // Join two participants
      const client1 = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });
      clients.push(client1);
      await client1.joinConference(conferenceId);

      const client2 = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 2',
        enforceSecureConnection: false,
      });
      clients.push(client2);
      await client2.joinConference(conferenceId);

      // Wait for connections to establish
      await new Promise((resolve) => setTimeout(resolve, 300));

      const participant1Id = client1.getConferenceInfo()!.participantId;

      // Participant 1 leaves
      const leaveStartTime = Date.now();
      await client1.leaveConference();

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));

      const cleanupDuration = Date.now() - leaveStartTime;

      // Should complete within 2 seconds (2000ms)
      expect(cleanupDuration).toBeLessThan(2000);

      // Verify participant 1 is no longer in conference
      const serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants).not.toContain(participant1Id);

      // Participant 2 should still be connected
      expect(client2.getCurrentState()).toBe(ConferenceState.CONNECTED);
    });

    it('should clean up all connections when last participant leaves', async () => {
      const conferenceId = 'test-conference-final-cleanup';

      const client = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Last Participant',
        enforceSecureConnection: false,
      });
      clients.push(client);

      await client.joinConference(conferenceId);
      expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);

      // Leave conference
      await client.leaveConference();

      // Wait for cleanup
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Conference should be empty
      const serverInfo = server.getConferenceInfo(conferenceId);
      expect(serverInfo.participants.length).toBe(0);
      expect(serverInfo.topology).toBeNull();
    });
  });

  describe('Error handling during lifecycle', () => {
    it('should handle join failure gracefully', async () => {
      // Create client with invalid server URL
      const client = new RelayMeshClient({
        signalingServerUrl: 'ws://localhost:9999', // Non-existent server
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });

      // Join should fail
      await expect(client.joinConference('test-conference')).rejects.toThrow();

      // Should remain in IDLE or JOINING state
      const state = client.getCurrentState();
      expect([ConferenceState.IDLE, ConferenceState.JOINING]).toContain(state);
    });

    it('should handle leave when not in conference', async () => {
      const client = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });
      clients.push(client);

      // Try to leave without joining
      await expect(client.leaveConference()).rejects.toThrow();
      expect(client.getCurrentState()).toBe(ConferenceState.IDLE);
    });

    it('should handle double join attempts', async () => {
      const client = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });
      clients.push(client);

      // First join
      await client.joinConference('test-conference-double');
      expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);

      // Second join should fail
      await expect(client.joinConference('test-conference-double')).rejects.toThrow();
      expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
    });

    it('should handle double leave attempts', async () => {
      const client = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });
      clients.push(client);

      await client.joinConference('test-conference-double-leave');
      await client.leaveConference();
      expect(client.getCurrentState()).toBe(ConferenceState.IDLE);

      // Second leave should fail
      await expect(client.leaveConference()).rejects.toThrow();
      expect(client.getCurrentState()).toBe(ConferenceState.IDLE);
    });
  });

  describe('State machine validation', () => {
    it('should enforce valid state transitions', async () => {
      const client = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });
      clients.push(client);

      // IDLE -> JOINING -> CONNECTED
      expect(client.getCurrentState()).toBe(ConferenceState.IDLE);

      await client.joinConference('test-conference-states');
      expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);

      // CONNECTED -> LEAVING -> IDLE
      await client.leaveConference();
      expect(client.getCurrentState()).toBe(ConferenceState.IDLE);
    });

    it('should track all state transitions', async () => {
      const client = new RelayMeshClient({
        signalingServerUrl: serverUrl,
        participantName: 'Participant 1',
        enforceSecureConnection: false,
      });
      clients.push(client);

      const transitions: Array<{ from: ConferenceState; to: ConferenceState }> = [];
      client['stateMachine'].onStateChange((event) => {
        transitions.push({ from: event.from, to: event.to });
      });

      await client.joinConference('test-conference-transitions');
      await client.leaveConference();

      // Verify transition sequence
      expect(transitions.length).toBeGreaterThanOrEqual(4);
      expect(transitions[0]).toEqual({
        from: ConferenceState.IDLE,
        to: ConferenceState.JOINING,
      });
      expect(transitions[transitions.length - 1]).toEqual({
        from: ConferenceState.LEAVING,
        to: ConferenceState.IDLE,
      });
    });
  });
});
