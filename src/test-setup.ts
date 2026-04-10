// Global test setup for WebRTC mocking
// This file provides mock implementations of WebRTC APIs for testing

// Mock MediaStream
class MockMediaStream {
  id: string;
  active: boolean;
  private tracks: MediaStreamTrack[];

  constructor() {
    this.id = `mock-stream-${Math.random()}`;
    this.active = true;
    this.tracks = [];
  }

  getTracks(): MediaStreamTrack[] {
    return this.tracks;
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t: any) => t.kind === 'audio');
  }

  getVideoTracks(): MediaStreamTrack[] {
    return this.tracks.filter((t: any) => t.kind === 'video');
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
  }

  removeTrack(track: MediaStreamTrack): void {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
}

// Mock MediaStreamTrack
class MockMediaStreamTrack {
  kind: string;
  id: string;
  label: string;
  enabled: boolean;
  muted: boolean;
  readyState: string;

  constructor(kind: string) {
    this.kind = kind;
    this.id = `mock-track-${Math.random()}`;
    this.label = `Mock ${kind} track`;
    this.enabled = true;
    this.muted = false;
    this.readyState = 'live';
  }

  stop(): void {
    this.readyState = 'ended';
  }
}

// Mock RTCPeerConnection
class MockRTCPeerConnection {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  private eventListeners: Map<string, Function[]> = new Map();
  private senders: RTCRtpSender[] = [];

  constructor(config?: RTCConfiguration) {
    // Mock implementation
  }

  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({
      type: 'offer' as RTCSdpType,
      sdp: 'mock-sdp-offer',
    });
  }

  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({
      type: 'answer' as RTCSdpType,
      sdp: 'mock-sdp-answer',
    });
  }

  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description as RTCSessionDescription;
    // Simulate connection state progression immediately for tests
    this.connectionState = 'connected';
    this.iceConnectionState = 'connected';
    this.iceGatheringState = 'complete';
    return Promise.resolve();
  }

  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
    const sender = { track, replaceTrack: jest.fn() } as unknown as RTCRtpSender;
    this.senders.push(sender);
    return sender;
  }

  getSenders(): RTCRtpSender[] {
    return this.senders;
  }

  getReceivers(): RTCRtpReceiver[] {
    return [];
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
    const dc = {
      label,
      readyState: 'open',
      send: jest.fn(),
      close: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      onopen: null as ((event: Event) => void) | null,
      onmessage: null as ((event: MessageEvent) => void) | null,
      onclose: null as ((event: Event) => void) | null,
      onerror: null as ((event: Event) => void) | null,
    } as unknown as RTCDataChannel;
    // Fire onopen asynchronously so handlers can be set first
    setTimeout(() => { if ((dc as any).onopen) (dc as any).onopen(new Event('open')); }, 0);
    return dc;
  }

  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.connectionState = 'closed';
  }

  getStats(): Promise<RTCStatsReport> {
    const stats = new Map();
    
    // Add transport stats with DTLS information if connected
    if (this.connectionState === 'connected') {
      stats.set('transport-1', {
        type: 'transport',
        dtlsState: 'connected',
        timestamp: Date.now(),
      });
    }
    
    return Promise.resolve(stats as RTCStatsReport);
  }

  addEventListener(type: string, listener: Function): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    this.eventListeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: Function): void {
    const listeners = this.eventListeners.get(type);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }
}

// Setup global mocks
beforeAll(() => {
  // Mock navigator.mediaDevices.getUserMedia
  global.navigator = {
    mediaDevices: {
      getUserMedia: jest.fn().mockImplementation((constraints) => {
        const stream = new MockMediaStream();
        if (constraints.audio) {
          stream.addTrack(new MockMediaStreamTrack('audio') as any);
        }
        if (constraints.video) {
          stream.addTrack(new MockMediaStreamTrack('video') as any);
        }
        return Promise.resolve(stream);
      }),
    },
  } as any;

  // Mock RTCPeerConnection
  (global as any).RTCPeerConnection = MockRTCPeerConnection;

  // Mock MediaStream
  (global as any).MediaStream = MockMediaStream;

  // Mock RTCSessionDescription and RTCIceCandidate
  (global as any).RTCSessionDescription = class {
    constructor(public init: RTCSessionDescriptionInit) {}
  };
  (global as any).RTCIceCandidate = class {
    constructor(public init: RTCIceCandidateInit) {}
  };
});
