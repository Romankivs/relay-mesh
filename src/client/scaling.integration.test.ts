// Integration tests for scaling scenarios
// Task 22.7: Write integration tests for scaling scenarios
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5

import { RelayMeshClient } from './relay-mesh-client';
import { RelayMeshServer } from '../server/relay-mesh-server';
import { ConferenceState } from './conference-state-machine';
import type { ConnectionTopology, ParticipantGroup } from '../shared/types';

describe('Scaling Integration Tests', () => {
  let server: RelayMeshServer;
  let clients: RelayMeshClient[] = [];
  const serverPort = 8094;
  const serverUrl = `ws://localhost:${serverPort}`;

  beforeAll(async () => {
    server = new RelayMeshServer({
      port: serverPort,
      host: 'localhost',
      tlsEnabled: false,
      authRequired: false,
    });
    await server.start();
  }, 20000);

  afterAll(async () => {
    if (server) {
      try {
        await server.stop();
      } catch (error) {
        console.error('Error stopping server in afterAll:', error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }, 60000);

  afterEach(async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  const countTotalConnections = (topology: ConnectionTopology | null): number => {
    if (!topology) return 0;
    let totalConnections = 0;
    const relayCount = topology.relayNodes.length;
    totalConnections += (relayCount * (relayCount - 1)) / 2;
    for (const group of topology.groups) {
      totalConnections += group.regularNodeIds.length;
    }
    return totalConnections;
  };

  const verifyRegularNodeConnections = (topology: ConnectionTopology | null): boolean => {
    if (!topology) return false;
    const allRegularNodes = topology.groups.flatMap((g: ParticipantGroup) => g.regularNodeIds);
    const uniqueRegularNodes = new Set(allRegularNodes);
    if (allRegularNodes.length !== uniqueRegularNodes.size) return false;
    return true;
  };

  describe('Gradual participant increase: 3 → 10 → 20', () => {
    it('should scale from 3 to 10 to 20 participants with topology adaptation', async () => {
      const conferenceId = 'test-gradual-scaling';
      const performanceMetrics: Array<{
        participantCount: number;
        relayCount: number;
        totalConnections: number;
        fullMeshConnections: number;
        efficiency: number;
        topologyFormationTime: number;
      }> = [];

      // Stage 1: 3 participants
      for (let i = 0; i < 3; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
          enforceSecureConnection: false,
          bandwidthTestDurationMs: 0,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
      }
      const stage1Start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stage1Duration = Date.now() - stage1Start;

      let topology = server.getConferenceInfo(conferenceId).topology;
      const stage1Metrics = {
        participantCount: 3,
        relayCount: topology?.relayNodes.length || 0,
        totalConnections: countTotalConnections(topology),
        fullMeshConnections: (3 * 2) / 2,
        efficiency: 0,
        topologyFormationTime: stage1Duration,
      };
      stage1Metrics.efficiency = 1 - stage1Metrics.totalConnections / stage1Metrics.fullMeshConnections;
      performanceMetrics.push(stage1Metrics);

      expect(server.getConferenceInfo(conferenceId).participants.length).toBe(3);
      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }

      // Stage 2: 10 participants
      const stage2Start = Date.now();
      for (let i = 3; i < 10; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
          enforceSecureConnection: false,
          bandwidthTestDurationMs: 0,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const stage2Duration = Date.now() - stage2Start;

      topology = server.getConferenceInfo(conferenceId).topology;
      const stage2Metrics = {
        participantCount: 10,
        relayCount: topology?.relayNodes.length || 0,
        totalConnections: countTotalConnections(topology),
        fullMeshConnections: (10 * 9) / 2,
        efficiency: 0,
        topologyFormationTime: stage2Duration,
      };
      stage2Metrics.efficiency = 1 - stage2Metrics.totalConnections / stage2Metrics.fullMeshConnections;
      performanceMetrics.push(stage2Metrics);

      expect(server.getConferenceInfo(conferenceId).participants.length).toBe(10);
      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }
      expect(stage2Metrics.relayCount).toBeGreaterThanOrEqual(stage1Metrics.relayCount);

      // Stage 3: 20 participants
      const stage3Start = Date.now();
      for (let i = 10; i < 20; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
          enforceSecureConnection: false,
          bandwidthTestDurationMs: 0,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const stage3Duration = Date.now() - stage3Start;

      topology = server.getConferenceInfo(conferenceId).topology;
      const stage3Metrics = {
        participantCount: 20,
        relayCount: topology?.relayNodes.length || 0,
        totalConnections: countTotalConnections(topology),
        fullMeshConnections: (20 * 19) / 2,
        efficiency: 0,
        topologyFormationTime: stage3Duration,
      };
      stage3Metrics.efficiency = 1 - stage3Metrics.totalConnections / stage3Metrics.fullMeshConnections;
      performanceMetrics.push(stage3Metrics);

      expect(server.getConferenceInfo(conferenceId).participants.length).toBe(20);
      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }
      expect(stage3Metrics.relayCount).toBeGreaterThanOrEqual(stage2Metrics.relayCount);
      expect(stage3Metrics.efficiency).toBeGreaterThan(0.7);
    }, 45000);
  });

  describe('Connection optimization requirements (9.1, 9.2, 9.3)', () => {
    it('should minimize connections per participant as scale increases', async () => {
      const conferenceId = 'test-connection-minimization';
      const connectionCounts: Array<{ scale: number; maxConnections: number; avgConnections: number }> = [];

      const scales = [5, 10, 15];
      for (const targetScale of scales) {
        const startCount = clients.length;
        for (let i = startCount; i < targetScale; i++) {
          const client = new RelayMeshClient({
            signalingServerUrl: serverUrl,
            participantName: `Participant ${i + 1}`,
            enforceSecureConnection: false,
          bandwidthTestDurationMs: 0,
          });
          clients.push(client);
          await client.joinConference(conferenceId);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const connectionCountsPerParticipant: number[] = [];
        for (const client of clients) {
          const mediaHandler = client['mediaHandler'];
          if (mediaHandler) {
            const activeConnections = mediaHandler.getActiveConnections();
            connectionCountsPerParticipant.push(activeConnections.length);
          }
        }

        const maxConnections = Math.max(...connectionCountsPerParticipant);
        const avgConnections =
          connectionCountsPerParticipant.reduce((a, b) => a + b, 0) /
          connectionCountsPerParticipant.length;

        connectionCounts.push({ scale: targetScale, maxConnections, avgConnections });
      }

      for (const data of connectionCounts) {
        expect(data.maxConnections).toBeLessThan(data.scale - 1);
        expect(data.avgConnections).toBeLessThan(data.scale / 2);
      }
    }, 60000);
  });

  describe('Dynamic relay scaling (Requirements 9.4, 9.5)', () => {
    it('should maintain conference quality during scaling', async () => {
      const conferenceId = 'test-quality-during-scaling';

      for (let i = 0; i < 5; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
          enforceSecureConnection: false,
          bandwidthTestDurationMs: 0,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));

      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }

      for (let i = 5; i < 18; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
          enforceSecureConnection: false,
          bandwidthTestDurationMs: 0,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
        await new Promise((resolve) => setTimeout(resolve, 100));

        for (let j = 0; j < i; j++) {
          expect(clients[j].getCurrentState()).toBe(ConferenceState.CONNECTED);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(server.getConferenceInfo(conferenceId).participants.length).toBe(18);
      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }

      const topology = server.getConferenceInfo(conferenceId).topology;
      expect(topology).toBeDefined();
      if (topology) {
        expect(verifyRegularNodeConnections(topology)).toBe(true);
      }
    }, 60000);
  });

  describe('Stress testing and edge cases', () => {
    it('should handle rapid participant additions', async () => {
      const conferenceId = 'test-rapid-additions';

      const joinPromises = [];
      for (let i = 0; i < 15; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
          enforceSecureConnection: false,
          bandwidthTestDurationMs: 0,
        });
        clients.push(client);
        joinPromises.push(client.joinConference(conferenceId));
      }

      await Promise.all(joinPromises);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      expect(server.getConferenceInfo(conferenceId).participants.length).toBe(15);
      for (const client of clients) {
        expect(client.getCurrentState()).toBe(ConferenceState.CONNECTED);
      }

      const topology = server.getConferenceInfo(conferenceId).topology;
      expect(topology).toBeDefined();
      if (topology) {
        expect(verifyRegularNodeConnections(topology)).toBe(true);
      }
    }, 45000);

    it('should handle scaling down (participants leaving)', async () => {
      const conferenceId = 'test-scale-down';

      for (let i = 0; i < 20; i++) {
        const client = new RelayMeshClient({
          signalingServerUrl: serverUrl,
          participantName: `Participant ${i + 1}`,
          enforceSecureConnection: false,
          bandwidthTestDurationMs: 0,
        });
        clients.push(client);
        await client.joinConference(conferenceId);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));

      for (let i = 0; i < 10; i++) {
        await clients[i].leaveConference();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(server.getConferenceInfo(conferenceId).participants.length).toBe(10);
      for (let i = 10; i < 20; i++) {
        expect(clients[i].getCurrentState()).toBe(ConferenceState.CONNECTED);
      }

      const finalTopology = server.getConferenceInfo(conferenceId).topology;
      expect(finalTopology).toBeDefined();
      if (finalTopology) {
        expect(verifyRegularNodeConnections(finalTopology)).toBe(true);
      }
    }, 60000);
  });
});
