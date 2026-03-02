// Unit tests for Regular Node component
// Task 10.1: Create regular node media flow logic

import { RegularNode } from './regular-node';
import { MediaHandler, MediaStream } from './media-handler';
import { PeerConnectionConfig } from '../shared/types';

// Mock MediaHandler
jest.mock('./media-handler');

describe('RegularNode', () => {
  let regularNode: RegularNode;
  let mockMediaHandler: jest.Mocked<MediaHandler>;
  let mockPeerConnection: jest.Mocked<RTCPeerConnection>;
  let mockLocalStream: MediaStream;
  const localParticipantId = 'participant-1';
  const relayId = 'relay-1';

  const defaultConfig: PeerConnectionConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    iceTransportPolicy: 'all',
  };

  beforeEach(() => {
    // Create mock peer connection
    mockPeerConnection = {
      close: jest.fn(),
      addTrack: jest.fn(),
      getSenders: jest.fn().mockReturnValue([]),
      getStats: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<RTCPeerConnection>;

    // Create mock local stream
    mockLocalStream = {
      streamId: 'stream-1',
      participantId: localParticipantId,
      tracks: [],
      isLocal: true,
    };

    // Create mock media handler
    mockMediaHandler = new MediaHandler(localParticipantId) as jest.Mocked<MediaHandler>;
    mockMediaHandler.createPeerConnection = jest.fn().mockResolvedValue(mockPeerConnection);
    mockMediaHandler.getLocalStream = jest.fn().mockReturnValue({
      id: mockLocalStream.streamId,
      getTracks: jest.fn().mockReturnValue([]),
    });
    mockMediaHandler.addLocalStream = jest.fn();
    mockMediaHandler.closePeerConnection = jest.fn();
    mockMediaHandler.onRemoteStream = jest.fn();
    mockMediaHandler.getConnectionStats = jest.fn().mockResolvedValue(new Map());

    regularNode = new RegularNode(localParticipantId, mockMediaHandler);
  });

  describe('start', () => {
    it('should establish connection to assigned relay', async () => {
      await regularNode.start(relayId, defaultConfig);

      expect(mockMediaHandler.createPeerConnection).toHaveBeenCalledWith(
        relayId,
        defaultConfig
      );
      expect(regularNode.isRegularNodeActive()).toBe(true);
      expect(regularNode.getAssignedRelayId()).toBe(relayId);
    });

    it('should add local stream to relay connection (Requirement 6.1)', async () => {
      await regularNode.start(relayId, defaultConfig);

      expect(mockMediaHandler.addLocalStream).toHaveBeenCalledWith(
        mockPeerConnection,
        expect.objectContaining({
          streamId: mockLocalStream.streamId,
          participantId: localParticipantId,
          isLocal: true,
        })
      );
    });

    it('should throw error if already active', async () => {
      await regularNode.start(relayId, defaultConfig);

      await expect(regularNode.start(relayId, defaultConfig)).rejects.toThrow(
        'Regular node is already active'
      );
    });

    it('should throw error if relay ID is not provided', async () => {
      await expect(regularNode.start('', defaultConfig)).rejects.toThrow(
        'Relay ID is required'
      );
    });

    it('should throw error if local stream not initialized', async () => {
      mockMediaHandler.getLocalStream = jest.fn().mockReturnValue(null);

      await expect(regularNode.start(relayId, defaultConfig)).rejects.toThrow(
        'Local media stream not initialized'
      );
    });

    it('should handle connection failure gracefully', async () => {
      mockMediaHandler.createPeerConnection = jest
        .fn()
        .mockRejectedValue(new Error('Connection failed'));

      await expect(regularNode.start(relayId, defaultConfig)).rejects.toThrow(
        'Failed to start regular node'
      );

      expect(regularNode.isRegularNodeActive()).toBe(false);
      expect(regularNode.getAssignedRelayId()).toBe(null);
    });
  });

  describe('stop', () => {
    it('should close connection to relay', async () => {
      await regularNode.start(relayId, defaultConfig);
      regularNode.stop();

      expect(mockMediaHandler.closePeerConnection).toHaveBeenCalledWith(relayId);
      expect(regularNode.isRegularNodeActive()).toBe(false);
      expect(regularNode.getAssignedRelayId()).toBe(null);
    });

    it('should handle stop when not active', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      regularNode.stop();

      expect(consoleSpy).toHaveBeenCalledWith('Regular node is not active');
      consoleSpy.mockRestore();
    });
  });

  describe('reassignRelay', () => {
    const newRelayId = 'relay-2';

    beforeEach(async () => {
      await regularNode.start(relayId, defaultConfig);
      jest.clearAllMocks();
    });

    it('should close old connection and establish new connection', async () => {
      await regularNode.reassignRelay(newRelayId, defaultConfig);

      expect(mockMediaHandler.closePeerConnection).toHaveBeenCalledWith(relayId);
      expect(mockMediaHandler.createPeerConnection).toHaveBeenCalledWith(
        newRelayId,
        defaultConfig
      );
      expect(regularNode.getAssignedRelayId()).toBe(newRelayId);
    });

    it('should add local stream to new relay connection', async () => {
      await regularNode.reassignRelay(newRelayId, defaultConfig);

      expect(mockMediaHandler.addLocalStream).toHaveBeenCalledWith(
        mockPeerConnection,
        expect.objectContaining({
          streamId: mockLocalStream.streamId,
          participantId: localParticipantId,
          isLocal: true,
        })
      );
    });

    it('should throw error if not active', async () => {
      regularNode.stop();

      await expect(regularNode.reassignRelay(newRelayId, defaultConfig)).rejects.toThrow(
        'Regular node is not active'
      );
    });

    it('should throw error if new relay ID is not provided', async () => {
      await expect(regularNode.reassignRelay('', defaultConfig)).rejects.toThrow(
        'New relay ID is required'
      );
    });

    it('should do nothing if reassigning to same relay', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await regularNode.reassignRelay(relayId, defaultConfig);

      expect(mockMediaHandler.closePeerConnection).not.toHaveBeenCalled();
      expect(mockMediaHandler.createPeerConnection).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        'Already assigned to this relay, no action needed'
      );

      consoleSpy.mockRestore();
    });

    it('should handle reassignment failure', async () => {
      mockMediaHandler.createPeerConnection = jest
        .fn()
        .mockRejectedValue(new Error('Connection failed'));

      await expect(regularNode.reassignRelay(newRelayId, defaultConfig)).rejects.toThrow(
        'Failed to reassign relay'
      );

      // Should attempt to restore old relay ID
      expect(regularNode.getAssignedRelayId()).toBe(relayId);
    });
  });

  describe('onRemoteStream', () => {
    it('should register callback for remote streams (Requirement 6.2)', async () => {
      await regularNode.start(relayId, defaultConfig);

      const callback = jest.fn();
      regularNode.onRemoteStream(callback);

      expect(mockMediaHandler.onRemoteStream).toHaveBeenCalled();
    });

    it('should only process streams from assigned relay', async () => {
      await regularNode.start(relayId, defaultConfig);

      const callback = jest.fn();
      let registeredCallback: ((stream: MediaStream) => void) | undefined;

      mockMediaHandler.onRemoteStream = jest.fn((cb) => {
        registeredCallback = cb;
      });

      regularNode.onRemoteStream(callback);

      // Simulate receiving stream from assigned relay
      const relayStream: MediaStream = {
        streamId: 'stream-2',
        participantId: relayId,
        tracks: [],
        isLocal: false,
      };

      registeredCallback?.(relayStream);
      expect(callback).toHaveBeenCalledWith(relayStream);

      // Simulate receiving stream from different participant (should be ignored)
      callback.mockClear();
      const otherStream: MediaStream = {
        streamId: 'stream-3',
        participantId: 'other-participant',
        tracks: [],
        isLocal: false,
      };

      registeredCallback?.(otherStream);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('getRelayConnectionStats', () => {
    it('should return connection stats for relay', async () => {
      await regularNode.start(relayId, defaultConfig);

      const stats = await regularNode.getRelayConnectionStats();

      expect(mockMediaHandler.getConnectionStats).toHaveBeenCalledWith(relayId);
      expect(stats).toBeInstanceOf(Map);
    });

    it('should throw error if not connected to relay', async () => {
      await expect(regularNode.getRelayConnectionStats()).rejects.toThrow(
        'Not connected to any relay'
      );
    });
  });

  describe('integration scenarios', () => {
    it('should handle complete lifecycle: start -> reassign -> stop', async () => {
      // Start with first relay
      await regularNode.start(relayId, defaultConfig);
      expect(regularNode.isRegularNodeActive()).toBe(true);
      expect(regularNode.getAssignedRelayId()).toBe(relayId);

      // Reassign to new relay
      const newRelayId = 'relay-2';
      await regularNode.reassignRelay(newRelayId, defaultConfig);
      expect(regularNode.getAssignedRelayId()).toBe(newRelayId);

      // Stop
      regularNode.stop();
      expect(regularNode.isRegularNodeActive()).toBe(false);
      expect(regularNode.getAssignedRelayId()).toBe(null);
    });

    it('should maintain single connection to relay at all times', async () => {
      await regularNode.start(relayId, defaultConfig);

      // Should have created exactly one connection
      expect(mockMediaHandler.createPeerConnection).toHaveBeenCalledTimes(1);

      // Reassign to new relay
      const newRelayId = 'relay-2';
      await regularNode.reassignRelay(newRelayId, defaultConfig);

      // Should have closed old connection and created new one
      expect(mockMediaHandler.closePeerConnection).toHaveBeenCalledTimes(1);
      expect(mockMediaHandler.createPeerConnection).toHaveBeenCalledTimes(2);
    });
  });
});
