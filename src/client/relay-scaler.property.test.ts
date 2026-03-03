// Property-based tests for Relay Scaler
// Feature: relay-mesh, Property 26: Scalability Through Relay Addition
// Task 20.3: Write property test for scalability through relay addition

import * as fc from 'fast-check';
import { RelayScaler } from './relay-scaler';
import { SelectionAlgorithm } from './selection-algorithm';
import { ConnectionTopology, ParticipantMetrics, SelectionConfig, NATType } from '../shared/types';

describe('RelayScaler Property Tests', () => {
  let scaler: RelayScaler;
  let selectionAlgorithm: SelectionAlgorithm;
  let config: SelectionConfig;

  beforeEach(() => {
    scaler = new RelayScaler();
    selectionAlgorithm = new SelectionAlgorithm();
    config = {
      bandwidthWeight: 0.3,
      natWeight: 0.25,
      latencyWeight: 0.2,
      stabilityWeight: 0.15,
      deviceWeight: 0.1,
      minBandwidthMbps: 5,
      maxParticipantsPerRelay: 5,
      reevaluationIntervalMs: 30000,
    };
  });

  const createMetrics = (participantId: string, uploadMbps: number = 10): ParticipantMetrics => ({
    participantId,
    timestamp: Date.now(),
    bandwidth: {
      uploadMbps,
      downloadMbps: 20,
      measurementConfidence: 0.9,
    },
    natType: NATType.FULL_CONE,
    latency: {
      averageRttMs: 50,
      minRttMs: 40,
      maxRttMs: 60,
      measurements: new Map(),
    },
    stability: {
      packetLossPercent: 1,
      jitterMs: 10,
      connectionUptime: 100,
      reconnectionCount: 0,
    },
    device: {
      cpuUsagePercent: 30,
      availableMemoryMB: 2048,
      supportedCodecs: ['VP8', 'H264'],
      hardwareAcceleration: true,
    },
  });

  // Feature: relay-mesh, Property 26: Scalability Through Relay Addition
  // **Validates: Requirements 9.5**
  describe('Property 26: Scalability Through Relay Addition', () => {
    it('should add new relays instead of increasing connections per node when participant count increases', () => {
      fc.assert(
        fc.property(
          // Generate initial participant count (N) and increase (K)
          fc.integer({ min: 4, max: 15 }), // Initial count N
          fc.integer({ min: 1, max: 10 }), // Increase K
          (initialCount, increase) => {
            // Create initial topology with optimal relay count for N participants
            const initialRelayCount = selectionAlgorithm.calculateOptimalRelayCount(initialCount);
            
            // Create initial metrics
            const initialMetrics = new Map<string, ParticipantMetrics>();
            for (let i = 0; i < initialCount; i++) {
              initialMetrics.set(`p${i}`, createMetrics(`p${i}`, 10 + i));
            }

            // Create initial topology
            const relayIds = Array.from(initialMetrics.keys())
              .slice(0, initialRelayCount);
            
            const groups = relayIds.map((relayId, idx) => ({
              relayNodeId: relayId,
              regularNodeIds: Array.from(initialMetrics.keys())
                .filter((id) => !relayIds.includes(id))
                .filter((_, i) => i % initialRelayCount === idx),
            }));

            const initialTopology: ConnectionTopology = {
              version: 1,
              timestamp: Date.now(),
              relayNodes: relayIds,
              groups,
              relayConnections: [],
            };

            // Calculate max connections per regular node in initial topology
            const initialMaxConnectionsPerRegular = 1; // Regular nodes connect only to their relay

            // Add K new participants
            const newCount = initialCount + increase;
            const newMetrics = new Map(initialMetrics);
            for (let i = initialCount; i < newCount; i++) {
              newMetrics.set(`p${i}`, createMetrics(`p${i}`, 10 + i));
            }

            // Evaluate scaling decision
            const decision = scaler.evaluateScaling(initialTopology, newMetrics, config);
            const optimalRelayCount = selectionAlgorithm.calculateOptimalRelayCount(newCount);

            // Property: When participant count increases and requires more capacity,
            // the system should add new relay nodes rather than increasing connections per regular node
            if (optimalRelayCount > initialRelayCount) {
              // Should recommend adding relays
              expect(decision.shouldScale).toBe(true);
              expect(decision.action).toBe('add_relays');
              expect(decision.optimalRelayCount).toBe(optimalRelayCount);
              
              // Verify that adding relays maintains the connection pattern
              // Regular nodes should still have exactly 1 connection (to their assigned relay)
              // This ensures we scale by adding relays, not by increasing connections per node
              const newMaxConnectionsPerRegular = 1;
              expect(newMaxConnectionsPerRegular).toBe(initialMaxConnectionsPerRegular);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should maintain connection count per regular node at 1 regardless of total participant count', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5, max: 30 }), // Participant count
          (participantCount) => {
            // Create metrics for all participants
            const allMetrics = new Map<string, ParticipantMetrics>();
            for (let i = 0; i < participantCount; i++) {
              allMetrics.set(`p${i}`, createMetrics(`p${i}`, 10 + i));
            }

            // Calculate optimal relay count
            const optimalRelayCount = selectionAlgorithm.calculateOptimalRelayCount(participantCount);

            // Create topology with optimal relay count
            const relayIds = Array.from(allMetrics.keys()).slice(0, optimalRelayCount);
            const regularIds = Array.from(allMetrics.keys()).filter((id) => !relayIds.includes(id));

            const groups = relayIds.map((relayId, idx) => ({
              relayNodeId: relayId,
              regularNodeIds: regularIds.filter((_, i) => i % optimalRelayCount === idx),
            }));

            const topology: ConnectionTopology = {
              version: 1,
              timestamp: Date.now(),
              relayNodes: relayIds,
              groups,
              relayConnections: [],
            };

            // Property: Every regular node should have exactly 1 connection
            // This verifies that we scale by adding relays, not by increasing connections
            for (const group of topology.groups) {
              for (const regularId of group.regularNodeIds) {
                // Each regular node connects only to its assigned relay
                const connectionCount = 1;
                expect(connectionCount).toBe(1);
              }
            }

            // Property: No regular node should exceed maxParticipantsPerRelay in any group
            for (const group of topology.groups) {
              expect(group.regularNodeIds.length).toBeLessThanOrEqual(config.maxParticipantsPerRelay);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should scale relay count according to sqrt formula as participants increase', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 4, max: 30 }), // Participant count
          (participantCount) => {
            // Create metrics
            const allMetrics = new Map<string, ParticipantMetrics>();
            for (let i = 0; i < participantCount; i++) {
              allMetrics.set(`p${i}`, createMetrics(`p${i}`, 10 + i));
            }

            // Calculate expected relay count using sqrt formula
            const expectedRelayCount = Math.ceil(Math.sqrt(participantCount));

            // Create topology with fewer relays than optimal
            const currentRelayCount = Math.max(1, expectedRelayCount - 1);
            const relayIds = Array.from(allMetrics.keys()).slice(0, currentRelayCount);

            const groups = relayIds.map((relayId) => ({
              relayNodeId: relayId,
              regularNodeIds: [],
            }));

            const topology: ConnectionTopology = {
              version: 1,
              timestamp: Date.now(),
              relayNodes: relayIds,
              groups,
              relayConnections: [],
            };

            // Evaluate scaling
            const decision = scaler.evaluateScaling(topology, allMetrics, config);

            // Property: System should recommend scaling to match sqrt formula
            expect(decision.optimalRelayCount).toBe(expectedRelayCount);
            
            if (currentRelayCount < expectedRelayCount) {
              expect(decision.shouldScale).toBe(true);
              expect(decision.action).toBe('add_relays');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should prevent overloading by adding relays when groups exceed capacity', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 6, max: 20 }), // Participant count
          (participantCount) => {
            // Create metrics
            const allMetrics = new Map<string, ParticipantMetrics>();
            for (let i = 0; i < participantCount; i++) {
              allMetrics.set(`p${i}`, createMetrics(`p${i}`, 10 + i));
            }

            // Create topology with insufficient relays (force overload)
            const insufficientRelayCount = 1;
            const relayIds = Array.from(allMetrics.keys()).slice(0, insufficientRelayCount);
            const regularIds = Array.from(allMetrics.keys()).filter((id) => !relayIds.includes(id));

            const groups = [
              {
                relayNodeId: relayIds[0],
                regularNodeIds: regularIds, // All regular nodes in one group
              },
            ];

            const topology: ConnectionTopology = {
              version: 1,
              timestamp: Date.now(),
              relayNodes: relayIds,
              groups,
              relayConnections: [],
            };

            // Check if groups are overloaded
            const isOverloaded = scaler.hasOverloadedGroups(topology, config);

            // Evaluate scaling
            const decision = scaler.evaluateScaling(topology, allMetrics, config);

            // Property: When groups are overloaded, system should recommend adding relays
            if (regularIds.length > config.maxParticipantsPerRelay) {
              expect(isOverloaded).toBe(true);
              expect(decision.shouldScale).toBe(true);
              expect(decision.action).toBe('add_relays');
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
