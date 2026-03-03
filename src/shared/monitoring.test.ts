// Tests for monitoring and event logging system

import {
  Monitor,
  Logger,
  EventType,
  TopologySnapshot,
  RelayNodeAssignment,
  ConnectionQualityMetrics,
  PeerConnectionStats,
} from './monitoring';
import {
  Conference,
  ConnectionTopology,
  ParticipantMetrics,
  Participant,
  NATType,
  SelectionConfig,
} from './types';

describe('Monitor', () => {
  let monitor: Monitor;
  let mockConference: Conference;

  beforeEach(() => {
    monitor = new Monitor();

    // Create mock conference with topology
    const topology: ConnectionTopology = {
      version: 1,
      timestamp: Date.now(),
      relayNodes: ['relay1', 'relay2'],
      groups: [
        {
          relayNodeId: 'relay1',
          regularNodeIds: ['regular1', 'regular2'],
        },
        {
          relayNodeId: 'relay2',
          regularNodeIds: ['regular3'],
        },
      ],
      relayConnections: [['relay1', 'relay2']],
    };

    const createMockMetrics = (id: string): ParticipantMetrics => ({
      participantId: id,
      timestamp: Date.now(),
      bandwidth: { uploadMbps: 10, downloadMbps: 50, measurementConfidence: 0.9 },
      natType: NATType.FULL_CONE,
      latency: {
        averageRttMs: 50,
        minRttMs: 30,
        maxRttMs: 100,
        measurements: new Map(),
      },
      stability: {
        packetLossPercent: 0.5,
        jitterMs: 10,
        connectionUptime: 300,
        reconnectionCount: 0,
      },
      device: {
        cpuUsagePercent: 30,
        availableMemoryMB: 2048,
        supportedCodecs: ['VP8', 'H264'],
        hardwareAcceleration: true,
      },
    });

    const participants = new Map<string, Participant>();
    participants.set('relay1', {
      id: 'relay1',
      name: 'Relay 1',
      role: 'relay',
      metrics: createMockMetrics('relay1'),
      connections: new Map(),
      groupMembers: ['regular1', 'regular2'],
      joinedAt: Date.now() - 10000,
      lastSeen: Date.now(),
    });
    participants.set('relay2', {
      id: 'relay2',
      name: 'Relay 2',
      role: 'relay',
      metrics: createMockMetrics('relay2'),
      connections: new Map(),
      groupMembers: ['regular3'],
      joinedAt: Date.now() - 10000,
      lastSeen: Date.now(),
    });
    participants.set('regular1', {
      id: 'regular1',
      name: 'Regular 1',
      role: 'regular',
      metrics: createMockMetrics('regular1'),
      connections: new Map(),
      assignedRelayId: 'relay1',
      joinedAt: Date.now() - 5000,
      lastSeen: Date.now(),
    });
    participants.set('regular2', {
      id: 'regular2',
      name: 'Regular 2',
      role: 'regular',
      metrics: createMockMetrics('regular2'),
      connections: new Map(),
      assignedRelayId: 'relay1',
      joinedAt: Date.now() - 5000,
      lastSeen: Date.now(),
    });
    participants.set('regular3', {
      id: 'regular3',
      name: 'Regular 3',
      role: 'regular',
      metrics: createMockMetrics('regular3'),
      connections: new Map(),
      assignedRelayId: 'relay2',
      joinedAt: Date.now() - 5000,
      lastSeen: Date.now(),
    });

    const config: SelectionConfig = {
      bandwidthWeight: 0.3,
      natWeight: 0.25,
      latencyWeight: 0.2,
      stabilityWeight: 0.15,
      deviceWeight: 0.1,
      minBandwidthMbps: 5,
      maxParticipantsPerRelay: 5,
      reevaluationIntervalMs: 30000,
    };

    mockConference = {
      id: 'test-conference',
      participants,
      topology,
      config,
      createdAt: Date.now() - 20000,
      lastTopologyUpdate: Date.now() - 1000,
    };

    monitor.setConference(mockConference);
  });

  describe('getTopologySnapshot', () => {
    it('should return topology snapshot with relay assignments', () => {
      const snapshot: TopologySnapshot = monitor.getTopologySnapshot();

      expect(snapshot.topology).toBe(mockConference.topology);
      expect(snapshot.relayNodeAssignments).toHaveLength(2);
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });

    it('should throw error when no conference is set', () => {
      const emptyMonitor = new Monitor();
      expect(() => emptyMonitor.getTopologySnapshot()).toThrow(
        'No conference available for monitoring'
      );
    });
  });

  describe('getRelayNodeAssignments', () => {
    it('should return assignments for all relay nodes', () => {
      const assignments: RelayNodeAssignment[] = monitor.getRelayNodeAssignments();

      expect(assignments).toHaveLength(2);

      const relay1Assignment = assignments.find((a) => a.relayNodeId === 'relay1');
      expect(relay1Assignment).toBeDefined();
      expect(relay1Assignment!.assignedRegularNodes).toEqual(['regular1', 'regular2']);
      expect(relay1Assignment!.connectedRelayNodes).toEqual(['relay2']);
      expect(relay1Assignment!.groupSize).toBe(2);
      expect(relay1Assignment!.loadFactor).toBe(2 / 5); // 2 members / 5 max

      const relay2Assignment = assignments.find((a) => a.relayNodeId === 'relay2');
      expect(relay2Assignment).toBeDefined();
      expect(relay2Assignment!.assignedRegularNodes).toEqual(['regular3']);
      expect(relay2Assignment!.connectedRelayNodes).toEqual(['relay1']);
      expect(relay2Assignment!.groupSize).toBe(1);
      expect(relay2Assignment!.loadFactor).toBe(1 / 5); // 1 member / 5 max
    });

    it('should return empty array when no conference is set', () => {
      const emptyMonitor = new Monitor();
      const assignments = emptyMonitor.getRelayNodeAssignments();
      expect(assignments).toEqual([]);
    });

    it('should include relay node metrics in assignments', () => {
      const assignments = monitor.getRelayNodeAssignments();
      const relay1Assignment = assignments.find((a) => a.relayNodeId === 'relay1');

      expect(relay1Assignment!.metrics.participantId).toBe('relay1');
      expect(relay1Assignment!.metrics.bandwidth.uploadMbps).toBe(10);
    });
  });

  describe('getConnectionQuality', () => {
    beforeEach(() => {
      // Add mock connection stats
      const mockStats: PeerConnectionStats = {
        remoteParticipantId: 'relay1',
        rttMs: 50,
        packetLossPercent: 0.5,
        jitterMs: 10,
        bytesReceived: 1000000,
        bytesSent: 500000,
        connectionState: 'connected',
        iceConnectionState: 'connected',
      };

      monitor.updateConnectionStats('regular1', 'relay1', mockStats);
    });

    it('should return connection quality for a participant', () => {
      const quality: ConnectionQualityMetrics | null =
        monitor.getConnectionQuality('regular1');

      expect(quality).not.toBeNull();
      expect(quality!.participantId).toBe('regular1');
      expect(quality!.overallQuality).toBe('excellent');
      expect(quality!.timestamp).toBeGreaterThan(0);
    });

    it('should return null for non-existent participant', () => {
      const quality = monitor.getConnectionQuality('non-existent');
      expect(quality).toBeNull();
    });

    it('should calculate quality as poor with high packet loss', () => {
      const poorStats: PeerConnectionStats = {
        remoteParticipantId: 'relay1',
        rttMs: 50,
        packetLossPercent: 10, // High packet loss
        jitterMs: 10,
        bytesReceived: 1000000,
        bytesSent: 500000,
        connectionState: 'connected',
        iceConnectionState: 'connected',
      };

      monitor.updateConnectionStats('regular2', 'relay1', poorStats);
      const quality = monitor.getConnectionQuality('regular2');

      expect(quality!.overallQuality).toBe('poor');
    });

    it('should calculate quality as fair with moderate issues', () => {
      const fairStats: PeerConnectionStats = {
        remoteParticipantId: 'relay1',
        rttMs: 160, // Moderate RTT
        packetLossPercent: 2.5,
        jitterMs: 35,
        bytesReceived: 1000000,
        bytesSent: 500000,
        connectionState: 'connected',
        iceConnectionState: 'connected',
      };

      monitor.updateConnectionStats('regular2', 'relay1', fairStats);
      const quality = monitor.getConnectionQuality('regular2');

      expect(quality!.overallQuality).toBe('fair');
    });

    it('should calculate quality as good with minor issues', () => {
      const goodStats: PeerConnectionStats = {
        remoteParticipantId: 'relay1',
        rttMs: 60,
        packetLossPercent: 1,
        jitterMs: 15,
        bytesReceived: 1000000,
        bytesSent: 500000,
        connectionState: 'connected',
        iceConnectionState: 'connected',
      };

      monitor.updateConnectionStats('regular2', 'relay1', goodStats);
      const quality = monitor.getConnectionQuality('regular2');

      expect(quality!.overallQuality).toBe('good');
    });
  });

  describe('getAllConnectionQuality', () => {
    it('should return quality metrics for all participants', () => {
      const allQuality = monitor.getAllConnectionQuality();

      expect(allQuality.size).toBe(5); // All participants
      expect(allQuality.has('relay1')).toBe(true);
      expect(allQuality.has('regular1')).toBe(true);
    });

    it('should return empty map when no conference is set', () => {
      const emptyMonitor = new Monitor();
      const allQuality = emptyMonitor.getAllConnectionQuality();
      expect(allQuality.size).toBe(0);
    });
  });

  describe('getConferenceState', () => {
    it('should return current conference state', () => {
      const state = monitor.getConferenceState();
      expect(state).toBe(mockConference);
    });

    it('should return null when no conference is set', () => {
      const emptyMonitor = new Monitor();
      const state = emptyMonitor.getConferenceState();
      expect(state).toBeNull();
    });
  });
});

