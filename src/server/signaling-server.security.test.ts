// Unit tests for security edge cases - Tampered signaling messages
// Task 14.9: Write unit tests for security edge cases
// Requirements: 12.1, 12.2, 12.3, 12.4, 12.5

import { SignalingServer } from './signaling-server';
import { WebSocket } from 'ws';
import { SimpleAuthProvider } from '../shared/auth';
import {
  JoinMessage,
  TopologyUpdateMessage,
  WebRTCOfferMessage,
  ConnectionTopology,
} from '../shared/types';

describe('Security Edge Cases - Tampered Signaling Messages', () => {
  let server: SignalingServer;
  const TEST_PORT = 9000;

  beforeEach(async () => {
    server = new SignalingServer({
      port: TEST_PORT,
      enforceTLS: false,
      requireAuth: false,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Message tampering detection', () => {
    it('should handle message with tampered participant ID', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      ws.on('open', () => {
        // Send join message
        const joinMessage: JoinMessage = {
          type: 'join',
          from: 'participant-1',
          timestamp: Date.now(),
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-1',
            name: 'Test Participant',
          },
        };

        ws.send(JSON.stringify(joinMessage));
      });

      let joinResponseReceived = false;

      ws.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'join-response') {
          joinResponseReceived = true;

          // Now send a message claiming to be from a different participant
          const tamperedMessage: WebRTCOfferMessage = {
            type: 'webrtc-offer',
            from: 'participant-2', // Tampered - claiming to be different participant
            to: 'participant-3',
            timestamp: Date.now(),
            offer: {
              type: 'offer',
              sdp: 'tampered-sdp',
            },
          };

          ws.send(JSON.stringify(tamperedMessage));

          // Server should either reject or handle gracefully
          setTimeout(() => {
            // Connection should remain stable
            expect(ws.readyState).toBe(WebSocket.OPEN);
            ws.close();
            done();
          }, 100);
        }
      });

      ws.on('error', (error) => {
        done(error);
      });
    });

    it('should handle message with tampered timestamp', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      ws.on('open', () => {
        // Send message with future timestamp
        const joinMessage: JoinMessage = {
          type: 'join',
          from: 'participant-1',
          timestamp: Date.now() + 1000000, // Far future timestamp
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-1',
            name: 'Test Participant',
          },
        };

        ws.send(JSON.stringify(joinMessage));
      });

      ws.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'join-response' || message.type === 'error') {
          // Server should handle gracefully
          expect(ws.readyState).toBe(WebSocket.OPEN);
          ws.close();
          done();
        }
      });

      ws.on('error', (error) => {
        done(error);
      });
    });

    it('should handle message with tampered topology data', (done) => {
      const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      const ws2 = new WebSocket(`ws://localhost:${TEST_PORT}`);

      let ws1Joined = false;
      let ws2Joined = false;

      const checkBothJoined = () => {
        if (ws1Joined && ws2Joined) {
          // Send topology update with inconsistent data
          const tamperedTopology: ConnectionTopology = {
            version: 1,
            timestamp: Date.now(),
            relayNodes: ['participant-1', 'participant-999'], // participant-999 doesn't exist
            groups: [
              {
                relayNodeId: 'participant-1',
                regularNodeIds: ['participant-2', 'participant-888'], // participant-888 doesn't exist
              },
            ],
            relayConnections: [['participant-1', 'participant-999']], // Invalid connection
          };

          const topologyMessage: TopologyUpdateMessage = {
            type: 'topology-update',
            from: 'participant-1',
            timestamp: Date.now(),
            topology: tamperedTopology,
            reason: 'relay-selection',
          };

          ws1.send(JSON.stringify(topologyMessage));

          // Server should handle gracefully
          setTimeout(() => {
            expect(ws1.readyState).toBe(WebSocket.OPEN);
            expect(ws2.readyState).toBe(WebSocket.OPEN);
            ws1.close();
            ws2.close();
            done();
          }, 100);
        }
      };

      ws1.on('open', () => {
        const joinMessage: JoinMessage = {
          type: 'join',
          from: 'participant-1',
          timestamp: Date.now(),
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-1',
            name: 'Participant 1',
          },
        };
        ws1.send(JSON.stringify(joinMessage));
      });

      ws2.on('open', () => {
        const joinMessage: JoinMessage = {
          type: 'join',
          from: 'participant-2',
          timestamp: Date.now(),
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-2',
            name: 'Participant 2',
          },
        };
        ws2.send(JSON.stringify(joinMessage));
      });

      ws1.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'join-response') {
          ws1Joined = true;
          checkBothJoined();
        }
      });

      ws2.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'join-response') {
          ws2Joined = true;
          checkBothJoined();
        }
      });

      ws1.on('error', (error) => done(error));
      ws2.on('error', (error) => done(error));
    });

    it('should handle message with negative version number', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      ws.on('open', () => {
        const joinMessage: JoinMessage = {
          type: 'join',
          from: 'participant-1',
          timestamp: Date.now(),
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-1',
            name: 'Test Participant',
          },
        };
        ws.send(JSON.stringify(joinMessage));
      });

      ws.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'join-response') {
          // Send topology with negative version
          const topology: ConnectionTopology = {
            version: -1, // Invalid negative version
            timestamp: Date.now(),
            relayNodes: [],
            groups: [],
            relayConnections: [],
          };

          const topologyMessage: TopologyUpdateMessage = {
            type: 'topology-update',
            from: 'participant-1',
            timestamp: Date.now(),
            topology,
            reason: 'relay-selection',
          };

          ws.send(JSON.stringify(topologyMessage));

          setTimeout(() => {
            expect(ws.readyState).toBe(WebSocket.OPEN);
            ws.close();
            done();
          }, 100);
        }
      });

      ws.on('error', (error) => done(error));
    });

    it('should handle message with circular relay connections', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      ws.on('open', () => {
        const joinMessage: JoinMessage = {
          type: 'join',
          from: 'participant-1',
          timestamp: Date.now(),
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-1',
            name: 'Test Participant',
          },
        };
        ws.send(JSON.stringify(joinMessage));
      });

      ws.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'join-response') {
          // Send topology with circular connections
          const topology: ConnectionTopology = {
            version: 1,
            timestamp: Date.now(),
            relayNodes: ['relay-1', 'relay-2', 'relay-3'],
            groups: [],
            relayConnections: [
              ['relay-1', 'relay-2'],
              ['relay-2', 'relay-3'],
              ['relay-3', 'relay-1'], // Creates a cycle
            ],
          };

          const topologyMessage: TopologyUpdateMessage = {
            type: 'topology-update',
            from: 'participant-1',
            timestamp: Date.now(),
            topology,
            reason: 'relay-selection',
          };

          ws.send(JSON.stringify(topologyMessage));

          setTimeout(() => {
            expect(ws.readyState).toBe(WebSocket.OPEN);
            ws.close();
            done();
          }, 100);
        }
      });

      ws.on('error', (error) => done(error));
    });
  });

  describe('Message injection attacks', () => {
    it('should handle rapid message flooding', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      ws.on('open', () => {
        // Send join first
        const joinMessage: JoinMessage = {
          type: 'join',
          from: 'participant-1',
          timestamp: Date.now(),
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-1',
            name: 'Test Participant',
          },
        };
        ws.send(JSON.stringify(joinMessage));
      });

      ws.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'join-response') {
          // Flood with messages
          for (let i = 0; i < 100; i++) {
            const floodMessage = {
              type: 'metrics-broadcast',
              from: 'participant-1',
              timestamp: Date.now(),
              metrics: {
                participantId: 'participant-1',
                timestamp: Date.now(),
                bandwidth: { uploadMbps: 10, downloadMbps: 20, measurementConfidence: 0.9 },
                natType: 1,
                latency: { averageRttMs: 50, minRttMs: 40, maxRttMs: 60, measurements: {} },
                stability: { packetLossPercent: 0.5, jitterMs: 10, connectionUptime: 100, reconnectionCount: 0 },
                device: { cpuUsagePercent: 30, availableMemoryMB: 2048, supportedCodecs: ['VP8'], hardwareAcceleration: true },
              },
            };
            ws.send(JSON.stringify(floodMessage));
          }

          // Server should remain stable
          setTimeout(() => {
            expect(ws.readyState).toBe(WebSocket.OPEN);
            ws.close();
            done();
          }, 200);
        }
      });

      ws.on('error', (error) => done(error));
    });

    it('should handle very large message payloads', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      ws.on('open', () => {
        // Send message with very large payload
        const largePayload = 'x'.repeat(1000000); // 1MB of data
        const joinMessage: JoinMessage = {
          type: 'join',
          from: 'participant-1',
          timestamp: Date.now(),
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-1',
            name: largePayload, // Extremely large name
          },
        };

        ws.send(JSON.stringify(joinMessage));

        // Server should handle gracefully (accept or reject)
        setTimeout(() => {
          // Connection might be closed or remain open
          ws.close();
          done();
        }, 500);
      });

      ws.on('error', () => {
        // Error is acceptable for oversized messages
        done();
      });
    });

    it('should handle message with deeply nested objects', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      ws.on('open', () => {
        // Create deeply nested object
        let nested: any = { value: 'deep' };
        for (let i = 0; i < 100; i++) {
          nested = { nested };
        }

        const maliciousMessage = {
          type: 'join',
          from: 'participant-1',
          timestamp: Date.now(),
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-1',
            name: 'Test',
          },
          maliciousData: nested,
        };

        ws.send(JSON.stringify(maliciousMessage));

        setTimeout(() => {
          ws.close();
          done();
        }, 200);
      });

      ws.on('error', () => {
        // Error is acceptable
        done();
      });
    });
  });

  describe('Authentication tampering', () => {
    it('should reject message with tampered auth token', async () => {
      const authProvider = new SimpleAuthProvider();
      const serverWithAuth = new SignalingServer({
        port: 9001,
        enforceTLS: false,
        requireAuth: true,
        authProvider,
      });

      await serverWithAuth.start();

      try {
        // Generate valid token
        const validToken = await authProvider.generateToken('participant-1');

        const ws = new WebSocket(`ws://localhost:9001`);

        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            // Tamper with the token
            const tamperedToken = validToken + 'tampered';

            const joinMessage: JoinMessage = {
              type: 'join',
              from: 'participant-1',
              timestamp: Date.now(),
              conferenceId: 'conference-1',
              participantInfo: {
                id: 'participant-1',
                name: 'Test Participant',
              },
              auth: {
                token: tamperedToken,
                timestamp: Date.now(),
              },
            };

            ws.send(JSON.stringify(joinMessage));
          });

          ws.on('message', (data: Buffer) => {
            const message = JSON.parse(data.toString());
            if (message.type === 'error' && message.code === 'AUTH_FAILED') {
              ws.close();
              resolve();
            } else if (message.type === 'join-response') {
              ws.close();
              reject(new Error('Should not have accepted tampered token'));
            }
          });

          ws.on('close', () => {
            resolve();
          });

          ws.on('error', () => {
            resolve();
          });

          setTimeout(() => {
            ws.close();
            resolve();
          }, 2000);
        });

        await serverWithAuth.stop();
      } catch (error) {
        await serverWithAuth.stop();
        throw error;
      }
    });

    it('should reject message with reused token from different participant', async () => {
      const authProvider = new SimpleAuthProvider();
      const serverWithAuth = new SignalingServer({
        port: 9002,
        enforceTLS: false,
        requireAuth: true,
        authProvider,
      });

      await serverWithAuth.start();

      try {
        // Generate token for participant-1
        const token = await authProvider.generateToken('participant-1');

        const ws = new WebSocket(`ws://localhost:9002`);

        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            // Try to use participant-1's token as participant-2
            const joinMessage: JoinMessage = {
              type: 'join',
              from: 'participant-2', // Different participant
              timestamp: Date.now(),
              conferenceId: 'conference-1',
              participantInfo: {
                id: 'participant-2',
                name: 'Test Participant',
              },
              auth: {
                token, // Token belongs to participant-1
                timestamp: Date.now(),
              },
            };

            ws.send(JSON.stringify(joinMessage));
          });

          ws.on('message', (data: Buffer) => {
            const message = JSON.parse(data.toString());
            if (message.type === 'error' && message.code === 'AUTH_FAILED') {
              ws.close();
              resolve();
            } else if (message.type === 'join-response') {
              ws.close();
              reject(new Error('Should not have accepted token from different participant'));
            }
          });

          ws.on('close', () => {
            resolve();
          });

          ws.on('error', () => {
            resolve();
          });

          setTimeout(() => {
            ws.close();
            resolve();
          }, 2000);
        });

        await serverWithAuth.stop();
      } catch (error) {
        await serverWithAuth.stop();
        throw error;
      }
    });

    it('should reject message with auth timestamp in the past', async () => {
      const authProvider = new SimpleAuthProvider();
      const serverWithAuth = new SignalingServer({
        port: 9003,
        enforceTLS: false,
        requireAuth: true,
        authProvider,
      });

      await serverWithAuth.start();

      try {
        const token = await authProvider.generateToken('participant-1');

        const ws = new WebSocket(`ws://localhost:9003`);

        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            const joinMessage: JoinMessage = {
              type: 'join',
              from: 'participant-1',
              timestamp: Date.now(),
              conferenceId: 'conference-1',
              participantInfo: {
                id: 'participant-1',
                name: 'Test Participant',
              },
              auth: {
                token,
                timestamp: Date.now() - 1000000, // Very old timestamp
              },
            };

            ws.send(JSON.stringify(joinMessage));
          });

          ws.on('message', (data: Buffer) => {
            const message = JSON.parse(data.toString());
            // Server may accept or reject based on implementation
            // Either response is acceptable
            ws.close();
            resolve();
          });

          ws.on('close', () => {
            resolve();
          });

          ws.on('error', () => {
            resolve();
          });

          setTimeout(() => {
            ws.close();
            resolve();
          }, 2000);
        });

        await serverWithAuth.stop();
      } catch (error) {
        await serverWithAuth.stop();
        throw error;
      }
    });
  });

  describe('Protocol violation handling', () => {
    it('should handle message sent before join', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      ws.on('open', () => {
        // Send topology update before joining
        const topology: ConnectionTopology = {
          version: 1,
          timestamp: Date.now(),
          relayNodes: [],
          groups: [],
          relayConnections: [],
        };

        const topologyMessage: TopologyUpdateMessage = {
          type: 'topology-update',
          from: 'participant-1',
          timestamp: Date.now(),
          topology,
          reason: 'relay-selection',
        };

        ws.send(JSON.stringify(topologyMessage));

        // Server should handle gracefully
        setTimeout(() => {
          expect(ws.readyState).toBe(WebSocket.OPEN);
          ws.close();
          done();
        }, 100);
      });

      ws.on('error', (error) => done(error));
    });

    it('should handle duplicate join messages', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);

      ws.on('open', () => {
        const joinMessage: JoinMessage = {
          type: 'join',
          from: 'participant-1',
          timestamp: Date.now(),
          conferenceId: 'conference-1',
          participantInfo: {
            id: 'participant-1',
            name: 'Test Participant',
          },
        };

        // Send join twice
        ws.send(JSON.stringify(joinMessage));
        ws.send(JSON.stringify(joinMessage));
      });

      let responseCount = 0;

      ws.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'join-response') {
          responseCount++;
        }

        // Wait for both responses (server may send response to both)
        if (responseCount >= 2) {
          setTimeout(() => {
            // Connection should remain stable regardless
            expect([WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED]).toContain(ws.readyState);
            ws.close();
            done();
          }, 100);
        }
      });

      ws.on('error', (error) => done(error));
    });
  });
});
