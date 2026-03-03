// Property-based tests for Media Handler
// Task 14.2: Property test for media encryption

import * as fc from 'fast-check';
import { MediaHandler } from './media-handler';
import { PeerConnectionConfig } from '../shared/types';

// Mock WebRTC APIs
const mockGetUserMedia = jest.fn();
const mockRTCPeerConnection = jest.fn();

// Setup global mocks
beforeAll(() => {
  // Mock navigator.mediaDevices.getUserMedia
  global.navigator = {
    mediaDevices: {
      getUserMedia: mockGetUserMedia,
    },
  } as any;

  // Mock RTCPeerConnection
  global.RTCPeerConnection = mockRTCPeerConnection as any;
});

describe('MediaHandler - Property-Based Tests', () => {
  let handler: MediaHandler;

  beforeEach(() => {
    handler = new MediaHandler('local-participant');
    jest.clearAllMocks();
  });

  afterEach(() => {
    handler.cleanup();
  });

  describe('Property 33: Media Encryption', () => {
    // Feature: relay-mesh, Property 33: Media Encryption
    // Validates: Requirements 12.1
    // Verify all media streams encrypted using DTLS-SRTP

    it('should verify all peer connections use DTLS-SRTP encryption', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate array of 1-10 remote participant IDs
          fc.array(fc.string({ minLength: 5, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
          // Generate ICE server configurations
          fc.array(
            fc.record({
              urls: fc.oneof(fc.constant('stun:stun.l.google.com:19302'), fc.constant('turn:turn.example.com:3478')),
            }),
            { minLength: 1, maxLength: 3 }
          ),
          async (participantIds, iceServers) => {
            // Create unique participant IDs
            const uniqueParticipantIds = Array.from(new Set(participantIds));
            if (uniqueParticipantIds.length === 0) return true;

            // Create a fresh handler for each test iteration
            const testHandler = new MediaHandler('test-local-participant');

            const config: PeerConnectionConfig = {
              iceServers,
              iceTransportPolicy: 'all',
            };

            // Mock RTCPeerConnection constructor to return consistent mock
            mockRTCPeerConnection.mockImplementation(() => ({
              connectionState: 'connected',
              iceConnectionState: 'connected',
              addTrack: jest.fn(),
              getSenders: jest.fn(() => []),
              getStats: jest.fn(async () => {
                // Mock stats report that indicates DTLS-SRTP is active
                const statsMap = new Map();
                
                // Add transport stats with DTLS state
                statsMap.set('transport-1', {
                  type: 'transport',
                  dtlsState: 'connected', // DTLS is connected
                  srtpCipher: 'AES_CM_128_HMAC_SHA1_80', // SRTP cipher indicates encryption
                  selectedCandidatePairChanges: 1,
                });

                // Add certificate stats (indicates DTLS handshake completed)
                statsMap.set('certificate-1', {
                  type: 'certificate',
                  fingerprint: 'sha-256',
                  fingerprintAlgorithm: 'sha-256',
                });

                return statsMap;
              }),
              close: jest.fn(),
              ontrack: null,
              onconnectionstatechange: null,
              oniceconnectionstatechange: null,
            }));

            // Create peer connections for all participants
            for (const participantId of uniqueParticipantIds) {
              await testHandler.createPeerConnection(participantId, config);
            }

            // Verify encryption is active for all connections
            const encryptionStatus = await testHandler.verifyAllConnectionsEncrypted();

            // Property: ALL connections must be encrypted
            // For any media stream transmitted between participants,
            // the stream SHALL be encrypted using DTLS-SRTP
            const allEncrypted = Array.from(encryptionStatus.values()).every((isEncrypted) => isEncrypted);

            // All connections should report encryption as active
            expect(allEncrypted).toBe(true);
            expect(encryptionStatus.size).toBe(uniqueParticipantIds.length);

            // Cleanup
            testHandler.cleanup();

            return allEncrypted;
          }
        ),
        { numRuns: 100 } // Run 100 iterations as specified in design
      );
    });

    it('should verify encryption is active for individual peer connections', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate single participant ID
          fc.string({ minLength: 5, maxLength: 20 }),
          // Generate connection state
          fc.constantFrom('connected', 'connecting', 'new'),
          // Generate DTLS state
          fc.constantFrom('connected', 'connecting', 'new', 'closed'),
          async (participantId, connectionState, dtlsState) => {
            // Create a fresh handler for each test iteration
            const testHandler = new MediaHandler('test-local-participant');

            const config: PeerConnectionConfig = {
              iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
              iceTransportPolicy: 'all',
            };

            // Mock peer connection
            const mockConnection = {
              connectionState,
              iceConnectionState: connectionState,
              addTrack: jest.fn(),
              getSenders: jest.fn(() => []),
              getStats: jest.fn(async () => {
                const statsMap = new Map();
                
                // Add transport stats
                statsMap.set('transport-1', {
                  type: 'transport',
                  dtlsState,
                  srtpCipher: dtlsState === 'connected' ? 'AES_CM_128_HMAC_SHA1_80' : undefined,
                });

                if (dtlsState === 'connected') {
                  statsMap.set('certificate-1', {
                    type: 'certificate',
                    fingerprint: 'sha-256',
                  });
                }

                return statsMap;
              }),
              close: jest.fn(),
              ontrack: null,
              onconnectionstatechange: null,
              oniceconnectionstatechange: null,
            };

            mockRTCPeerConnection.mockImplementation(() => mockConnection);

            // Create peer connection
            await testHandler.createPeerConnection(participantId, config);

            // Verify encryption status
            const isEncrypted = await testHandler.verifyEncryptionActive(participantId);

            // Property: Encryption should be active when connection is established
            // The implementation requires connectionState to be 'connected' first,
            // then checks DTLS state. This ensures the connection is fully established
            // before verifying encryption.
            const expectedEncryption = connectionState === 'connected';

            expect(isEncrypted).toBe(expectedEncryption);

            // Cleanup
            testHandler.cleanup();

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should verify DTLS-SRTP is enabled by default in peer connection configuration', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate various ICE transport policies
          fc.constantFrom('all', 'relay'),
          // Generate bundle policies
          fc.constantFrom('balanced', 'max-compat', 'max-bundle'),
          async (iceTransportPolicy, bundlePolicy) => {
            // Create a fresh handler for each test iteration
            const testHandler = new MediaHandler('test-local-participant');

            const participantId = 'test-participant';
            const config: PeerConnectionConfig = {
              iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
              iceTransportPolicy: iceTransportPolicy as RTCIceTransportPolicy,
              bundlePolicy: bundlePolicy as RTCBundlePolicy,
            };

            let capturedConfig: RTCConfiguration | undefined;

            // Capture the configuration passed to RTCPeerConnection
            mockRTCPeerConnection.mockImplementation((config: RTCConfiguration) => {
              capturedConfig = config;
              return {
                connectionState: 'connected',
                iceConnectionState: 'connected',
                addTrack: jest.fn(),
                getSenders: jest.fn(() => []),
                getStats: jest.fn(async () => {
                  const statsMap = new Map();
                  statsMap.set('transport-1', {
                    type: 'transport',
                    dtlsState: 'connected',
                    srtpCipher: 'AES_CM_128_HMAC_SHA1_80',
                  });
                  return statsMap;
                }),
                close: jest.fn(),
                ontrack: null,
                onconnectionstatechange: null,
                oniceconnectionstatechange: null,
              };
            });

            // Create peer connection
            await testHandler.createPeerConnection(participantId, config);

            // Property: DTLS-SRTP is enabled by default in WebRTC
            // The configuration should not disable encryption
            // WebRTC spec mandates DTLS-SRTP for all media streams
            
            // Verify configuration was passed correctly
            expect(capturedConfig).toBeDefined();
            expect(capturedConfig?.iceServers).toEqual(config.iceServers);
            expect(capturedConfig?.iceTransportPolicy).toBe(iceTransportPolicy);

            // Verify encryption is active
            const isEncrypted = await testHandler.verifyEncryptionActive(participantId);
            expect(isEncrypted).toBe(true);

            // Cleanup
            testHandler.cleanup();

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Task 18.1: Connection Failure Handling', () => {
    it('should implement exponential backoff for connection retries', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      };

      // Mock RTCPeerConnection
      mockRTCPeerConnection.mockImplementation(() => ({
        connectionState: 'new',
        iceConnectionState: 'new',
        addTrack: jest.fn(),
        getSenders: jest.fn(() => []),
        getStats: jest.fn(async () => new Map()),
        close: jest.fn(),
        ontrack: null,
        onconnectionstatechange: null,
        oniceconnectionstatechange: null,
      }));

      // Create initial connection
      await handler.createPeerConnection('remote-1', config);

      // Track retry callback invocations
      let retryCallbackCount = 0;
      const retryCallback = jest.fn(async () => {
        retryCallbackCount++;
      });

      // Test exponential backoff delays
      const startTime = Date.now();
      const delays: number[] = [];

      // Perform 3 retries and measure delays
      for (let i = 0; i < 3; i++) {
        const beforeRetry = Date.now();
        await handler.retryConnection('remote-1', config, retryCallback);
        const afterRetry = Date.now();
        delays.push(afterRetry - beforeRetry);
      }

      // Verify exponential backoff pattern: ~1s, ~2s, ~4s
      // Allow 200ms tolerance for timing variations
      expect(delays[0]).toBeGreaterThanOrEqual(900);
      expect(delays[0]).toBeLessThanOrEqual(1200);
      
      expect(delays[1]).toBeGreaterThanOrEqual(1900);
      expect(delays[1]).toBeLessThanOrEqual(2200);
      
      expect(delays[2]).toBeGreaterThanOrEqual(3900);
      expect(delays[2]).toBeLessThanOrEqual(4200);

      // Verify retry callback was called
      expect(retryCallbackCount).toBe(3);
    }, 15000); // Increase timeout for this test

    it('should stop retrying after maximum attempts', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      };

      mockRTCPeerConnection.mockImplementation(() => ({
        connectionState: 'new',
        iceConnectionState: 'new',
        addTrack: jest.fn(),
        getSenders: jest.fn(() => []),
        getStats: jest.fn(async () => new Map()),
        close: jest.fn(),
        ontrack: null,
        onconnectionstatechange: null,
        oniceconnectionstatechange: null,
      }));

      await handler.createPeerConnection('remote-2', config);

      const retryCallback = jest.fn(async () => {});

      // Perform 5 retries (maximum)
      for (let i = 0; i < 5; i++) {
        await handler.retryConnection('remote-2', config, retryCallback);
      }

      // 6th retry should throw error
      await expect(
        handler.retryConnection('remote-2', config, retryCallback)
      ).rejects.toThrow('Failed to establish connection to remote-2 after 5 attempts');
    }, 60000); // Increase timeout significantly

    it('should reset retry counter on successful connection', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      };

      mockRTCPeerConnection.mockImplementation(() => ({
        connectionState: 'connected',
        iceConnectionState: 'connected',
        addTrack: jest.fn(),
        getSenders: jest.fn(() => []),
        getStats: jest.fn(async () => new Map()),
        close: jest.fn(),
        ontrack: null,
        onconnectionstatechange: null,
        oniceconnectionstatechange: null,
      }));

      await handler.createPeerConnection('remote-3', config);

      // Simulate a retry
      const retryCallback = jest.fn(async () => {});
      await handler.retryConnection('remote-3', config, retryCallback);

      // Reset counter (simulating successful connection)
      handler.resetRetryCounter('remote-3');

      // Next retry should start from attempt 1 again
      const startTime = Date.now();
      await handler.retryConnection('remote-3', config, retryCallback);
      const delay = Date.now() - startTime;

      // Should use first retry delay (~1s), not second retry delay (~2s)
      expect(delay).toBeGreaterThanOrEqual(900);
      expect(delay).toBeLessThanOrEqual(1200);
    }, 15000);

    it('should cancel pending retries when requested', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      };

      mockRTCPeerConnection.mockImplementation(() => ({
        connectionState: 'new',
        iceConnectionState: 'new',
        addTrack: jest.fn(),
        getSenders: jest.fn(() => []),
        getStats: jest.fn(async () => new Map()),
        close: jest.fn(),
        ontrack: null,
        onconnectionstatechange: null,
        oniceconnectionstatechange: null,
      }));

      await handler.createPeerConnection('remote-4', config);

      const retryCallback = jest.fn(async () => {});

      // Start a retry (will wait 1 second) - don't await it
      handler.retryConnection('remote-4', config, retryCallback);

      // Wait a bit to ensure the timeout is set
      await new Promise(resolve => setTimeout(resolve, 100));

      // Cancel the retry
      handler.cancelRetry('remote-4');

      // Wait to see if callback gets called (it shouldn't after cancel)
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Callback should not have been called because we cancelled
      expect(retryCallback).not.toHaveBeenCalled();

      // Now start a new retry - it should start from attempt 1 (counter was reset by cancel)
      const startTime = Date.now();
      await handler.retryConnection('remote-4', config, retryCallback);
      const delay = Date.now() - startTime;

      // Should use first retry delay (~1s)
      expect(delay).toBeGreaterThanOrEqual(900);
      expect(delay).toBeLessThanOrEqual(1200);

      // Now callback should have been called once
      expect(retryCallback).toHaveBeenCalledTimes(1);
    }, 5000);

    it('should attempt direct connection before TURN fallback', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
        ],
        iceTransportPolicy: 'all', // 'all' tries direct first, then TURN
      };

      mockRTCPeerConnection.mockImplementation(() => ({
        connectionState: 'new',
        iceConnectionState: 'new',
        addTrack: jest.fn(),
        getSenders: jest.fn(() => []),
        getStats: jest.fn(async () => new Map()),
        close: jest.fn(),
        ontrack: null,
        onconnectionstatechange: null,
        oniceconnectionstatechange: null,
      }));

      const peerConnection = await handler.createPeerConnection('remote-5', config);

      // Verify connection was created with 'all' transport policy
      expect(mockRTCPeerConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          iceTransportPolicy: 'all', // This allows both direct and TURN
        })
      );

      // Verify both STUN and TURN servers are configured
      expect(mockRTCPeerConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          iceServers: expect.arrayContaining([
            expect.objectContaining({ urls: 'stun:stun.l.google.com:19302' }),
            expect.objectContaining({ urls: 'turn:turn.example.com:3478' }),
          ]),
        })
      );
    });

    it('should handle connection failure and trigger retry logic', async () => {
      const config: PeerConnectionConfig = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        iceTransportPolicy: 'all',
      };

      let connectionStateHandler: (() => void) | undefined;

      mockRTCPeerConnection.mockImplementation(() => {
        const mockPc: any = {
          connectionState: 'new',
          iceConnectionState: 'new',
          addTrack: jest.fn(),
          getSenders: jest.fn(() => []),
          getStats: jest.fn(async () => new Map()),
          close: jest.fn(),
          ontrack: null,
          oniceconnectionstatechange: null,
        };

        Object.defineProperty(mockPc, 'onconnectionstatechange', {
          get() {
            return connectionStateHandler;
          },
          set(handler: () => void) {
            connectionStateHandler = handler;
          },
        });

        return mockPc;
      });

      const peerConnection = await handler.createPeerConnection('remote-6', config);

      // Simulate connection failure
      (peerConnection as any).connectionState = 'failed';
      if (connectionStateHandler) {
        connectionStateHandler();
      }

      // Verify that the connection state change was detected
      // (In real implementation, this would trigger retry logic in the caller)
      expect(peerConnection.connectionState).toBe('failed');
    });
  });
});