describe('Monitor - Edge Cases', () => {
  describe('monitoring with no active conference', () => {
    it('should handle getTopologySnapshot when no conference is set', () => {
      const monitor = new Monitor();
      expect(() => monitor.getTopologySnapshot()).toThrow(
        'No conference available for monitoring'
      );
    });

    it('should return empty array for getRelayNodeAssignments when no conference', () => {
      const monitor = new Monitor();
      const assignments = monitor.getRelayNodeAssignments();
      expect(assignments).toEqual([]);
    });

    it('should return null for getConnectionQuality when no conference', () => {
      const monitor = new Monitor();
      const quality = monitor.getConnectionQuality('any-id');
      expect(quality).toBeNull();
    });

    it('should return empty map for getAllConnectionQuality when no conference', () => {
      const monitor = new Monitor();
      const allQuality = monitor.getAllConnectionQuality();
      expect(allQuality.size).toBe(0);
    });

    it('should return null for getConferenceState when no conference', () => {
      const monitor = new Monitor();
      const state = monitor.getConferenceState();
      expect(state).toBeNull();
    });

    it('should allow setting conference to null', () => {
      const monitor = new Monitor();
      const mockConference = createMockConference();
      
      monitor.setConference(mockConference);
      expect(monitor.getConferenceState()).toBe(mockConference);
      
      monitor.setConference(null);
      expect(monitor.getConferenceState()).toBeNull();
    });
  });

  describe('monitoring during topology transitions', () => {
    it('should handle topology snapshot during relay node addition', () => {
      const monitor = new Monitor();
      const conference = createMockConference();
      
      monitor.setConference(conference);
      const snapshot1 = monitor.getTopologySnapshot();
      expect(snapshot1.topology.relayNodes).toHaveLength(2);
      const initialVersion = snapshot1.topology.version;
      
      // Simulate adding a new relay node
      conference.topology.relayNodes.push('relay3');
      conference.topology.groups.push({
        relayNodeId: 'relay3',
        regularNodeIds: [],
      });
      conference.topology.version++;
      
      const snapshot2 = monitor.getTopologySnapshot();
      expect(snapshot2.topology.relayNodes).toHaveLength(3);
      expect(snapshot2.topology.version).toBe(initialVersion + 1);
    });

    it('should handle monitoring during participant join', () => {
      const monitor = new Monitor();
      const conference = createMockConference();
      
      monitor.setConference(conference);
      const initialParticipantCount = conference.participants.size;
      
      // Add new participant
      const newParticipant: Participant = {
        id: 'new-participant',
        name: 'New Participant',
        role: 'regular',
        metrics: createMockMetrics('new-participant'),
        connections: new Map(),
        assignedRelayId: 'relay1',
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      };
      
      conference.participants.set('new-participant', newParticipant);
      conference.topology.groups[0].regularNodeIds.push('new-participant');
      
      const quality = monitor.getAllConnectionQuality();
      expect(quality.size).toBe(initialParticipantCount + 1);
    });

    it('should handle monitoring during participant leave', () => {
      const monitor = new Monitor();
      const conference = createMockConference();
      
      monitor.setConference(conference);
      const initialCount = conference.participants.size;
      
      // Remove a participant
      conference.participants.delete('regular3');
      conference.topology.groups[1].regularNodeIds = [];
      
      const quality = monitor.getAllConnectionQuality();
      expect(quality.size).toBe(initialCount - 1);
      expect(quality.has('regular3')).toBe(false);
    });

    it('should handle monitoring during relay failover', () => {
      const monitor = new Monitor();
      const conference = createMockConference();
      
      monitor.setConference(conference);
      
      // Simulate relay failure - remove relay2 and reassign its members
      conference.participants.delete('relay2');
      conference.topology.relayNodes = ['relay1'];
      conference.topology.groups[0].regularNodeIds.push('regular3');
      conference.topology.groups = [conference.topology.groups[0]];
      conference.topology.relayConnections = [];
      conference.topology.version++;
      
      const assignments = monitor.getRelayNodeAssignments();
      expect(assignments).toHaveLength(1);
      expect(assignments[0].relayNodeId).toBe('relay1');
      expect(assignments[0].assignedRegularNodes).toContain('regular3');
    });

    it('should handle rapid topology updates', () => {
      const monitor = new Monitor();
      const conference = createMockConference();
      
      monitor.setConference(conference);
      
      // Perform multiple rapid updates
      for (let i = 0; i < 10; i++) {
        conference.topology.version++;
        conference.lastTopologyUpdate = Date.now();
        
        const snapshot = monitor.getTopologySnapshot();
        expect(snapshot.topology.version).toBe(i + 2); // Initial version is 1
      }
    });

    it('should maintain consistency during concurrent reads', () => {
      const monitor = new Monitor();
      const conference = createMockConference();
      
      monitor.setConference(conference);
      
      // Simulate concurrent reads
      const snapshot1 = monitor.getTopologySnapshot();
      const assignments1 = monitor.getRelayNodeAssignments();
      const quality1 = monitor.getAllConnectionQuality();
      
      // All should reflect the same state
      expect(snapshot1.relayNodeAssignments).toEqual(assignments1);
      expect(quality1.size).toBe(conference.participants.size);
    });
  });

  describe('log rotation and storage', () => {
    it('should respect max events limit', () => {
      const logger = new Logger();
      logger.setMaxEvents(100);
      
      // Log 150 events
      for (let i = 0; i < 150; i++) {
        logger.logEvent({
          type: EventType.PARTICIPANT_JOIN,
          message: `Event ${i}`,
        });
      }
      
      const events = logger.getEvents();
      expect(events).toHaveLength(100);
      // Should keep the most recent 100
      expect(events[0].message).toBe('Event 50');
      expect(events[99].message).toBe('Event 149');
    });

    it('should handle setting max events to smaller value', () => {
      const logger = new Logger();
      
      // Log 100 events
      for (let i = 0; i < 100; i++) {
        logger.logEvent({
          type: EventType.PARTICIPANT_JOIN,
          message: `Event ${i}`,
        });
      }
      
      expect(logger.getEvents()).toHaveLength(100);
      
      // Reduce max to 50
      logger.setMaxEvents(50);
      
      const events = logger.getEvents();
      expect(events).toHaveLength(50);
      expect(events[0].message).toBe('Event 50');
    });

    it('should handle very large event logs efficiently', () => {
      const logger = new Logger();
      logger.setMaxEvents(10000);
      
      const startTime = Date.now();
      
      // Log 10000 events
      for (let i = 0; i < 10000; i++) {
        logger.logEvent({
          type: EventType.PARTICIPANT_JOIN,
          conferenceId: `conf-${i % 10}`,
          message: `Event ${i}`,
        });
      }
      
      const logTime = Date.now() - startTime;
      
      // Should complete in reasonable time (< 1 second)
      expect(logTime).toBeLessThan(1000);
      expect(logger.getEvents()).toHaveLength(10000);
    });

    it('should filter large event logs efficiently', () => {
      const logger = new Logger();
      logger.setMaxEvents(5000);
      
      // Log 5000 events across different conferences
      for (let i = 0; i < 5000; i++) {
        logger.logEvent({
          type: i % 2 === 0 ? EventType.PARTICIPANT_JOIN : EventType.PARTICIPANT_LEAVE,
          conferenceId: `conf-${i % 5}`,
          message: `Event ${i}`,
        });
      }
      
      const startTime = Date.now();
      
      // Filter by conference
      const conf0Events = logger.getEvents({ conferenceId: 'conf-0' });
      
      const filterTime = Date.now() - startTime;
      
      // Should filter efficiently (< 100ms)
      expect(filterTime).toBeLessThan(100);
      expect(conf0Events.length).toBe(1000); // 5000 / 5 conferences
    });

    it('should handle clearing large event logs', () => {
      const logger = new Logger();
      
      // Log many events
      for (let i = 0; i < 1000; i++) {
        logger.logEvent({
          type: EventType.PARTICIPANT_JOIN,
          message: `Event ${i}`,
        });
      }
      
      expect(logger.getEvents()).toHaveLength(1000);
      
      logger.clearEvents();
      
      expect(logger.getEvents()).toHaveLength(0);
      
      // Should be able to log again after clearing
      logger.logEvent({
        type: EventType.PARTICIPANT_JOIN,
        message: 'New event',
      });
      
      expect(logger.getEvents()).toHaveLength(1);
    });

    it('should maintain event order during rotation', () => {
      const logger = new Logger();
      logger.setMaxEvents(10);
      
      // Log 20 events with timestamps
      for (let i = 0; i < 20; i++) {
        logger.logEvent({
          type: EventType.PARTICIPANT_JOIN,
          message: `Event ${i}`,
        });
      }
      
      const events = logger.getEvents();
      
      // Should have most recent 10 events in order
      expect(events).toHaveLength(10);
      for (let i = 0; i < 9; i++) {
        expect(events[i].timestamp).toBeLessThanOrEqual(events[i + 1].timestamp);
      }
    });

    it('should handle time-based filtering with rotation', () => {
      const logger = new Logger();
      logger.setMaxEvents(50);
      
      const now = Date.now();
      
      // Log events over time
      for (let i = 0; i < 100; i++) {
        logger.logEvent({
          type: EventType.PARTICIPANT_JOIN,
          message: `Event ${i}`,
        });
      }
      
      // Filter by time range (should only get recent events due to rotation)
      const recentEvents = logger.getEvents({
        startTime: now,
      });
      
      expect(recentEvents.length).toBeLessThanOrEqual(50);
      expect(recentEvents.every((e) => e.timestamp >= now)).toBe(true);
    });
  });
});

