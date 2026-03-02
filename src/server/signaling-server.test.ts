import { SignalingServer } from './signaling-server';
import { WebSocket } from 'ws';
import {
  JoinMessage,
  TopologyUpdateMessage,
  WebRTCOfferMessage,
  WebRTCAnswerMessage,
  ICECandidateMessage,
  ConnectionTopology,
} from '../shared/types';

describe('SignalingServer', () => {
  let server: SignalingServer;
  const TEST_PORT = 8080;

  beforeEach(async () => {
    server = new SignalingServer({ port: TEST_PORT });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Connection Management', () => {
    it('should accept WebSocket connections', (done) => {
      const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
      
      ws.on('open', () => {
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
        done();
      });

      ws.on('error', (error) => {
        done(error);
      });
    });

    it('should handle participant join and provide topology', (done) => {
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
        const response = JSON.parse(data.toString());
        expect(response.type).toBe('join-response');
        expect(response.topology).toBeDefined();
        expect(response.topology.version).toBe(0);
        expect(response.topology.relayNodes).toEqual([]);
        ws.close();
        done();
      });

      ws.on('error', (error) => {
        done(error);
      });
    });

    it('should track connected participants', (done) => {
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

      ws.on('message', () => {
        // After join response, check if participant is tracked
        setTimeout(() => {
          expect(server.isParticipantConnected('participant-1')).toBe(true);
          const participants = server.getConferenceParticipants('conference-1');
          expect(participants).toContain('participant-1');
          ws.close();
          done();
        }, 100);
      });

      ws.on('error', (error) => {
        done(error);
      });
    });

    it('should handle participant disconnection', (done) => {
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

      ws.on('message', () => {
        // Close connection after join
        ws.close();
        
        // Check if participant is removed after disconnection
        setTimeout(() => {
          expect(server.isParticipantConnected('participant-1')).toBe(false);
          done();
        }, 100);
      });

      ws.on('error', (error) => {
        done(error);
      });
    });
  });

  describe('Message Routing', () => {
    it('should route WebRTC offer to target participant', (done) => {
      const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      const ws2 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      
      let ws1Joined = false;
      let ws2Joined = false;

      const checkBothJoined = () => {
        if (ws1Joined && ws2Joined) {
          // Send offer from participant-1 to participant-2
          const offerMessage: WebRTCOfferMessage = {
            type: 'webrtc-offer',
            from: 'participant-1',
            to: 'participant-2',
            timestamp: Date.now(),
            offer: {
              type: 'offer',
              sdp: 'test-sdp',
            },
          };

          ws1.send(JSON.stringify(offerMessage));
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
        } else if (message.type === 'webrtc-offer') {
          expect(message.from).toBe('participant-1');
          expect(message.to).toBe('participant-2');
          expect(message.offer.sdp).toBe('test-sdp');
          ws1.close();
          ws2.close();
          done();
        }
      });

      ws1.on('error', (error) => done(error));
      ws2.on('error', (error) => done(error));
    });

    it('should route WebRTC answer to target participant', (done) => {
      const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      const ws2 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      
      let ws1Joined = false;
      let ws2Joined = false;

      const checkBothJoined = () => {
        if (ws1Joined && ws2Joined) {
          // Send answer from participant-2 to participant-1
          const answerMessage: WebRTCAnswerMessage = {
            type: 'webrtc-answer',
            from: 'participant-2',
            to: 'participant-1',
            timestamp: Date.now(),
            answer: {
              type: 'answer',
              sdp: 'test-answer-sdp',
            },
          };

          ws2.send(JSON.stringify(answerMessage));
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
        } else if (message.type === 'webrtc-answer') {
          expect(message.from).toBe('participant-2');
          expect(message.to).toBe('participant-1');
          expect(message.answer.sdp).toBe('test-answer-sdp');
          ws1.close();
          ws2.close();
          done();
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

    it('should route ICE candidates to target participant', (done) => {
      const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      const ws2 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      
      let ws1Joined = false;
      let ws2Joined = false;

      const checkBothJoined = () => {
        if (ws1Joined && ws2Joined) {
          // Send ICE candidate from participant-1 to participant-2
          const iceMessage: ICECandidateMessage = {
            type: 'ice-candidate',
            from: 'participant-1',
            to: 'participant-2',
            timestamp: Date.now(),
            candidate: {
              candidate: 'test-candidate',
              sdpMid: 'test-mid',
              sdpMLineIndex: 0,
            },
          };

          ws1.send(JSON.stringify(iceMessage));
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
        } else if (message.type === 'ice-candidate') {
          expect(message.from).toBe('participant-1');
          expect(message.to).toBe('participant-2');
          expect(message.candidate.candidate).toBe('test-candidate');
          ws1.close();
          ws2.close();
          done();
        }
      });

      ws1.on('error', (error) => done(error));
      ws2.on('error', (error) => done(error));
    });
  });

  describe('Topology Management', () => {
    it('should store and broadcast topology updates', (done) => {
      const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      const ws2 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      
      let ws1Joined = false;
      let ws2Joined = false;

      const checkBothJoined = () => {
        if (ws1Joined && ws2Joined) {
          // Send topology update from participant-1
          const topology: ConnectionTopology = {
            version: 1,
            timestamp: Date.now(),
            relayNodes: ['participant-1'],
            groups: [
              {
                relayNodeId: 'participant-1',
                regularNodeIds: ['participant-2'],
              },
            ],
            relayConnections: [],
          };

          const topologyMessage: TopologyUpdateMessage = {
            type: 'topology-update',
            from: 'participant-1',
            timestamp: Date.now(),
            topology,
            reason: 'relay-selection',
          };

          ws1.send(JSON.stringify(topologyMessage));
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
        } else if (message.type === 'topology-update') {
          expect(message.topology.version).toBe(1);
          expect(message.topology.relayNodes).toContain('participant-1');
          expect(message.reason).toBe('relay-selection');
          
          // Verify topology is stored
          const storedTopology = server.getConferenceTopology('conference-1');
          expect(storedTopology).not.toBeNull();
          expect(storedTopology?.version).toBe(1);
          
          ws1.close();
          ws2.close();
          done();
        }
      });

      ws1.on('error', (error) => done(error));
      ws2.on('error', (error) => done(error));
    });

    it('should provide current topology to new joiners', (done) => {
      const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      
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

      ws1.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'join-response') {
          // First participant should receive empty topology
          expect(message.topology.version).toBe(0);
          expect(message.topology.relayNodes).toEqual([]);
          ws1.close();
          done();
        }
      });

      ws1.on('error', (error) => done(error));
    });
  });

  describe('Relay Assignment Coordination', () => {
    it('should broadcast relay assignments to conference participants', (done) => {
      const ws1 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      const ws2 = new WebSocket(`ws://localhost:${TEST_PORT}`);
      
      let ws1Joined = false;
      let ws2Joined = false;

      const checkBothJoined = () => {
        if (ws1Joined && ws2Joined) {
          // Send relay assignment from participant-1
          const assignmentMessage = {
            type: 'relay-assignment',
            from: 'participant-1',
            timestamp: Date.now(),
            assignedRelayId: 'participant-1',
            role: 'relay' as const,
          };

          ws1.send(JSON.stringify(assignmentMessage));
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
        } else if (message.type === 'relay-assignment') {
          expect(message.assignedRelayId).toBe('participant-1');
          expect(message.role).toBe('relay');
          ws1.close();
          ws2.close();
          done();
        }
      });

      ws1.on('error', (error) => done(error));
      ws2.on('error', (error) => done(error));
    });
  });
});
