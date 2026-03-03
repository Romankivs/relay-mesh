// Property-Based Test for Topology Observability (Task 17.3)
// Feature: relay-mesh, Property 39: Topology Observability
// Validates: Requirements 14.1, 14.2, 14.5

import * as fc from 'fast-check';
import { Monitor, Logger, EventType } from './monitoring';
import {
  Conference,
  ConnectionTopology,
  ParticipantMetrics,
  Participant,
  NATType,
  SelectionConfig,
  ParticipantGroup,
} from './types';

describe('Property 39: Topology Observability', () => {
  // ============================================================================
  // Arbitraries (Generators) for Property-Based Testing
  // ============================================================================

  /**
   * Generate valid participant metrics
   */
  const participantMetricsArbitrary = (id: string): fc.Arbitrary<ParticipantMetrics> => {
    return fc.record({
      participantId: fc.constant(id),
      timestamp: fc.nat(),
      bandwidth: fc.record({
        uploadMbps: fc.float({ min: 1, max: 100 }),
        downloadMbps: fc.float({ min: 5, max: 500 }),
        measurementConfidence: fc.float({ min: 0, max: 1 }),
      }),
      natType: fc.constantFrom(
        NATType.OPEN,
        NATType.FULL_CONE,
        NATType.RESTRICTED,
        NATType.PORT_RESTRICTED,
        NATType.SYMMETRIC
      ),
      latency: fc.record({
        averageRttMs: fc.float({ min: 10, max: 300 }),
        minRttMs: fc.float({ min: 5, max: 100 }),
        maxRttMs: fc.float({ min: 50, max: 500 }),
        measurements: fc.constant(new Map<string, number>()),
      }),
      stability: fc.record({
        packetLossPercent: fc.float({ min: 0, max: 10 }),
        jitterMs: fc.float({ min: 0, max: 100 }),
        connectionUptime: fc.nat({ max: 10000 }),
        reconnectionCount: fc.nat({ max: 10 }),
      }),
      device: fc.record({
        cpuUsagePercent: fc.float({ min: 0, max: 100 }),
        availableMemoryMB: fc.nat({ max: 16384 }),
        supportedCodecs: fc.constant(['VP8', 'VP9', 'H264']),
        hardwareAcceleration: fc.boolean(),
      }),
    });
  };

  /**
   * Generate a valid participant
   */
  const participantArbitrary = (
    id: string,
    role: 'relay' | 'regular'
  ): fc.Arbitrary<Participant> => {
    return participantMetricsArbitrary(id).chain((metrics) => {
      return fc.record({
        id: fc.constant(id),
        name: fc.constant(`Participant ${id}`),
        role: fc.constant(role),
        metrics: fc.constant(metrics),
        connections: fc.constant(new Map()),
        assignedRelayId: role === 'regular' ? fc.string() : fc.constant(undefined),
        groupMembers: role === 'relay' ? fc.array(fc.string()) : fc.constant(undefined),
        joinedAt: fc.nat(),
        lastSeen: fc.nat(),
      });
    });
  };

  /**
   * Generate a valid topology with relay and regular nodes
   */
  const topologyArbitrary = (): fc.Arbitrary<{
    topology: ConnectionTopology;
    participants: Map<string, Participant>;
  }> => {
    return fc
      .record({
        relayCount: fc.integer({ min: 1, max: 5 }),
        regularCount: fc.integer({ min: 0, max: 15 }),
      })
      .chain(({ relayCount, regularCount }) => {
        // Generate relay node IDs
        const relayIds = Array.from({ length: relayCount }, (_, i) => `relay-${i}`);

        // Generate regular node IDs
        const regularIds = Array.from({ length: regularCount }, (_, i) => `regular-${i}`);

        // Generate groups by assigning regular nodes to relays
        const groups: ParticipantGroup[] = [];
        let regularIndex = 0;

        for (const relayId of relayIds) {
          const groupSize = Math.floor(regularCount / relayCount);
          const regularNodeIds = regularIds.slice(regularIndex, regularIndex + groupSize);
          regularIndex += groupSize;

          groups.push({
            relayNodeId: relayId,
            regularNodeIds,
          });
        }

        // Assign remaining regular nodes to first relay
        if (regularIndex < regularCount) {
          groups[0].regularNodeIds.push(...regularIds.slice(regularIndex));
        }

        // Generate relay-to-relay connections (full mesh)
        const relayConnections: Array<[string, string]> = [];
        for (let i = 0; i < relayIds.length; i++) {
          for (let j = i + 1; j < relayIds.length; j++) {
            relayConnections.push([relayIds[i], relayIds[j]]);
          }
        }

        // Generate topology
        const topology: ConnectionTopology = {
          version: 1,
          timestamp: Date.now(),
          relayNodes: relayIds,
          groups,
          relayConnections,
        };

        // Generate participants
        return fc
          .tuple(
            ...relayIds.map((id) => participantArbitrary(id, 'relay')),
            ...regularIds.map((id) => participantArbitrary(id, 'regular'))
          )
          .map((participantArray) => {
            const participants = new Map<string, Participant>();

            // Add relay participants with group members
            relayIds.forEach((relayId, index) => {
              const participant = participantArray[index];
              const group = groups.find((g) => g.relayNodeId === relayId);
              participants.set(relayId, {
                ...participant,
                groupMembers: group?.regularNodeIds || [],
              });
            });

            // Add regular participants with assigned relay
            regularIds.forEach((regularId, index) => {
              const participant = participantArray[relayCount + index];
              const assignedRelay = groups.find((g) =>
                g.regularNodeIds.includes(regularId)
              )?.relayNodeId;
              participants.set(regularId, {
                ...participant,
                assignedRelayId: assignedRelay,
              });
            });

            return { topology, participants };
          });
      });
  };

  /**
   * Generate a valid conference
   */
  const conferenceArbitrary = (): fc.Arbitrary<Conference> => {
    return topologyArbitrary().chain(({ topology, participants }) => {
      return fc.record({
        id: fc.string(),
        participants: fc.constant(participants),
        topology: fc.constant(topology),
        config: fc.constant<SelectionConfig>({
          bandwidthWeight: 0.3,
          natWeight: 0.25,
          latencyWeight: 0.2,
          stabilityWeight: 0.15,
          deviceWeight: 0.1,
          minBandwidthMbps: 5,
          maxParticipantsPerRelay: 5,
          reevaluationIntervalMs: 30000,
        }),
        createdAt: fc.nat(),
        lastTopologyUpdate: fc.nat(),
      });
    });
  };

  // ============================================================================
  // Property Tests
  // ============================================================================

  describe('Requirement 14.1: Topology structure exposure', () => {
    it('property: monitoring interface exposes current topology structure for any valid conference', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          // Create monitor and set conference
          const monitor = new Monitor();
          monitor.setConference(conference);

          // Get topology snapshot
          const snapshot = monitor.getTopologySnapshot();

          // Property: Snapshot must contain the topology
          expect(snapshot.topology).toBeDefined();
          expect(snapshot.topology).toBe(conference.topology);

          // Property: Topology structure is complete
          expect(snapshot.topology.relayNodes).toBeDefined();
          expect(snapshot.topology.groups).toBeDefined();
          expect(snapshot.topology.relayConnections).toBeDefined();

          // Property: Relay nodes match conference topology
          expect(snapshot.topology.relayNodes).toEqual(conference.topology.relayNodes);

          // Property: Groups match conference topology
          expect(snapshot.topology.groups.length).toBe(conference.topology.groups.length);

          // Property: Relay connections match conference topology
          expect(snapshot.topology.relayConnections).toEqual(
            conference.topology.relayConnections
          );

          // Property: Snapshot has timestamp
          expect(snapshot.timestamp).toBeGreaterThan(0);
        }),
        { numRuns: 100 }
      );
    });

    it('property: topology snapshot includes relay node assignments for all relay nodes', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const snapshot = monitor.getTopologySnapshot();

          // Property: Relay node assignments are included
          expect(snapshot.relayNodeAssignments).toBeDefined();
          expect(Array.isArray(snapshot.relayNodeAssignments)).toBe(true);

          // Property: One assignment per relay node
          expect(snapshot.relayNodeAssignments.length).toBe(
            conference.topology.relayNodes.length
          );

          // Property: Each relay node has an assignment
          for (const relayId of conference.topology.relayNodes) {
            const assignment = snapshot.relayNodeAssignments.find(
              (a) => a.relayNodeId === relayId
            );
            expect(assignment).toBeDefined();
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Requirement 14.2: Relay node assignments and metrics exposure', () => {
    it('property: relay node assignments expose assigned regular nodes for any topology', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const assignments = monitor.getRelayNodeAssignments();

          // Property: Each assignment includes assigned regular nodes
          for (const assignment of assignments) {
            expect(assignment.assignedRegularNodes).toBeDefined();
            expect(Array.isArray(assignment.assignedRegularNodes)).toBe(true);

            // Property: Assigned nodes match topology groups
            const group = conference.topology.groups.find(
              (g) => g.relayNodeId === assignment.relayNodeId
            );
            expect(group).toBeDefined();
            expect(assignment.assignedRegularNodes).toEqual(group!.regularNodeIds);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('property: relay node assignments expose connected relay nodes for any topology', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const assignments = monitor.getRelayNodeAssignments();

          // Property: Each assignment includes connected relay nodes
          for (const assignment of assignments) {
            expect(assignment.connectedRelayNodes).toBeDefined();
            expect(Array.isArray(assignment.connectedRelayNodes)).toBe(true);

            // Property: Connected relays match topology relay connections
            const expectedConnections = conference.topology.relayConnections
              .filter(
                ([a, b]) => a === assignment.relayNodeId || b === assignment.relayNodeId
              )
              .map(([a, b]) => (a === assignment.relayNodeId ? b : a));

            expect(assignment.connectedRelayNodes.sort()).toEqual(
              expectedConnections.sort()
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    it('property: relay node assignments expose metrics for all relay nodes', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const assignments = monitor.getRelayNodeAssignments();

          // Property: Each assignment includes relay node metrics
          for (const assignment of assignments) {
            expect(assignment.metrics).toBeDefined();

            // Property: Metrics match participant metrics
            const participant = conference.participants.get(assignment.relayNodeId);
            expect(participant).toBeDefined();
            expect(assignment.metrics).toBe(participant!.metrics);

            // Property: Metrics contain all required fields
            expect(assignment.metrics.participantId).toBe(assignment.relayNodeId);
            expect(assignment.metrics.bandwidth).toBeDefined();
            expect(assignment.metrics.natType).toBeDefined();
            expect(assignment.metrics.latency).toBeDefined();
            expect(assignment.metrics.stability).toBeDefined();
            expect(assignment.metrics.device).toBeDefined();
          }
        }),
        { numRuns: 100 }
      );
    });

    it('property: relay node assignments include group size and load factor', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const assignments = monitor.getRelayNodeAssignments();

          // Property: Each assignment includes group size and load factor
          for (const assignment of assignments) {
            expect(assignment.groupSize).toBeDefined();
            expect(assignment.loadFactor).toBeDefined();

            // Property: Group size matches number of assigned regular nodes
            expect(assignment.groupSize).toBe(assignment.assignedRegularNodes.length);

            // Property: Load factor is correctly calculated
            const expectedLoadFactor =
              assignment.groupSize / conference.config.maxParticipantsPerRelay;
            expect(assignment.loadFactor).toBeCloseTo(expectedLoadFactor, 10);

            // Property: Load factor is in valid range [0, infinity)
            expect(assignment.loadFactor).toBeGreaterThanOrEqual(0);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Requirement 14.5: Connection quality metrics exposure', () => {
    it('property: connection quality is exposed for all participants', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const allQuality = monitor.getAllConnectionQuality();

          // Property: Quality metrics exist for all participants
          expect(allQuality.size).toBe(conference.participants.size);

          // Property: Each participant has quality metrics
          for (const participantId of conference.participants.keys()) {
            expect(allQuality.has(participantId)).toBe(true);

            const quality = allQuality.get(participantId);
            expect(quality).toBeDefined();
            expect(quality!.participantId).toBe(participantId);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('property: connection quality includes timestamp for any participant', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          // Get quality for each participant
          for (const participantId of conference.participants.keys()) {
            const quality = monitor.getConnectionQuality(participantId);

            // Property: Quality includes timestamp
            expect(quality).not.toBeNull();
            expect(quality!.timestamp).toBeGreaterThan(0);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('property: connection quality includes overall quality assessment', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const allQuality = monitor.getAllConnectionQuality();

          // Property: Each quality metric includes overall quality
          for (const quality of allQuality.values()) {
            expect(quality.overallQuality).toBeDefined();

            // Property: Overall quality is one of the valid values
            expect(['excellent', 'good', 'fair', 'poor']).toContain(quality.overallQuality);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('property: connection quality includes connection stats map', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const allQuality = monitor.getAllConnectionQuality();

          // Property: Each quality metric includes connection stats
          for (const quality of allQuality.values()) {
            expect(quality.connectionStats).toBeDefined();
            expect(quality.connectionStats instanceof Map).toBe(true);

            // Property: Connected participants list is defined
            expect(quality.connectedTo).toBeDefined();
            expect(Array.isArray(quality.connectedTo)).toBe(true);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Combined observability properties', () => {
    it('property: all topology information is accessible through monitoring interface', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          // Property: Can access topology snapshot
          const snapshot = monitor.getTopologySnapshot();
          expect(snapshot).toBeDefined();
          expect(snapshot.topology).toBeDefined();

          // Property: Can access relay assignments
          const assignments = monitor.getRelayNodeAssignments();
          expect(assignments).toBeDefined();
          expect(assignments.length).toBeGreaterThan(0);

          // Property: Can access connection quality
          const allQuality = monitor.getAllConnectionQuality();
          expect(allQuality).toBeDefined();
          expect(allQuality.size).toBeGreaterThan(0);

          // Property: Can access conference state
          const state = monitor.getConferenceState();
          expect(state).toBeDefined();
          expect(state).toBe(conference);

          // Property: All information is consistent
          expect(snapshot.topology).toBe(state!.topology);
          expect(assignments.length).toBe(state!.topology.relayNodes.length);
          expect(allQuality.size).toBe(state!.participants.size);
        }),
        { numRuns: 100 }
      );
    });

    it('property: monitoring interface provides complete view of conference state at any point in time', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const snapshot = monitor.getTopologySnapshot();

          // Property: Snapshot captures complete topology state
          expect(snapshot.topology.version).toBe(conference.topology.version);
          expect(snapshot.topology.relayNodes.length).toBe(
            conference.topology.relayNodes.length
          );
          expect(snapshot.topology.groups.length).toBe(conference.topology.groups.length);

          // Property: All relay nodes are represented in assignments
          const assignments = snapshot.relayNodeAssignments;
          const assignmentIds = assignments.map((a) => a.relayNodeId);
          for (const relayId of conference.topology.relayNodes) {
            expect(assignmentIds).toContain(relayId);
          }

          // Property: All participants are represented in quality metrics
          const allQuality = monitor.getAllConnectionQuality();
          for (const participantId of conference.participants.keys()) {
            expect(allQuality.has(participantId)).toBe(true);
          }

          // Property: Snapshot timestamp is recent
          const now = Date.now();
          expect(snapshot.timestamp).toBeLessThanOrEqual(now);
          expect(snapshot.timestamp).toBeGreaterThan(now - 10000); // Within last 10 seconds
        }),
        { numRuns: 100 }
      );
    });

    it('property: monitoring interface handles conferences with varying sizes', () => {
      fc.assert(
        fc.property(conferenceArbitrary(), (conference) => {
          const monitor = new Monitor();
          monitor.setConference(conference);

          const participantCount = conference.participants.size;
          const relayCount = conference.topology.relayNodes.length;

          // Property: Monitoring works for any conference size
          const snapshot = monitor.getTopologySnapshot();
          expect(snapshot).toBeDefined();

          // Property: Assignments match relay count
          expect(snapshot.relayNodeAssignments.length).toBe(relayCount);

          // Property: Quality metrics match participant count
          const allQuality = monitor.getAllConnectionQuality();
          expect(allQuality.size).toBe(participantCount);

          // Property: All data structures are consistent
          const assignments = monitor.getRelayNodeAssignments();
          const totalAssignedRegulars = assignments.reduce(
            (sum, a) => sum + a.assignedRegularNodes.length,
            0
          );
          const regularCount = participantCount - relayCount;
          expect(totalAssignedRegulars).toBe(regularCount);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Edge cases and error handling', () => {
    it('property: monitoring interface handles empty conference gracefully', () => {
      fc.assert(
        fc.property(fc.constant(null), () => {
          const monitor = new Monitor();
          monitor.setConference(null);

          // Property: Returns empty results for null conference
          expect(monitor.getRelayNodeAssignments()).toEqual([]);
          expect(monitor.getAllConnectionQuality().size).toBe(0);
          expect(monitor.getConferenceState()).toBeNull();

          // Property: Throws error for topology snapshot (requires conference)
          expect(() => monitor.getTopologySnapshot()).toThrow();
        }),
        { numRuns: 10 }
      );
    });

    it('property: monitoring interface handles conference updates', () => {
      fc.assert(
        fc.property(
          conferenceArbitrary(),
          conferenceArbitrary(),
          (conference1, conference2) => {
            const monitor = new Monitor();

            // Set first conference
            monitor.setConference(conference1);
            const snapshot1 = monitor.getTopologySnapshot();
            expect(snapshot1.topology).toBe(conference1.topology);

            // Update to second conference
            monitor.setConference(conference2);
            const snapshot2 = monitor.getTopologySnapshot();

            // Property: Snapshot reflects updated conference
            expect(snapshot2.topology).toBe(conference2.topology);
            expect(snapshot2.topology).not.toBe(conference1.topology);

            // Property: Assignments reflect updated conference
            const assignments2 = monitor.getRelayNodeAssignments();
            expect(assignments2.length).toBe(conference2.topology.relayNodes.length);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});

// ============================================================================
// Property 40: Event Logging Completeness (Task 17.5)
// Feature: relay-mesh, Property 40: Event Logging Completeness
// Validates: Requirements 14.3, 14.4, 14.6
// ============================================================================

describe('Property 40: Event Logging Completeness', () => {
  // ============================================================================
  // Arbitraries for Event Generation
  // ============================================================================

  /**
   * Generate a topology change event
   */
  const topologyChangeEventArbitrary = fc.record({
    type: fc.constant(EventType.TOPOLOGY_CHANGE),
    conferenceId: fc.string(),
    message: fc.string(),
    reason: fc.constantFrom(
      'relay-selection' as const,
      'participant-join' as const,
      'participant-leave' as const,
      'relay-failure' as const
    ),
    previousTopologyVersion: fc.nat(),
    newTopologyVersion: fc.nat(),
    affectedParticipants: fc.array(fc.string(), { minLength: 1, maxLength: 10 }),
  });

  /**
   * Generate a relay selection event
   */
  const relaySelectionEventArbitrary = fc.record({
    type: fc.constant(EventType.RELAY_SELECTION),
    conferenceId: fc.string(),
    message: fc.string(),
    selectedRelayIds: fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
    candidateCount: fc.nat({ max: 50 }),
    selectionCriteria: fc.constant({ minBandwidth: 5 }),
  });

  /**
   * Generate a relay demotion event
   */
  const relayDemotionEventArbitrary = fc.string().chain((id) => {
    return fc.record({
      participantId: fc.constant(id),
      timestamp: fc.nat(),
      bandwidth: fc.record({
        uploadMbps: fc.float({ min: 1, max: 100 }),
        downloadMbps: fc.float({ min: 5, max: 500 }),
        measurementConfidence: fc.float({ min: 0, max: 1 }),
      }),
      natType: fc.constantFrom(
        NATType.OPEN,
        NATType.FULL_CONE,
        NATType.RESTRICTED,
        NATType.PORT_RESTRICTED,
        NATType.SYMMETRIC
      ),
      latency: fc.record({
        averageRttMs: fc.float({ min: 10, max: 300 }),
        minRttMs: fc.float({ min: 5, max: 100 }),
        maxRttMs: fc.float({ min: 50, max: 500 }),
        measurements: fc.constant(new Map<string, number>()),
      }),
      stability: fc.record({
        packetLossPercent: fc.float({ min: 0, max: 10 }),
        jitterMs: fc.float({ min: 0, max: 100 }),
        connectionUptime: fc.nat({ max: 10000 }),
        reconnectionCount: fc.nat({ max: 10 }),
      }),
      device: fc.record({
        cpuUsagePercent: fc.float({ min: 0, max: 100 }),
        availableMemoryMB: fc.nat({ max: 16384 }),
        supportedCodecs: fc.constant(['VP8', 'VP9', 'H264']),
        hardwareAcceleration: fc.boolean(),
      }),
    }).map((metrics) => ({
      type: EventType.RELAY_DEMOTION,
      conferenceId: id,
      message: `Relay ${id} demoted`,
      demotedRelayId: id,
      reason: 'Poor metrics',
      metrics,
    }));
  });

  /**
   * Generate an error event
   */
  const errorEventArbitrary = fc.record({
    type: fc.constant(EventType.ERROR),
    conferenceId: fc.string(),
    message: fc.string(),
    errorCode: fc.option(fc.string()),
    errorMessage: fc.string(),
    stackTrace: fc.option(fc.string()),
    context: fc.option(fc.constant({ key: 'value' })),
  });

  /**
   * Generate any significant event
   */
  const significantEventArbitrary = fc.oneof(
    topologyChangeEventArbitrary,
    relaySelectionEventArbitrary,
    relayDemotionEventArbitrary,
    errorEventArbitrary
  );

  // ============================================================================
  // Property Tests
  // ============================================================================

  describe('Requirement 14.3: Topology change logging', () => {
    it('property: all topology change events are logged with timestamps', () => {
      fc.assert(
        fc.property(
          fc.array(topologyChangeEventArbitrary, { minLength: 1, maxLength: 20 }),
          (events) => {
            const logger = new Logger();
            const beforeTime = Date.now();

            // Log all topology change events
            for (const event of events) {
              logger.logTopologyChange(event as any);
            }

            const afterTime = Date.now();
            const loggedEvents = logger.getEvents({ type: EventType.TOPOLOGY_CHANGE });

            // Property: All events are logged
            expect(loggedEvents.length).toBe(events.length);

            // Property: Each event has a timestamp
            for (const loggedEvent of loggedEvents) {
              expect(loggedEvent.timestamp).toBeDefined();
              expect(typeof loggedEvent.timestamp).toBe('number');
              expect(loggedEvent.timestamp).toBeGreaterThan(0);

              // Property: Timestamp is within reasonable range
              expect(loggedEvent.timestamp).toBeGreaterThanOrEqual(beforeTime);
              expect(loggedEvent.timestamp).toBeLessThanOrEqual(afterTime);
            }

            // Property: Events contain all required fields
            for (let i = 0; i < events.length; i++) {
              const original = events[i];
              const logged = loggedEvents[i];

              expect(logged.type).toBe(EventType.TOPOLOGY_CHANGE);
              expect(logged.conferenceId).toBe(original.conferenceId);
              expect(logged.message).toBe(original.message);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('property: topology change events include all required details', () => {
      fc.assert(
        fc.property(topologyChangeEventArbitrary, (event) => {
          const logger = new Logger();
          logger.logTopologyChange(event as any);

          const loggedEvents = logger.getEvents({ type: EventType.TOPOLOGY_CHANGE });
          const loggedEvent = loggedEvents[0] as any;

          // Property: Event includes reason
          expect(loggedEvent.reason).toBe(event.reason);

          // Property: Event includes topology versions
          expect(loggedEvent.previousTopologyVersion).toBe(event.previousTopologyVersion);
          expect(loggedEvent.newTopologyVersion).toBe(event.newTopologyVersion);

          // Property: Event includes affected participants
          expect(loggedEvent.affectedParticipants).toEqual(event.affectedParticipants);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Requirement 14.4: Relay selection and demotion logging', () => {
    it('property: all relay selection events are logged with timestamps', () => {
      fc.assert(
        fc.property(
          fc.array(relaySelectionEventArbitrary, { minLength: 1, maxLength: 20 }),
          (events) => {
            const logger = new Logger();
            const beforeTime = Date.now();

            // Log all relay selection events
            for (const event of events) {
              logger.logRelaySelection(event as any);
            }

            const afterTime = Date.now();
            const loggedEvents = logger.getEvents({ type: EventType.RELAY_SELECTION });

            // Property: All events are logged
            expect(loggedEvents.length).toBe(events.length);

            // Property: Each event has a timestamp
            for (const loggedEvent of loggedEvents) {
              expect(loggedEvent.timestamp).toBeDefined();
              expect(loggedEvent.timestamp).toBeGreaterThanOrEqual(beforeTime);
              expect(loggedEvent.timestamp).toBeLessThanOrEqual(afterTime);
            }

            // Property: Events contain selection details
            for (let i = 0; i < events.length; i++) {
              const original = events[i];
              const logged = loggedEvents[i] as any;

              expect(logged.selectedRelayIds).toEqual(original.selectedRelayIds);
              expect(logged.candidateCount).toBe(original.candidateCount);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('property: all relay demotion events are logged with timestamps', () => {
      fc.assert(
        fc.property(
          fc.array(relayDemotionEventArbitrary, { minLength: 1, maxLength: 20 }),
          (events) => {
            const logger = new Logger();
            const beforeTime = Date.now();

            // Log all relay demotion events
            for (const event of events) {
              logger.logRelayDemotion(event as any);
            }

            const afterTime = Date.now();
            const loggedEvents = logger.getEvents({ type: EventType.RELAY_DEMOTION });

            // Property: All events are logged
            expect(loggedEvents.length).toBe(events.length);

            // Property: Each event has a timestamp
            for (const loggedEvent of loggedEvents) {
              expect(loggedEvent.timestamp).toBeDefined();
              expect(loggedEvent.timestamp).toBeGreaterThanOrEqual(beforeTime);
              expect(loggedEvent.timestamp).toBeLessThanOrEqual(afterTime);
            }

            // Property: Events contain demotion details
            for (let i = 0; i < events.length; i++) {
              const original = events[i];
              const logged = loggedEvents[i] as any;

              expect(logged.demotedRelayId).toBe(original.demotedRelayId);
              expect(logged.reason).toBe(original.reason);
              expect(logged.metrics).toBeDefined();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Requirement 14.6: Error logging', () => {
    it('property: all error events are logged with timestamps', () => {
      fc.assert(
        fc.property(
          fc.array(errorEventArbitrary, { minLength: 1, maxLength: 20 }),
          (events) => {
            const logger = new Logger();
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            const beforeTime = Date.now();

            // Log all error events
            for (const event of events) {
              logger.logError(event as any);
            }

            const afterTime = Date.now();
            const loggedEvents = logger.getEvents({ type: EventType.ERROR });

            // Property: All events are logged
            expect(loggedEvents.length).toBe(events.length);

            // Property: Each event has a timestamp
            for (const loggedEvent of loggedEvents) {
              expect(loggedEvent.timestamp).toBeDefined();
              expect(loggedEvent.timestamp).toBeGreaterThanOrEqual(beforeTime);
              expect(loggedEvent.timestamp).toBeLessThanOrEqual(afterTime);
            }

            // Property: Events contain error details
            for (let i = 0; i < events.length; i++) {
              const original = events[i];
              const logged = loggedEvents[i] as any;

              expect(logged.errorMessage).toBe(original.errorMessage);
            }

            // Property: Errors are also logged to console
            expect(consoleErrorSpy).toHaveBeenCalledTimes(events.length);

            consoleErrorSpy.mockRestore();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('property: error events include detailed information', () => {
      fc.assert(
        fc.property(errorEventArbitrary, (event) => {
          const logger = new Logger();
          const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

          logger.logError(event as any);

          const loggedEvents = logger.getEvents({ type: EventType.ERROR });
          const loggedEvent = loggedEvents[0] as any;

          // Property: Event includes error message
          expect(loggedEvent.errorMessage).toBe(event.errorMessage);

          // Property: Event includes optional fields if provided
          if (event.errorCode !== null) {
            expect(loggedEvent.errorCode).toBe(event.errorCode);
          }
          if (event.stackTrace !== null) {
            expect(loggedEvent.stackTrace).toBe(event.stackTrace);
          }
          if (event.context !== null) {
            expect(loggedEvent.context).toEqual(event.context);
          }

          consoleErrorSpy.mockRestore();
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Combined event logging properties', () => {
    it('property: all significant events are logged with timestamps regardless of type', () => {
      fc.assert(
        fc.property(
          fc.array(significantEventArbitrary, { minLength: 5, maxLength: 50 }),
          (events) => {
            const logger = new Logger();
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            const beforeTime = Date.now();

            // Log all events
            for (const event of events) {
              switch (event.type) {
                case EventType.TOPOLOGY_CHANGE:
                  logger.logTopologyChange(event as any);
                  break;
                case EventType.RELAY_SELECTION:
                  logger.logRelaySelection(event as any);
                  break;
                case EventType.RELAY_DEMOTION:
                  logger.logRelayDemotion(event as any);
                  break;
                case EventType.ERROR:
                  logger.logError(event as any);
                  break;
              }
            }

            const afterTime = Date.now();
            const allLoggedEvents = logger.getEvents();

            // Property: All events are logged
            expect(allLoggedEvents.length).toBe(events.length);

            // Property: Each event has a valid timestamp
            for (const loggedEvent of allLoggedEvents) {
              expect(loggedEvent.timestamp).toBeDefined();
              expect(typeof loggedEvent.timestamp).toBe('number');
              expect(loggedEvent.timestamp).toBeGreaterThan(0);
              expect(loggedEvent.timestamp).toBeGreaterThanOrEqual(beforeTime);
              expect(loggedEvent.timestamp).toBeLessThanOrEqual(afterTime);
            }

            // Property: Events maintain insertion order
            for (let i = 0; i < events.length; i++) {
              expect(allLoggedEvents[i].type).toBe(events[i].type);
              expect(allLoggedEvents[i].message).toBe(events[i].message);
            }

            // Property: Timestamps are monotonically increasing or equal
            for (let i = 1; i < allLoggedEvents.length; i++) {
              expect(allLoggedEvents[i].timestamp).toBeGreaterThanOrEqual(
                allLoggedEvents[i - 1].timestamp
              );
            }

            consoleErrorSpy.mockRestore();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('property: logged events can be filtered by type', () => {
      fc.assert(
        fc.property(
          fc.array(significantEventArbitrary, { minLength: 10, maxLength: 30 }),
          (events) => {
            const logger = new Logger();
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

            // Log all events
            for (const event of events) {
              switch (event.type) {
                case EventType.TOPOLOGY_CHANGE:
                  logger.logTopologyChange(event as any);
                  break;
                case EventType.RELAY_SELECTION:
                  logger.logRelaySelection(event as any);
                  break;
                case EventType.RELAY_DEMOTION:
                  logger.logRelayDemotion(event as any);
                  break;
                case EventType.ERROR:
                  logger.logError(event as any);
                  break;
              }
            }

            // Property: Can filter by each event type
            const eventTypes = [
              EventType.TOPOLOGY_CHANGE,
              EventType.RELAY_SELECTION,
              EventType.RELAY_DEMOTION,
              EventType.ERROR,
            ];

            for (const eventType of eventTypes) {
              const filteredEvents = logger.getEvents({ type: eventType });
              const expectedCount = events.filter((e) => e.type === eventType).length;

              // Property: Filtered count matches expected
              expect(filteredEvents.length).toBe(expectedCount);

              // Property: All filtered events have correct type
              for (const event of filteredEvents) {
                expect(event.type).toBe(eventType);
              }
            }

            consoleErrorSpy.mockRestore();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('property: logged events can be filtered by conference ID', () => {
      fc.assert(
        fc.property(
          fc.array(significantEventArbitrary, { minLength: 10, maxLength: 30 }),
          (events) => {
            const logger = new Logger();
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

            // Log all events
            for (const event of events) {
              switch (event.type) {
                case EventType.TOPOLOGY_CHANGE:
                  logger.logTopologyChange(event as any);
                  break;
                case EventType.RELAY_SELECTION:
                  logger.logRelaySelection(event as any);
                  break;
                case EventType.RELAY_DEMOTION:
                  logger.logRelayDemotion(event as any);
                  break;
                case EventType.ERROR:
                  logger.logError(event as any);
                  break;
              }
            }

            // Get all logged events first
            const allLoggedEvents = logger.getEvents();

            // Get unique conference IDs from logged events (filter out empty/falsy values)
            const conferenceIds = [
              ...new Set(
                allLoggedEvents
                  .map((e) => e.conferenceId)
                  .filter((id) => id && id.trim().length > 0)
              ),
            ];

            // Property: Can filter by each non-empty conference ID
            for (const conferenceId of conferenceIds) {
              const filteredEvents = logger.getEvents({ conferenceId });

              // Count expected from logged events
              const expectedCount = allLoggedEvents.filter(
                (e) => e.conferenceId === conferenceId
              ).length;

              // Property: Filtered count matches expected
              expect(filteredEvents.length).toBe(expectedCount);

              // Property: All filtered events have correct conference ID
              for (const event of filteredEvents) {
                expect(event.conferenceId).toBe(conferenceId);
              }
            }

            consoleErrorSpy.mockRestore();
          }
        ),
        { numRuns: 100 }
      );
    });

    it('property: logged events can be filtered by time range', () => {
      fc.assert(
        fc.property(
          fc.array(significantEventArbitrary, { minLength: 10, maxLength: 30 }),
          (events) => {
            const logger = new Logger();
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
            const startTime = Date.now();

            // Log events with small delays to create time spread
            const timestamps: number[] = [];
            for (const event of events) {
              switch (event.type) {
                case EventType.TOPOLOGY_CHANGE:
                  logger.logTopologyChange(event as any);
                  break;
                case EventType.RELAY_SELECTION:
                  logger.logRelaySelection(event as any);
                  break;
                case EventType.RELAY_DEMOTION:
                  logger.logRelayDemotion(event as any);
                  break;
                case EventType.ERROR:
                  logger.logError(event as any);
                  break;
              }
              timestamps.push(Date.now());
            }

            const endTime = Date.now();

            // Property: Can filter by time range
            const allEvents = logger.getEvents();
            const midTime = startTime + (endTime - startTime) / 2;

            const beforeMid = logger.getEvents({ endTime: midTime });
            const afterMid = logger.getEvents({ startTime: midTime });

            // Property: All events are either before or after mid time
            expect(beforeMid.length + afterMid.length).toBeGreaterThanOrEqual(
              allEvents.length
            );

            // Property: Events in before range have timestamps <= midTime
            for (const event of beforeMid) {
              expect(event.timestamp).toBeLessThanOrEqual(midTime);
            }

            // Property: Events in after range have timestamps >= midTime
            for (const event of afterMid) {
              expect(event.timestamp).toBeGreaterThanOrEqual(midTime);
            }

            consoleErrorSpy.mockRestore();
          }
        ),
        { numRuns: 50 }
      );
    });

    it('property: event logging preserves all event details', () => {
      fc.assert(
        fc.property(significantEventArbitrary, (event) => {
          const logger = new Logger();
          const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

          // Log the event
          switch (event.type) {
            case EventType.TOPOLOGY_CHANGE:
              logger.logTopologyChange(event as any);
              break;
            case EventType.RELAY_SELECTION:
              logger.logRelaySelection(event as any);
              break;
            case EventType.RELAY_DEMOTION:
              logger.logRelayDemotion(event as any);
              break;
            case EventType.ERROR:
              logger.logError(event as any);
              break;
          }

          const loggedEvents = logger.getEvents();
          const loggedEvent = loggedEvents[0];

          // Property: Core fields are preserved
          expect(loggedEvent.type).toBe(event.type);
          expect(loggedEvent.conferenceId).toBe(event.conferenceId);
          expect(loggedEvent.message).toBe(event.message);

          // Property: Timestamp is added
          expect(loggedEvent.timestamp).toBeDefined();
          expect(loggedEvent.timestamp).toBeGreaterThan(0);

          consoleErrorSpy.mockRestore();
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Event logging edge cases', () => {
    it('property: logger handles rapid event logging', () => {
      fc.assert(
        fc.property(
          fc.array(significantEventArbitrary, { minLength: 50, maxLength: 100 }),
          (events) => {
            const logger = new Logger();
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

            // Log all events rapidly
            for (const event of events) {
              switch (event.type) {
                case EventType.TOPOLOGY_CHANGE:
                  logger.logTopologyChange(event as any);
                  break;
                case EventType.RELAY_SELECTION:
                  logger.logRelaySelection(event as any);
                  break;
                case EventType.RELAY_DEMOTION:
                  logger.logRelayDemotion(event as any);
                  break;
                case EventType.ERROR:
                  logger.logError(event as any);
                  break;
              }
            }

            const loggedEvents = logger.getEvents();

            // Property: All events are logged even when rapid
            expect(loggedEvents.length).toBe(events.length);

            // Property: All events have valid timestamps
            for (const event of loggedEvents) {
              expect(event.timestamp).toBeDefined();
              expect(event.timestamp).toBeGreaterThan(0);
            }

            consoleErrorSpy.mockRestore();
          }
        ),
        { numRuns: 50 }
      );
    });

    it('property: logger respects max event limit', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 50 }),
          fc.array(significantEventArbitrary, { minLength: 100, maxLength: 200 }),
          (maxEvents, events) => {
            const logger = new Logger();
            logger.setMaxEvents(maxEvents);
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

            // Log more events than the limit
            for (const event of events) {
              switch (event.type) {
                case EventType.TOPOLOGY_CHANGE:
                  logger.logTopologyChange(event as any);
                  break;
                case EventType.RELAY_SELECTION:
                  logger.logRelaySelection(event as any);
                  break;
                case EventType.RELAY_DEMOTION:
                  logger.logRelayDemotion(event as any);
                  break;
                case EventType.ERROR:
                  logger.logError(event as any);
                  break;
              }
            }

            const loggedEvents = logger.getEvents();

            // Property: Event count does not exceed max
            expect(loggedEvents.length).toBeLessThanOrEqual(maxEvents);

            // Property: Most recent events are kept (FIFO)
            if (events.length > maxEvents) {
              expect(loggedEvents.length).toBe(maxEvents);

              // Check that we have the last maxEvents events
              const expectedEvents = events.slice(-maxEvents);
              for (let i = 0; i < maxEvents; i++) {
                expect(loggedEvents[i].type).toBe(expectedEvents[i].type);
                expect(loggedEvents[i].message).toBe(expectedEvents[i].message);
              }
            }

            consoleErrorSpy.mockRestore();
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});