// Helper function to create mock conference
function createMockConference(): Conference {
  const topology: ConnectionTopology = {
    version: 1,
    timestamp: Date.now(),
    relayNodes: ['relay1', 'relay2'],
    groups: [
      {
        relayNodeId: 'relay1',
        regularNodeIds: ['regular1', 'regular2'],
      },
      {
        relayNodeId: 'relay2',
        regularNodeIds: ['regular3'],
      },
    ],
    relayConnections: [['relay1', 'relay2']],
  };

  const participants = new Map<string, Participant>();
  participants.set('relay1', {
    id: 'relay1',
    name: 'Relay 1',
    role: 'relay',
    metrics: createMockMetrics('relay1'),
    connections: new Map(),
    groupMembers: ['regular1', 'regular2'],
    joinedAt: Date.now() - 10000,
    lastSeen: Date.now(),
  });
  participants.set('relay2', {
    id: 'relay2',
    name: 'Relay 2',
    role: 'relay',
    metrics: createMockMetrics('relay2'),
    connections: new Map(),
    groupMembers: ['regular3'],
    joinedAt: Date.now() - 10000,
    lastSeen: Date.now(),
  });
  participants.set('regular1', {
    id: 'regular1',
    name: 'Regular 1',
    role: 'regular',
    metrics: createMockMetrics('regular1'),
    connections: new Map(),
    assignedRelayId: 'relay1',
    joinedAt: Date.now() - 5000,
    lastSeen: Date.now(),
  });
  participants.set('regular2', {
    id: 'regular2',
    name: 'Regular 2',
    role: 'regular',
    metrics: createMockMetrics('regular2'),
    connections: new Map(),
    assignedRelayId: 'relay1',
    joinedAt: Date.now() - 5000,
    lastSeen: Date.now(),
  });
  participants.set('regular3', {
    id: 'regular3',
    name: 'Regular 3',
    role: 'regular',
    metrics: createMockMetrics('regular3'),
    connections: new Map(),
    assignedRelayId: 'relay2',
    joinedAt: Date.now() - 5000,
    lastSeen: Date.now(),
  });

  const config: SelectionConfig = {
    bandwidthWeight: 0.3,
    natWeight: 0.25,
    latencyWeight: 0.2,
    stabilityWeight: 0.15,
    deviceWeight: 0.1,
    minBandwidthMbps: 5,
    maxParticipantsPerRelay: 5,
    reevaluationIntervalMs: 30000,
  };

  return {
    id: 'test-conference',
    participants,
    topology,
    config,
    createdAt: Date.now() - 20000,
    lastTopologyUpdate: Date.now() - 1000,
  };
}

// Helper function to create mock metrics
function createMockMetrics(id: string): ParticipantMetrics {
  return {
    participantId: id,
    timestamp: Date.now(),
    bandwidth: { uploadMbps: 10, downloadMbps: 50, measurementConfidence: 0.9 },
    natType: NATType.FULL_CONE,
    latency: {
      averageRttMs: 50,
      minRttMs: 30,
      maxRttMs: 100,
      measurements: new Map(),
    },
    stability: {
      packetLossPercent: 0.5,
      jitterMs: 10,
      connectionUptime: 300,
      reconnectionCount: 0,
    },
    device: {
      cpuUsagePercent: 30,
      availableMemoryMB: 2048,
      supportedCodecs: ['VP8', 'H264'],
      hardwareAcceleration: true,
    },
  };
}

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger();
  });

  describe('logTopologyChange', () => {
    it('should log topology change event with timestamp', () => {
      logger.logTopologyChange({
        type: EventType.TOPOLOGY_CHANGE,
        conferenceId: 'test-conf',
        message: 'Topology updated due to relay selection',
        reason: 'relay-selection',
        previousTopologyVersion: 1,
        newTopologyVersion: 2,
        affectedParticipants: ['p1', 'p2'],
      });

      const events = logger.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.TOPOLOGY_CHANGE);
      expect(events[0].timestamp).toBeGreaterThan(0);
      expect(events[0].conferenceId).toBe('test-conf');
    });
  });

  describe('logRelaySelection', () => {
    it('should log relay selection event', () => {
      logger.logRelaySelection({
        type: EventType.RELAY_SELECTION,
        conferenceId: 'test-conf',
        message: 'Selected 2 relay nodes',
        selectedRelayIds: ['relay1', 'relay2'],
        candidateCount: 5,
        selectionCriteria: { minBandwidth: 5 },
      });

      const events = logger.getEvents({ type: EventType.RELAY_SELECTION });
      expect(events).toHaveLength(1);
      expect(events[0].message).toBe('Selected 2 relay nodes');
    });
  });

  describe('logRelayDemotion', () => {
    it('should log relay demotion event', () => {
      const mockMetrics: ParticipantMetrics = {
        participantId: 'relay1',
        timestamp: Date.now(),
        bandwidth: { uploadMbps: 2, downloadMbps: 10, measurementConfidence: 0.8 },
        natType: NATType.SYMMETRIC,
        latency: {
          averageRttMs: 200,
          minRttMs: 150,
          maxRttMs: 300,
          measurements: new Map(),
        },
        stability: {
          packetLossPercent: 5,
          jitterMs: 50,
          connectionUptime: 100,
          reconnectionCount: 3,
        },
        device: {
          cpuUsagePercent: 90,
          availableMemoryMB: 256,
          supportedCodecs: ['VP8'],
          hardwareAcceleration: false,
        },
      };

      logger.logRelayDemotion({
        type: EventType.RELAY_DEMOTION,
        conferenceId: 'test-conf',
        message: 'Relay demoted due to poor metrics',
        demotedRelayId: 'relay1',
        reason: 'Bandwidth below threshold',
        metrics: mockMetrics,
      });

      const events = logger.getEvents({ type: EventType.RELAY_DEMOTION });
      expect(events).toHaveLength(1);
      expect(events[0].message).toContain('demoted');
    });
  });

  describe('logError', () => {
    it('should log error event with details', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      logger.logError({
        type: EventType.ERROR,
        conferenceId: 'test-conf',
        message: 'Connection failed',
        errorCode: 'CONN_FAILED',
        errorMessage: 'Failed to establish peer connection',
        stackTrace: 'Error: ...',
        context: { participantId: 'p1' },
      });

      const events = logger.getEvents({ type: EventType.ERROR });
      expect(events).toHaveLength(1);
      expect(events[0].message).toBe('Connection failed');
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('getEvents', () => {
    beforeEach(() => {
      // Log multiple events
      logger.logEvent({
        type: EventType.PARTICIPANT_JOIN,
        conferenceId: 'conf1',
        message: 'Participant joined',
      });
      logger.logEvent({
        type: EventType.PARTICIPANT_LEAVE,
        conferenceId: 'conf1',
        message: 'Participant left',
      });
      logger.logEvent({
        type: EventType.PARTICIPANT_JOIN,
        conferenceId: 'conf2',
        message: 'Another participant joined',
      });
    });

    it('should return all events without filter', () => {
      const events = logger.getEvents();
      expect(events).toHaveLength(3);
    });

    it('should filter events by type', () => {
      const events = logger.getEvents({ type: EventType.PARTICIPANT_JOIN });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.type === EventType.PARTICIPANT_JOIN)).toBe(true);
    });

    it('should filter events by conferenceId', () => {
      const events = logger.getEvents({ conferenceId: 'conf1' });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.conferenceId === 'conf1')).toBe(true);
    });

    it('should filter events by time range', () => {
      const now = Date.now();
      const events = logger.getEvents({
        startTime: now - 1000,
        endTime: now + 1000,
      });
      expect(events).toHaveLength(3);
    });
  });

  describe('clearEvents', () => {
    it('should clear all logged events', () => {
      logger.logEvent({
        type: EventType.PARTICIPANT_JOIN,
        message: 'Test event',
      });

      expect(logger.getEvents()).toHaveLength(1);

      logger.clearEvents();
      expect(logger.getEvents()).toHaveLength(0);
    });
  });

  describe('event limit', () => {
    it('should trim events when exceeding max limit', () => {
      logger.setMaxEvents(5);

      // Log 10 events
      for (let i = 0; i < 10; i++) {
        logger.logEvent({
          type: EventType.PARTICIPANT_JOIN,
          message: `Event ${i}`,
        });
      }

      const events = logger.getEvents();
      expect(events).toHaveLength(5);
      // Should keep the most recent 5 events
      expect(events[0].message).toBe('Event 5');
      expect(events[4].message).toBe('Event 9');
    });
  });
});
