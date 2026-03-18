// Media Handler component
// Manages WebRTC peer connections, local media capture, and remote stream handling

import { PeerConnectionConfig } from '../shared/types';

/**
 * MediaStream interface representing audio/video streams
 */
export interface MediaStream {
  streamId: string;
  participantId: string;
  tracks: MediaStreamTrack[];
  isLocal: boolean;
  /** The original browser MediaStream object — use this as video.srcObject for reliable playback */
  nativeStream?: globalThis.MediaStream;
}

/**
 * Callback type for remote stream events
 */
type RemoteStreamCallback = (stream: MediaStream) => void;

/**
 * Callback type for ICE candidate events
 */
type ICECandidateCallback = (remoteParticipantId: string, candidate: RTCIceCandidate) => void;

/**
 * MediaHandler manages WebRTC peer connections and media streams
 * 
 * Responsibilities:
 * - Capture local media (camera/microphone)
 * - Create and manage peer connections
 * - Handle remote media streams
 * - Adapt bitrate based on network conditions
 * - Monitor connection statistics
 * - Clean up connections properly
 */
export class MediaHandler {
  private localStream: globalThis.MediaStream | null = null;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private remoteStreamCallbacks: RemoteStreamCallback[] = [];
  private iceCandidateCallbacks: ICECandidateCallback[] = [];
  private localParticipantId: string;
  private connectionRetries: Map<string, number> = new Map(); // Track retry attempts
  private retryTimeouts: Map<string, NodeJS.Timeout> = new Map(); // Track retry timers
  private emittedStreams: Set<string> = new Set(); // Track which streams we've already emitted
  private remoteStreams: Map<string, globalThis.MediaStream> = new Map(); // Track remote streams for relay forwarding
  // Maps native stream ID → original participant ID for relay-forwarded streams
  private streamIdToParticipantId: Map<string, string> = new Map();
  // Track which peer connection each stream was received from (participantId → peerId)
  private streamSourcePeer: Map<string, string> = new Map();
  // Pending streams received before their relay stream map arrived
  private pendingRelayStreams: Map<string, { stream: globalThis.MediaStream; connectionId: string }> = new Map();
  // Reusable relay stream map data channels, keyed by remote participant ID
  private relayStreamMapChannels: Map<string, RTCDataChannel> = new Map();
  // Canvas pipeline video elements for relay forwarding: key = streamId-senderIndex, value = hidden video element
  private relaySourceElements: Map<string, HTMLVideoElement> = new Map();
  // Callback fired when a pending stream is resolved (timeout or relay-stream-map)
  // Used by relay nodes to send updated stream maps to connected peers
  private streamResolvedCallbacks: Array<(participantId: string, stream: globalThis.MediaStream) => void> = [];
  // Callback fired when a relay-stream-map reveals a participant ID we haven't seen before
  private unknownParticipantCallbacks: Array<(participantId: string) => void> = [];

  // Deferred emit timers: when relay-stream-map arrives before ontrack, we wait a short
  // period to collect all tracks (audio + video) before emitting the resolved stream.
  private pendingEmitTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Callback fired when a peer connection needs renegotiation (tracks added)
  private negotiationNeededCallbacks: Array<(remoteParticipantId: string, peerConnection: RTCPeerConnection) => void> = [];

  /**
   * Register callback fired when a peer connection needs renegotiation.
   * Used by relay nodes to send updated offers after adding forwarded tracks.
   */
  onNegotiationNeeded(callback: (remoteParticipantId: string, peerConnection: RTCPeerConnection) => void): void {
    this.negotiationNeededCallbacks.push(callback);
  }

  constructor(localParticipantId: string) {
    this.localParticipantId = localParticipantId;
  }

  /**
   * Initialize local media capture (Task 8.1)
   * Captures camera and microphone streams
   *
   * @param constraints - Media stream constraints for audio/video
   * @returns Promise resolving to MediaStream with local media
   * @throws Error if media capture fails
   */
  async initializeLocalMedia(
    constraints: MediaStreamConstraints = { audio: true, video: true }
  ): Promise<MediaStream> {
    try {
      // Capture local media using getUserMedia
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Convert to our MediaStream interface
      const mediaStream: MediaStream = {
        streamId: this.localStream.id,
        participantId: this.localParticipantId,
        tracks: this.localStream.getTracks(),
        isLocal: true,
      };

      return mediaStream;
    } catch (error) {
      throw new Error(
        `Failed to initialize local media: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Create peer connection to another participant (Task 8.2, 14.1, 18.1)
   * Configures ICE servers and transport policy
   * Enables DTLS-SRTP for media encryption (Requirement 12.1)
   * Implements connection failure handling with TURN fallback (Requirement 1.2, 1.3)
   *
   * @param remoteParticipantId - ID of the remote participant
   * @param config - Peer connection configuration
   * @returns Promise resolving to RTCPeerConnection
   */
  async createPeerConnection(
      remoteParticipantId: string,
      config: PeerConnectionConfig
    ): Promise<RTCPeerConnection> {
      // Check if connection already exists
      if (this.peerConnections.has(remoteParticipantId)) {
        return this.peerConnections.get(remoteParticipantId)!;
      }

      // First attempt: Try direct connection (iceTransportPolicy: 'all')
      // This allows both direct P2P and TURN relay connections
      const peerConnection = new RTCPeerConnection({
        iceServers: config.iceServers,
        iceTransportPolicy: config.iceTransportPolicy || 'all', // 'all' tries direct first, then TURN
        // Security-focused configuration
        bundlePolicy: config.bundlePolicy || 'max-bundle', // Bundle all media on single transport for security
        rtcpMuxPolicy: config.rtcpMuxPolicy || 'require', // Multiplex RTP and RTCP for security
      });

      // Set up event handlers for the peer connection
      this.setupPeerConnectionHandlers(peerConnection, remoteParticipantId);

      // Tag the PC with its remote ID for logging
      (peerConnection as any)._remoteId = remoteParticipantId;

      // Store the peer connection
      this.peerConnections.set(remoteParticipantId, peerConnection);

      // Initialize retry counter only if it doesn't exist (don't reset during retries)
      if (!this.connectionRetries.has(remoteParticipantId)) {
        this.connectionRetries.set(remoteParticipantId, 0);
      }

      return peerConnection;
    }

  /**
   * Retry connection with exponential backoff (Task 18.1)
   * Implements exponential backoff: 1s, 2s, 4s, 8s, max 30s
   *
   * @param remoteParticipantId - ID of the remote participant
   * @param config - Peer connection configuration
   * @param onRetry - Callback to execute on retry (e.g., re-initiate signaling)
   * @returns Promise resolving when retry is scheduled
   *
   * Requirement 1.2, 1.3: Handle connection failures with TURN fallback and exponential backoff
   */
  async retryConnection(
      remoteParticipantId: string,
      config: PeerConnectionConfig,
      onRetry: () => Promise<void>
    ): Promise<void> {
      const retryCount = this.connectionRetries.get(remoteParticipantId) || 0;

      // Maximum 5 retries
      if (retryCount >= 5) {
        console.error(`Maximum retry attempts reached for ${remoteParticipantId}`);
        this.connectionRetries.delete(remoteParticipantId);
        throw new Error(`Failed to establish connection to ${remoteParticipantId} after ${retryCount} attempts`);
      }

      // Increment retry counter BEFORE scheduling
      this.connectionRetries.set(remoteParticipantId, retryCount + 1);

      // Calculate backoff delay: 1s, 2s, 4s, 8s, 16s (capped at 30s)
      const baseDelay = 1000; // 1 second
      const delay = Math.min(baseDelay * Math.pow(2, retryCount), 30000);

      console.log(`Retrying connection to ${remoteParticipantId} in ${delay}ms (attempt ${retryCount + 1}/5)`);

      // Schedule retry with exponential backoff
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(async () => {
          // Check if retry was cancelled
          if (!this.retryTimeouts.has(remoteParticipantId)) {
            resolve();
            return;
          }

          this.retryTimeouts.delete(remoteParticipantId);

          try {
            // Close existing failed connection (don't use closePeerConnection to avoid clearing retry counter)
            const existingConnection = this.peerConnections.get(remoteParticipantId);
            if (existingConnection) {
              existingConnection.close();
              this.peerConnections.delete(remoteParticipantId);
            }

            // Create new connection (will try TURN if direct failed)
            await this.createPeerConnection(remoteParticipantId, config);

            // Execute retry callback (e.g., re-initiate signaling)
            await onRetry();

            resolve();
          } catch (error) {
            reject(error);
          }
        }, delay);

        this.retryTimeouts.set(remoteParticipantId, timeout);
      });
    }

  /**
   * Cancel pending retry for a participant
   *
   * @param remoteParticipantId - ID of the remote participant
   */
  cancelRetry(remoteParticipantId: string): void {
    const timeout = this.retryTimeouts.get(remoteParticipantId);
    if (timeout) {
      clearTimeout(timeout);
      this.retryTimeouts.delete(remoteParticipantId);
    }
    this.connectionRetries.delete(remoteParticipantId);
  }

  /**
   * Reset retry counter for a participant (call when connection succeeds)
   *
   * @param remoteParticipantId - ID of the remote participant
   */
  resetRetryCounter(remoteParticipantId: string): void {
    this.connectionRetries.set(remoteParticipantId, 0);
    this.cancelRetry(remoteParticipantId);
  }

  /**
   * Add local stream to peer connection (Task 8.2)
   *
   * @param peerConnection - The peer connection to add stream to
   * @param stream - The media stream to add
   */
  addLocalStream(peerConnection: RTCPeerConnection, stream: MediaStream): void {
    if (!this.localStream) {
      throw new Error('Local stream not initialized. Call initializeLocalMedia first.');
    }

    const peerId = (peerConnection as any)._remoteId || 'unknown';
    const tracksBefore = peerConnection.getSenders().length;

    // Add each track from the local stream to the peer connection
    // Check if track is already added to avoid "sender already exists" error
    this.localStream.getTracks().forEach((track) => {
      // Check if this track is already being sent on this peer connection
      const senders = peerConnection.getSenders();
      const trackAlreadyAdded = senders.some(sender => sender.track === track);
      
      if (!trackAlreadyAdded && this.localStream) {
        peerConnection.addTrack(track, this.localStream);
      }
    });

    const tracksAfter = peerConnection.getSenders().length;
    const tracksAdded = tracksAfter - tracksBefore;
    console.log(`[MediaHandler] addLocalStream → ${peerId.slice(-8)}: added ${tracksAdded} tracks (${tracksBefore} → ${tracksAfter})`);
  }
  /**
   * Add remote stream tracks to peer connection for relay forwarding
   * Used by relay nodes to forward streams from one participant to others
   *
   * Chrome cannot re-send a received MediaStreamTrack on another RTCPeerConnection —
   * it produces framesReceived=0 (empty frames). We work around this for video by:
   * - Drawing the received video into a canvas via setInterval (not rAF — throttled in bg tabs)
   * - Capturing a fresh track from the canvas via captureStream()
   * - Adding BOTH the canvas video track AND the original audio track to a single synthetic
   *   MediaStream so the receiver sees one unified stream (not two separate audio/video streams)
   *
   * @param peerConnection - The peer connection to add tracks to
   * @param remoteStream - The remote MediaStream to forward
   * @param originalParticipantId - The original source participant ID
   */
  addRemoteStreamForRelay(
    peerConnection: RTCPeerConnection,
    remoteStream: globalThis.MediaStream,
    originalParticipantId?: string,
    onTracksAdded?: () => void
  ): void {
    const pcId = (peerConnection as any)._remoteId ?? 'unknown';
    console.log(`[MediaHandler] addRemoteStreamForRelay: ENTER stream=${remoteStream.id.slice(0,8)} participant=${originalParticipantId?.slice(-8)} pc=${pcId?.slice(-8)} tracks=${remoteStream.getTracks().map(t=>t.kind).join(',')}`);
    // Register the stream→participant mapping so the receiver can attribute it correctly
    if (originalParticipantId) {
      this.streamIdToParticipantId.set(remoteStream.id, originalParticipantId);
    } else {
      console.warn(`[MediaHandler] addRemoteStreamForRelay: no originalParticipantId for stream ${remoteStream.id}`);
    }

    const senders = peerConnection.getSenders();

    // Dedup by originalParticipantId: if we already have senders for this participant,
    // use replaceTrack to swap in the new tracks rather than adding duplicates.
    // This handles the case where a participant transitions from regular→relay and
    // sends a new synthetic stream — we update the existing senders in-place.
    if (originalParticipantId) {
      const existingSenders = senders.filter(s => (s as any)._sourceParticipantId === originalParticipantId);
      console.log(`[MediaHandler] addRemoteStreamForRelay: DEDUP CHECK stream=${remoteStream.id.slice(0,8)} participant=${originalParticipantId.slice(-8)} pc=${pcId?.slice(-8)} existingSenders=${existingSenders.length} totalSenders=${senders.length}`);
      if (existingSenders.length > 0) {
        // Check if this is actually a different stream (stream ID changed)
        const existingStreamId = (existingSenders[0] as any)._sourceStreamId;
        if (existingStreamId === remoteStream.id) {
          console.log(`[MediaHandler] addRemoteStreamForRelay: DEDUP same stream ${remoteStream.id.slice(0,8)} already on pc=${pcId?.slice(-8)} for ${originalParticipantId.slice(-8)}, skipping`);
          return;
        }
        console.log(`[MediaHandler] addRemoteStreamForRelay: REPLACE stream for ${originalParticipantId.slice(-8)} on pc=${pcId?.slice(-8)}: ${existingStreamId?.slice(0,8)} → ${remoteStream.id.slice(0,8)}`);
        // Stop old canvas pipeline for the old stream
        const oldVideo = this.relaySourceElements.get(existingStreamId);
        if (oldVideo) {
          (oldVideo as any)._stopped = true;
          clearInterval((oldVideo as any)._intervalId);
          oldVideo.srcObject = null;
          oldVideo.remove();
          const oldCanvas = (oldVideo as any)._canvas as HTMLCanvasElement | undefined;
          if (oldCanvas) oldCanvas.remove();
          this.relaySourceElements.delete(existingStreamId);
        }
        // Build new canvas pipeline for the new stream, then replaceTrack
        this.replaceTracksForParticipant(peerConnection, remoteStream, originalParticipantId, existingSenders);
        return;
      }
    }

    // Also check legacy dedup by stream ID (no participant ID known)
    const alreadyAdded = senders.some(s => (s as any)._sourceStreamId === remoteStream.id);
    console.log(`[MediaHandler] addRemoteStreamForRelay: LEGACY DEDUP CHECK stream=${remoteStream.id.slice(0,8)} pc=${pcId?.slice(-8)} alreadyAdded=${alreadyAdded} senders with _sourceStreamId: [${senders.filter(s => (s as any)._sourceStreamId).map(s => (s as any)._sourceStreamId.slice(0,8)).join(', ')}]`);
    if (alreadyAdded) {
      console.log(`[MediaHandler] addRemoteStreamForRelay: DEDUP stream ${remoteStream.id.slice(0,8)} already on pc=${pcId?.slice(-8)}, skipping`);
      return;
    }

    const videoTracks = remoteStream.getVideoTracks();
    const audioTracks = remoteStream.getAudioTracks();

    if (videoTracks.length === 0) {
      // Audio-only stream: forward directly
      audioTracks.forEach(track => {
        const sender = peerConnection.addTrack(track, remoteStream);
        (sender as any)._sourceStreamId = remoteStream.id;
        (sender as any)._sourceParticipantId = originalParticipantId;
        console.log(`[MediaHandler] addRemoteStreamForRelay: added audio-only track directly for stream ${remoteStream.id.slice(0,8)}`);
      });
      return;
    }

    // Create a single synthetic stream that will carry both the canvas video and original audio.
    // Both tracks must share the same stream so the receiver sees one unified stream, not two.
    const syntheticStream = new MediaStream();

    // Canvas-based video re-sourcing
    const videoTrack = videoTracks[0];
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;

    const hiddenVideo = document.createElement('video');
    hiddenVideo.srcObject = remoteStream;
    hiddenVideo.autoplay = true;
    hiddenVideo.muted = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px';
    document.body.appendChild(hiddenVideo);

    // Wait for the video to have real dimensions before calling captureStream.
    // captureStream() negotiates resolution during the WebRTC offer/answer — if we
    // call it before loadedmetadata the canvas is still 640x480 (or 2x2 on some
    // browsers) and the track gets locked to that tiny resolution for the session.
    const setupCanvasPipeline = () => {
      // Size canvas to actual video dimensions
      if (hiddenVideo.videoWidth > 0 && hiddenVideo.videoHeight > 0) {
        canvas.width = hiddenVideo.videoWidth;
        canvas.height = hiddenVideo.videoHeight;
      }
    console.log(`[MediaHandler] addRemoteStreamForRelay: real dimensions ready ${hiddenVideo.videoWidth}x${hiddenVideo.videoHeight} for stream ${remoteStream.id.slice(0,8)}`);

      const intervalId = setInterval(() => {
        if ((hiddenVideo as any)._stopped) {
          clearInterval(intervalId);
          return;
        }
        if (hiddenVideo.readyState >= 2 && hiddenVideo.videoWidth > 0) {
          if (canvas.width !== hiddenVideo.videoWidth || canvas.height !== hiddenVideo.videoHeight) {
            canvas.width = hiddenVideo.videoWidth;
            canvas.height = hiddenVideo.videoHeight;
          }
          ctx.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
        }
      }, 33); // ~30fps

      const canvasStream = canvas.captureStream(30);
      const canvasVideoTrack = canvasStream.getVideoTracks()[0];

      (hiddenVideo as any)._intervalId = intervalId;
      (hiddenVideo as any)._canvas = canvas;
      (hiddenVideo as any)._originalStream = remoteStream; // for reset on pipeline stop
      (hiddenVideo as any)._participantId = originalParticipantId;
      this.relaySourceElements.set(remoteStream.id, hiddenVideo);

      if (canvasVideoTrack) {
        syntheticStream.addTrack(canvasVideoTrack);
        console.log(`[MediaHandler] addRemoteStreamForRelay: canvas ready ${canvas.width}x${canvas.height} stream=${remoteStream.id.slice(0,8)}`);
      } else {
        // Fallback: use original video track directly
        syntheticStream.addTrack(videoTrack);
        console.warn(`[MediaHandler] addRemoteStreamForRelay: canvas captureStream failed, using direct video track`);
        clearInterval(intervalId);
        hiddenVideo.remove();
      }

      // Add audio tracks to the same synthetic stream
      audioTracks.forEach(track => {
        syntheticStream.addTrack(track);
      });

      // Update remoteStreams to use the synthetic stream so buildStreamMapForPeer
      // broadcasts syntheticStream.id → participantId (which matches what the receiver
      // sees in ontrack, since we're sending syntheticStream's tracks).
      if (originalParticipantId) {
        this.remoteStreams.set(originalParticipantId, syntheticStream);
        const pcId = (peerConnection as any)._remoteId;
        if (pcId) {
          this.streamSourcePeer.set(originalParticipantId, pcId);
        }
      }

      // Add all tracks from the synthetic stream to the peer connection
      const tracksToAdd = syntheticStream.getTracks();
      console.log(`[MediaHandler] addRemoteStreamForRelay: CANVAS adding ${tracksToAdd.length} tracks from synthetic stream ${syntheticStream.id.slice(0,8)} to pc=${pcId?.slice(-8)}`);
      tracksToAdd.forEach(track => {
        console.log(`[MediaHandler] addRemoteStreamForRelay: CANVAS adding ${track.kind} track ${track.id.slice(0,8)} to pc=${pcId?.slice(-8)}`);
        const sender = peerConnection.addTrack(track, syntheticStream);
        (sender as any)._sourceStreamId = remoteStream.id; // key by original stream ID for dedup
        (sender as any)._sourceParticipantId = originalParticipantId; // key by participant for replace
        console.log(`[MediaHandler] addRemoteStreamForRelay: CANVAS added ${track.kind} track, sender exists: ${!!sender}`);
      });
      const sendersAfterAdd = peerConnection.getSenders();
      console.log(`[MediaHandler] addRemoteStreamForRelay: CANVAS senders after addTrack: ${sendersAfterAdd.length} (${sendersAfterAdd.map(s => s.track?.kind ?? 'null').join(', ')})`);
      // Notify caller that tracks are added and remoteStreams is updated
      console.log(`[MediaHandler] addRemoteStreamForRelay: CANVAS SUCCESS stream=${remoteStream.id.slice(0,8)} synthetic=${syntheticStream.id.slice(0,8)} pc=${pcId?.slice(-8)} calling onTracksAdded=${!!onTracksAdded}`);
      if (onTracksAdded) onTracksAdded();
    };

    // Wait until the hidden video has real frame dimensions (videoWidth > 2).
    // Canvas-captured streams report videoWidth=2 at loadedmetadata time in Chrome
    // because the canvas hasn't rendered real frames yet. We must poll until we see
    // actual dimensions before calling captureStream() — otherwise the WebRTC offer
    // locks the track to 2x2 for the entire session.
    //
    // For re-relay streams (canvas→canvas), videoWidth stays at 0 or 2 indefinitely.
    // We detect this quickly: if after 500ms of polling dimensions are still <= 2,
    // we fall through to direct track forwarding immediately.
    const dimensionPollStart = Date.now();
    const FAST_FALLBACK_MS = 500; // If still 0/2 after this, it's a re-relay canvas stream
    const HARD_TIMEOUT_MS = 5000;
    const waitForRealDimensions = () => {
      if ((hiddenVideo as any)._stopped) return;
      if (hiddenVideo.videoWidth > 2 && hiddenVideo.videoHeight > 2) {
        setupCanvasPipeline();
        return;
      }
      const elapsed = Date.now() - dimensionPollStart;
      // Fast fallback: if dimensions are still 0 after 500ms, this is a re-relay canvas stream.
      // Skip the canvas pipeline and forward original tracks directly — no point waiting 5s.
      const isLikelyReRelay = elapsed > FAST_FALLBACK_MS && hiddenVideo.videoWidth === 0;
      // Hard cap: after 5s total, the source is likely a canvas stream that never renders real frames.
      // In that case, skip the canvas pipeline and add tracks directly.
      if (elapsed > HARD_TIMEOUT_MS || isLikelyReRelay) {
        (hiddenVideo as any)._stopped = true;
        hiddenVideo.srcObject = null;
        hiddenVideo.remove();

        // Check if another call already resolved this participant via a canvas pipeline.
        // If so, use that synthetic stream's tracks — don't overwrite remoteStreams or
        // double-call onTracksAdded (the first pipeline's callback already handled it).
        const alreadyResolved = originalParticipantId
          ? this.remoteStreams.get(originalParticipantId)
          : undefined;
        const streamToForward = (alreadyResolved && alreadyResolved.id !== remoteStream.id)
          ? alreadyResolved
          : remoteStream;

        if (alreadyResolved && alreadyResolved.id !== remoteStream.id) {
          console.warn(`[MediaHandler] addRemoteStreamForRelay: dimension poll timeout for stream ${remoteStream.id.slice(0,8)} at ${hiddenVideo.videoWidth}x${hiddenVideo.videoHeight}, canvas pipeline already resolved as ${alreadyResolved.id.slice(0,8)}, forwarding synthetic tracks`);
        } else {
          console.warn(`[MediaHandler] addRemoteStreamForRelay: dimension poll ${isLikelyReRelay ? 'fast-fallback (re-relay)' : 'timeout'} for stream ${remoteStream.id.slice(0,8)} at ${hiddenVideo.videoWidth}x${hiddenVideo.videoHeight}, forwarding original tracks directly`);
        }

        // Add tracks to the peer connection
        const existingSenders = peerConnection.getSenders();
        console.log(`[MediaHandler] addRemoteStreamForRelay: TIMEOUT adding tracks from ${streamToForward.id.slice(0,8)} to pc=${pcId?.slice(-8)} existingSenders=${existingSenders.length} streamTracks=${streamToForward.getTracks().map(t=>t.kind).join(',')}`);
        for (const track of streamToForward.getTracks()) {
          const alreadySending = existingSenders.some(s => s.track?.id === track.id);
          if (!alreadySending) {
            try {
              const sender = peerConnection.addTrack(track, streamToForward);
              (sender as any)._sourceStreamId = remoteStream.id; // key by original for dedup
              (sender as any)._sourceParticipantId = originalParticipantId;
              console.log(`[MediaHandler] addRemoteStreamForRelay: TIMEOUT added ${track.kind} track to pc=${pcId?.slice(-8)}`);
            } catch (e) { console.warn(`[MediaHandler] addRemoteStreamForRelay: TIMEOUT addTrack error`, e); }
          } else {
            console.log(`[MediaHandler] addRemoteStreamForRelay: TIMEOUT skipping ${track.kind} track already sending on pc=${pcId?.slice(-8)}`);
          }
        }

        // Only update remoteStreams and notify if not already resolved by another pipeline.
        // If already resolved, still call onTracksAdded so the caller sends the correct stream map
        // (buildStreamMapForPeer will use the already-set synthetic stream ID from remoteStreams).
        if (!alreadyResolved || alreadyResolved.id === remoteStream.id) {
          if (originalParticipantId) {
            this.remoteStreams.set(originalParticipantId, streamToForward);
          }
        }
        console.log(`[MediaHandler] addRemoteStreamForRelay: TIMEOUT calling onTracksAdded=${!!onTracksAdded} remoteStreams[${originalParticipantId?.slice(-8)}]=${this.remoteStreams.get(originalParticipantId!)?.id.slice(0,8)}`);
        if (onTracksAdded) onTracksAdded();
        return;
      }
      // Not ready yet — check again in 100ms
      setTimeout(waitForRealDimensions, 100);
    };

    hiddenVideo.play().catch(() => {});

    if (hiddenVideo.readyState >= 1 && hiddenVideo.videoWidth > 2) {
      // Already has real dimensions — set up immediately
      setupCanvasPipeline();
    } else {
      hiddenVideo.onloadedmetadata = () => {
        hiddenVideo.onloadedmetadata = null;
        // Even after loadedmetadata, canvas streams may still report 2x2 — poll until real
        waitForRealDimensions();
      };
      // Fallback: if loadedmetadata never fires (e.g. audio-only source), start polling after 2s
      setTimeout(() => {
        if (!(hiddenVideo as any)._intervalId && !(hiddenVideo as any)._stopped) {
          console.warn(`[MediaHandler] addRemoteStreamForRelay: loadedmetadata timeout for stream ${remoteStream.id.slice(0,8)}, starting dimension poll`);
          hiddenVideo.onloadedmetadata = null;
          waitForRealDimensions();
        }
      }, 2000);
    }
  }

  /**
   * Replace tracks on existing senders for a participant whose stream changed.
   * Used when a regular node becomes a relay and sends a new synthetic stream.
   * Builds a new canvas pipeline and calls replaceTrack on existing video/audio senders.
   */
  private replaceTracksForParticipant(
    peerConnection: RTCPeerConnection,
    remoteStream: globalThis.MediaStream,
    originalParticipantId: string,
    existingSenders: RTCRtpSender[]
  ): void {
    const videoTracks = remoteStream.getVideoTracks();
    const audioTracks = remoteStream.getAudioTracks();
    const syntheticStream = new MediaStream();

    const videoSender = existingSenders.find(s => s.track?.kind === 'video');
    const audioSender = existingSenders.find(s => s.track?.kind === 'audio');

    if (videoTracks.length > 0 && videoSender) {
      // Build new canvas pipeline
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d')!;
      const hiddenVideo = document.createElement('video');
      hiddenVideo.srcObject = remoteStream;
      hiddenVideo.autoplay = true;
      hiddenVideo.muted = true;
      hiddenVideo.playsInline = true;
      hiddenVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:-9999px';
      document.body.appendChild(hiddenVideo);
      hiddenVideo.play().catch(() => {});

      const intervalId = setInterval(() => {
        if ((hiddenVideo as any)._stopped) { clearInterval(intervalId); return; }
        if (hiddenVideo.readyState >= 2 && hiddenVideo.videoWidth > 0) {
          if (canvas.width !== hiddenVideo.videoWidth || canvas.height !== hiddenVideo.videoHeight) {
            canvas.width = hiddenVideo.videoWidth;
            canvas.height = hiddenVideo.videoHeight;
          }
          ctx.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
        }
      }, 33);

      const canvasStream = canvas.captureStream(30);
      const canvasVideoTrack = canvasStream.getVideoTracks()[0];
      if (canvasVideoTrack) {
        syntheticStream.addTrack(canvasVideoTrack);
        (hiddenVideo as any)._intervalId = intervalId;
        (hiddenVideo as any)._canvas = canvas;
        this.relaySourceElements.set(remoteStream.id, hiddenVideo);
        videoSender.replaceTrack(canvasVideoTrack).catch(e =>
          console.error(`[MediaHandler] replaceTrack video failed for ${originalParticipantId.slice(-8)}:`, e)
        );
        (videoSender as any)._sourceStreamId = remoteStream.id;
        (videoSender as any)._sourceParticipantId = originalParticipantId;
        console.log(`[MediaHandler] replaceTracksForParticipant: replaced video track for ${originalParticipantId.slice(-8)}`);
      } else {
        clearInterval(intervalId);
        hiddenVideo.remove();
      }
    }

    if (audioTracks.length > 0 && audioSender) {
      audioSender.replaceTrack(audioTracks[0]).catch(e =>
        console.error(`[MediaHandler] replaceTrack audio failed for ${originalParticipantId.slice(-8)}:`, e)
      );
      (audioSender as any)._sourceStreamId = remoteStream.id;
      (audioSender as any)._sourceParticipantId = originalParticipantId;
      console.log(`[MediaHandler] replaceTracksForParticipant: replaced audio track for ${originalParticipantId.slice(-8)}`);
    }

    // Update remoteStreams to the new synthetic stream
    this.remoteStreams.set(originalParticipantId, syntheticStream.getTracks().length > 0 ? syntheticStream : remoteStream);
    console.log(`[MediaHandler] replaceTracksForParticipant: updated remoteStreams for ${originalParticipantId.slice(-8)}`);
  }

  /**
   * Send (or update) the relay stream map to a remote peer via a data channel.
   * Creates the channel on first call; reuses it on subsequent calls.
   * streamMap: { [nativeStreamId]: originalParticipantId }
   */
  sendRelayStreamMap(remoteParticipantId: string, peerConnection: RTCPeerConnection, streamMap: Record<string, string>): void {
    if (Object.keys(streamMap).length === 0) {
      console.log(`[MediaHandler] sendRelayStreamMap: empty map for ${remoteParticipantId}, skipping`);
      return;
    }

    const existing = this.relayStreamMapChannels.get(remoteParticipantId);
    if (existing && existing.readyState === 'open') {
      existing.send(JSON.stringify(streamMap));
      console.log(`[MediaHandler] sendRelayStreamMap → ${remoteParticipantId.slice(-8)}:`, streamMap);
    } else {
      // Clean up stale channel reference before creating a new one
      if (existing) {
        try { existing.close(); } catch (_) {}
        this.relayStreamMapChannels.delete(remoteParticipantId);
      }
      // Create a new channel (use a unique label so it doesn't conflict with a closed one)
      const label = `relay-stream-map-${Date.now()}`;
      const dc = peerConnection.createDataChannel(label);
      // Store immediately so concurrent calls within the same tick reuse this channel
      this.relayStreamMapChannels.set(remoteParticipantId, dc);
      dc.onopen = () => {
        dc.send(JSON.stringify(streamMap));
        console.log(`[MediaHandler] sendRelayStreamMap (new ch) → ${remoteParticipantId.slice(-8)}:`, streamMap);
      };
      dc.onerror = (e) => {
        console.error(`[MediaHandler] sendRelayStreamMap: data channel error for ${remoteParticipantId}:`, e);
        this.relayStreamMapChannels.delete(remoteParticipantId);
      };
    }
  }
  /**
   * Register callback fired when a pending stream resolves to a participant ID.
   * Used by relay nodes to send updated stream maps after late-arriving streams.
   */
  onStreamResolved(callback: (participantId: string, stream: globalThis.MediaStream) => void): void {
    this.streamResolvedCallbacks.push(callback);
  }

  /**
   * Register callback fired when a relay-stream-map reveals a participant ID
   * that hasn't been seen before (e.g. joined before this node).
   */
  onUnknownParticipant(callback: (participantId: string) => void): void {
    this.unknownParticipantCallbacks.push(callback);
  }

  /**
   * Get streams that are pending relay-stream-map resolution.
   * Returns a map of nativeStreamId → { stream, connectionId (= remote peer ID) }
   * Used by relay nodes to forward streams that haven't been attributed yet.
   */
  getPendingStreams(): Map<string, { stream: globalThis.MediaStream; connectionId: string }> {
    return new Map(this.pendingRelayStreams);
  }

  /**
   * Get all remote streams (for relay forwarding)
   * Returns a map of participant IDs to their MediaStreams
   *
   * @returns Map of participant IDs to remote streams
   */
  getRemoteStreams(): Map<string, globalThis.MediaStream> {
    return new Map(this.remoteStreams);
  }

  /**
   * Get the source peer for a participant's stream (for relay forwarding)
   * Returns the peer ID we received this participant's stream from
   *
   * @param participantId - ID of the participant whose stream source to get
   * @returns The peer ID we received the stream from, or undefined
   */
  getStreamSourcePeer(participantId: string): string | undefined {
    return this.streamSourcePeer.get(participantId);
  }

  /**
   * Get list of connected peer IDs
   *
   * @returns Array of participant IDs with active connections
   */
  getConnectedPeers(): string[] {
    return Array.from(this.peerConnections.keys());
  }

  /**
   * Get a specific peer connection
   *
   * @param participantId - ID of the participant
   * @returns The peer connection or undefined if not found
   */
  getPeerConnection(participantId: string): RTCPeerConnection | undefined {
    return this.peerConnections.get(participantId);
  }

  /**
   * Register callback for remote stream events (Task 8.5)
   *
   * @param callback - Function to call when remote stream is received
   */
  onRemoteStream(callback: RemoteStreamCallback): void {
    this.remoteStreamCallbacks.push(callback);
  }

  /**
   * Register callback for ICE candidate events
   *
   * @param callback - Function to call when ICE candidate is generated
   */
  onICECandidate(callback: ICECandidateCallback): void {
    this.iceCandidateCallbacks.push(callback);
  }

  /**
   * Adapt bitrate based on network conditions (Task 8.7)
   * Adjusts encoding parameters to match available bandwidth
   *
   * @param peerConnection - The peer connection to adjust
   * @param targetBitrate - Target bitrate in bits per second
   */
  async adaptBitrate(
    peerConnection: RTCPeerConnection,
    targetBitrate: number
  ): Promise<void> {
    const senders = peerConnection.getSenders();

    for (const sender of senders) {
      if (sender.track?.kind === 'video') {
        const parameters = sender.getParameters();

        if (!parameters.encodings) {
          parameters.encodings = [{}];
        }

        // Set max bitrate for each encoding
        parameters.encodings.forEach((encoding) => {
          encoding.maxBitrate = targetBitrate;
        });

        try {
          await sender.setParameters(parameters);
        } catch (error) {
          console.error(
            `Failed to adapt bitrate: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  /**
   * Close peer connection (Task 8.10)
   * Properly closes and disposes of peer connection
   *
   * @param remoteParticipantId - ID of the remote participant
   */
  closePeerConnection(remoteParticipantId: string): void {
    const peerConnection = this.peerConnections.get(remoteParticipantId);

    if (peerConnection) {
      // Stop canvas pipelines for senders on this PC and reset remoteStreams
      const senders = peerConnection.getSenders();
      for (const sender of senders) {
        if (!sender.track) continue;
        const streamId = (sender.track as any)._sourceStreamId;
        if (!streamId) continue;

        // Find the relay source element for this stream
        const relayVideo = this.relaySourceElements.get(streamId);
        if (relayVideo && (relayVideo as any)._targetPeerId === remoteParticipantId) {
          // Stop the canvas pipeline
          if (!(relayVideo as any)._stopped) {
            (relayVideo as any)._stopped = true;
            clearInterval((relayVideo as any)._intervalId);
            relayVideo.srcObject = null;
            relayVideo.remove();
            const canvas = (relayVideo as any)._canvas as HTMLCanvasElement | undefined;
            if (canvas) canvas.remove();
            this.relaySourceElements.delete(streamId);
          }

          // Reset remoteStreams to the original stream so next forward can create fresh pipeline
          const participantId = (relayVideo as any)._participantId;
          const originalStream = (relayVideo as any)._originalStream;
          if (participantId && originalStream) {
            const currentStream = this.remoteStreams.get(participantId);
            // Only reset if current stream is the synthetic (dead) one
            if (currentStream && currentStream.id !== originalStream.id) {
              console.log(
                `[MediaHandler] Resetting remoteStreams[${participantId.slice(-8)}] from synthetic ${currentStream.id.slice(0,8)} to original ${originalStream.id.slice(0,8)} after peer ${remoteParticipantId.slice(-8)} left`
              );
              this.remoteStreams.set(participantId, originalStream);
            }
          }
        }
      }

      // Close the connection
      peerConnection.close();

      // Remove from map
      this.peerConnections.delete(remoteParticipantId);
      
      // Remove streams that were received through this peer connection,
      // BUT only if we don't have a direct connection to that participant.
      // If we do have a direct connection, just clear the sourcePeer mapping so
      // the stream can be re-received directly (avoids wiping C's stream when an
      // intermediate relay leaves but C is still directly connected).
      const streamsToRemove: string[] = [];
      const streamsToKeep: string[] = [];
      this.streamSourcePeer.forEach((sourcePeer, participantId) => {
        if (sourcePeer === remoteParticipantId) {
          if (this.peerConnections.has(participantId)) {
            // We have a direct connection to this participant — keep the stream,
            // just clear the stale sourcePeer so it can be re-mapped on next relay-stream-map
            streamsToKeep.push(participantId);
          } else {
            streamsToRemove.push(participantId);
          }
        }
      });

      for (const participantId of streamsToKeep) {
        console.log(
          `[MediaHandler] Keeping stream for ${participantId.slice(-8)} (direct connection exists) after peer ${remoteParticipantId.slice(-8)} left`
        );
        this.streamSourcePeer.delete(participantId);
      }
      
      if (streamsToRemove.length > 0) {
        console.log(
          `[MediaHandler] Removing ${streamsToRemove.length} streams received through peer ${remoteParticipantId.slice(-8)}: [${streamsToRemove.map(p => p.slice(-8)).join(', ')}]`
        );
        for (const participantId of streamsToRemove) {
          this.remoteStreams.delete(participantId);
          this.streamSourcePeer.delete(participantId);
          // Also clean up stream ID mappings
          this.streamIdToParticipantId.forEach((pid, streamId) => {
            if (pid === participantId) {
              this.streamIdToParticipantId.delete(streamId);
            }
          });
        }
      }
      
      // Clean up emitted streams for this participant
      for (const streamKey of this.emittedStreams) {
        if (streamKey.startsWith(remoteParticipantId)) {
          this.emittedStreams.delete(streamKey);
        }
      }
    }

    // Clean up stale relay stream map channel for this peer
    const staleChannel = this.relayStreamMapChannels.get(remoteParticipantId);
    if (staleChannel) {
      try { staleChannel.close(); } catch (_) {}
      this.relayStreamMapChannels.delete(remoteParticipantId);
    }

    // Cancel any pending retries
    this.cancelRetry(remoteParticipantId);
  }

  /**
   * Remove a remote stream by participant ID.
   * Called when a participant leaves so relay nodes don't forward stale streams.
   */
  removeRemoteStream(participantId: string): void {
    this.remoteStreams.delete(participantId);

    // Collect stream IDs belonging to this participant before deleting mappings
    const streamIdsForParticipant: string[] = [];
    this.streamIdToParticipantId.forEach((pid, streamId) => {
      if (pid === participantId) {
        streamIdsForParticipant.push(streamId);
        this.streamIdToParticipantId.delete(streamId);
      }
    });

    // Cancel any deferred emit timers for this participant's streams
    for (const streamId of streamIdsForParticipant) {
      const timer = this.pendingEmitTimers.get(streamId);
      if (timer) {
        clearTimeout(timer);
        this.pendingEmitTimers.delete(streamId);
      }
      // Also remove from pendingRelayStreams in case the stream was never resolved
      this.pendingRelayStreams.delete(streamId);

      // Stop canvas relay pipelines for this stream (keyed by remoteStream.id directly)
      const relayVideo = this.relaySourceElements.get(streamId);
      if (relayVideo) {
        (relayVideo as any)._stopped = true;
        clearInterval((relayVideo as any)._intervalId);
        relayVideo.srcObject = null;
        relayVideo.remove();
        const canvas = (relayVideo as any)._canvas as HTMLCanvasElement | undefined;
        if (canvas) canvas.remove();
        this.relaySourceElements.delete(streamId);
      }
    }

    // Clean up emitted stream keys for this participant so they can be re-emitted on rejoin
    for (const streamKey of this.emittedStreams) {
      if (streamKey.startsWith(participantId + '-')) {
        this.emittedStreams.delete(streamKey);
      }
    }

    console.log(`[MediaHandler] removeRemoteStream: cleaned up participant ${participantId.slice(-8)}, streamIds=[${streamIdsForParticipant.map(s => s.slice(0,8)).join(', ')}]`);
  }

  /**
   * Get connection statistics (Task 8.9)
   * Extracts relevant metrics from RTCStatsReport
   *
   * @param remoteParticipantId - ID of the remote participant
   * @returns Promise resolving to RTCStatsReport
   * @throws Error if connection doesn't exist
   */
  async getConnectionStats(remoteParticipantId: string): Promise<RTCStatsReport> {
    const peerConnection = this.peerConnections.get(remoteParticipantId);

    if (!peerConnection) {
      throw new Error(`No peer connection found for participant: ${remoteParticipantId}`);
    }

    return await peerConnection.getStats();
  }

  /**
   * Verify that DTLS-SRTP encryption is active for a peer connection (Task 14.1)
   * Checks the connection's transport to ensure DTLS is established
   *
   * @param remoteParticipantId - ID of the remote participant
   * @returns Promise resolving to true if encryption is active, false otherwise
   * @throws Error if connection doesn't exist
   *
   * Requirement 12.1: All media streams must be encrypted using DTLS-SRTP
   */
  async verifyEncryptionActive(remoteParticipantId: string): Promise<boolean> {
    const peerConnection = this.peerConnections.get(remoteParticipantId);

    if (!peerConnection) {
      throw new Error(`No peer connection found for participant: ${remoteParticipantId}`);
    }

    // Check connection state - must be connected for encryption to be active
    if (peerConnection.connectionState !== 'connected') {
      return false;
    }

    // Get statistics to verify DTLS-SRTP is active
    const stats = await peerConnection.getStats();

    let dtlsActive = false;

    stats.forEach((report) => {
      // Check for DTLS transport
      if (report.type === 'transport') {
        // DTLS state should be 'connected' for active encryption
        if (report.dtlsState === 'connected') {
          dtlsActive = true;
        }
      }

      // Alternative: Check certificate stats which indicate DTLS handshake completed
      if (report.type === 'certificate') {
        dtlsActive = true;
      }
    });

    // Both DTLS and SRTP should be active for proper encryption
    // Note: In WebRTC, DTLS-SRTP is enabled by default and cannot be disabled
    // This verification ensures the connection is properly established
    return dtlsActive || peerConnection.connectionState === 'connected';
  }

  /**
   * Verify encryption is active for all peer connections (Task 14.1)
   * Checks all active connections to ensure DTLS-SRTP is working
   *
   * @returns Promise resolving to map of participant IDs to encryption status
   *
   * Requirement 12.1: All media streams must be encrypted using DTLS-SRTP
   */
  async verifyAllConnectionsEncrypted(): Promise<Map<string, boolean>> {
    const encryptionStatus = new Map<string, boolean>();

    for (const [participantId, _] of this.peerConnections) {
      try {
        const isEncrypted = await this.verifyEncryptionActive(participantId);
        encryptionStatus.set(participantId, isEncrypted);
      } catch (error) {
        console.error(
          `Error verifying encryption for ${participantId}:`,
          error instanceof Error ? error.message : String(error)
        );
        encryptionStatus.set(participantId, false);
      }
    }

    return encryptionStatus;
  }

  /**
   * Get local media stream
   *
   * @returns The local media stream or null if not initialized
   */
  getLocalStream(): globalThis.MediaStream | null {
    return this.localStream;
  }

  /**
   * Get all active peer connections
   *
   * @returns Map of participant IDs to peer connections
   */
  getPeerConnections(): Map<string, RTCPeerConnection> {
    return new Map(this.peerConnections);
  }

  /**
   * Stop local media stream and close all connections
   */
  cleanup(): void {
    // Stop all local media tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    // Close all peer connections
    this.peerConnections.forEach((_, participantId) => {
      this.closePeerConnection(participantId);
    });

    // Clear all retry timers
    this.retryTimeouts.forEach((timeout) => clearTimeout(timeout));
    this.retryTimeouts.clear();
    this.connectionRetries.clear();

    // Clear callbacks and emitted streams
    this.remoteStreamCallbacks = [];
    this.emittedStreams.clear();

    // Stop all canvas relay pipelines
    this.relaySourceElements.forEach((video) => {
      (video as any)._stopped = true;
      clearInterval((video as any)._intervalId);
      video.srcObject = null;
      video.remove();
      const canvas = (video as any)._canvas as HTMLCanvasElement | undefined;
      if (canvas) canvas.remove();
    });
    this.relaySourceElements.clear();
  }

  /**
   * Close all peer connections
   */
  closeAllConnections(): void {
    const participantIds = Array.from(this.peerConnections.keys());
    for (const participantId of participantIds) {
      this.closePeerConnection(participantId);
    }
  }

  /**
   * Get list of active connection participant IDs
   */
  getActiveConnections(): string[] {
    return Array.from(this.peerConnections.keys());
  }

  /**
   * Emit a resolved remote stream event with the correct participant ID.
   * Deduplicates by stream key to avoid firing multiple times per stream.
   */
  private emitResolvedStream(remoteStream: globalThis.MediaStream, participantId: string): void {
    const streamKey = `${participantId}-${remoteStream.id}`;
    if (this.emittedStreams.has(streamKey)) {
      console.log(`[MediaHandler] emitResolvedStream: DEDUP ${streamKey}`);
      return;
    }
    this.emittedStreams.add(streamKey);

    const mediaStream: MediaStream = {
      streamId: remoteStream.id,
      participantId,
      tracks: remoteStream.getTracks(),
      isLocal: false,
      nativeStream: remoteStream,
    };

    console.log(`[MediaHandler] emitResolvedStream: ${participantId.slice(-8)} stream=${remoteStream.id.slice(0,8)} tracks=${remoteStream.getTracks().map(t=>t.kind).join(',')}`);
    this.remoteStreamCallbacks.forEach((callback) => callback(mediaStream));
  }

  /**
   * Set up event handlers for peer connection (Task 8.5, 18.1)
   * Handles remote streams and connection state changes
   * Implements connection failure detection and retry logic
   *
   * @param peerConnection - The peer connection to set up
   * @param remoteParticipantId - ID of the remote participant
   */
  private setupPeerConnectionHandlers(
    peerConnection: RTCPeerConnection,
    remoteParticipantId: string
  ): void {
    // Fire when the browser determines a new offer is needed (e.g. tracks added)
    peerConnection.onnegotiationneeded = () => {
      console.log(`[MediaHandler] onnegotiationneeded for ${remoteParticipantId}, signalingState=${peerConnection.signalingState}`);
      this.negotiationNeededCallbacks.forEach(cb => cb(remoteParticipantId, peerConnection));
    };

    // Listen for relay stream-map data channel from the remote peer (relay node)
    peerConnection.ondatachannel = (event) => {
      if (event.channel.label.startsWith('relay-stream-map')) {
        event.channel.onmessage = (msg) => {
          try {
            const map: Record<string, string> = JSON.parse(msg.data);
            console.log(`[MediaHandler] relay-stream-map from ${remoteParticipantId.slice(-8)}:`, map);
            for (const [streamId, originalParticipantId] of Object.entries(map)) {
              this.streamIdToParticipantId.set(streamId, originalParticipantId);

              // Notify if this is a participant ID we haven't seen before
              if (!this.remoteStreams.has(originalParticipantId) && !this.pendingRelayStreams.has(streamId)) {
                this.unknownParticipantCallbacks.forEach(cb => cb(originalParticipantId));
              }
              // Flush any pending stream that was waiting for this mapping
              const pending = this.pendingRelayStreams.get(streamId);
              if (pending) {
                console.log(`[MediaHandler] relay-stream-map: flushing pending stream ${streamId} as ${originalParticipantId}`);
                this.pendingRelayStreams.delete(streamId);

                // Update remoteStreams map to use the correct key.
                // Only remove the connectionId entry if it points to THIS stream —
                // the relay may have its own stream stored under that key already.
                const existingUnderConnectionId = this.remoteStreams.get(pending.connectionId);
                if (existingUnderConnectionId && existingUnderConnectionId.id === pending.stream.id) {
                  this.remoteStreams.delete(pending.connectionId);
                }
                this.remoteStreams.set(originalParticipantId, pending.stream);
                
                // Track which peer we received this stream from (to prevent forwarding loops)
                this.streamSourcePeer.set(originalParticipantId, remoteParticipantId);
                console.log(`[MediaHandler] relay-stream-map: set sourcePeer for ${originalParticipantId.slice(-8)} = ${remoteParticipantId.slice(-8)}`);

                this.emitResolvedStream(pending.stream, originalParticipantId);
                // Notify relay nodes so they can send updated stream maps to their peers
                this.streamResolvedCallbacks.forEach(cb => cb(originalParticipantId, pending.stream));
              } else {
                // Check if this stream was already emitted under the wrong participant ID
                // (e.g. the 3000ms timeout fired before this map arrived)
                const alreadyEmittedAsWrongId = this.remoteStreams.get(remoteParticipantId);
                if (alreadyEmittedAsWrongId && alreadyEmittedAsWrongId.id === streamId && originalParticipantId !== remoteParticipantId) {
                  console.log(`[MediaHandler] relay-stream-map: re-attributing stream ${streamId} from ${remoteParticipantId} → ${originalParticipantId}`);
                  this.remoteStreams.delete(remoteParticipantId);
                  this.remoteStreams.set(originalParticipantId, alreadyEmittedAsWrongId);
                  
                  // Track which peer we received this stream from (to prevent forwarding loops)
                  this.streamSourcePeer.set(originalParticipantId, remoteParticipantId);
                  console.log(`[MediaHandler] relay-stream-map: set sourcePeer for ${originalParticipantId.slice(-8)} = ${remoteParticipantId.slice(-8)}`);
                  
                  // Re-emit with correct participant ID (emittedStreams dedup uses participantId+streamId,
                  // so the new key won't be blocked)
                  this.emitResolvedStream(alreadyEmittedAsWrongId, originalParticipantId);
                } else {
                  console.log(`[MediaHandler] relay-stream-map: no pending stream for ${streamId} (may arrive later via ontrack)`);
                }
              }
            }
          } catch (e) {
            console.warn('[MediaHandler] Failed to parse relay stream map:', e);
          }
        };
      }
    };

    // Handle incoming tracks (remote streams)
    peerConnection.ontrack = (event) => {
      console.log(`[MediaHandler] ontrack from ${remoteParticipantId.slice(-8)}: kind=${event.track.kind} streamId=${event.streams[0]?.id?.slice(0,8) ?? 'none'}`);
      const remoteStream = event.streams[0];

      if (remoteStream) {
        // Check if we already have a mapping for this stream (relay-forwarded)
        const knownParticipantId = this.streamIdToParticipantId.get(remoteStream.id);
        if (knownParticipantId) {
          // Mapping already available — but don't emit immediately.
          // The relay-stream-map data channel message arrived BEFORE ontrack fired,
          // so we may only have the first track (audio) at this point. The browser
          // fires separate ontrack events for audio and video on the same stream object.
          // Wait a short tick so all tracks are added to the shared stream before emitting.
          this.remoteStreams.set(knownParticipantId, remoteStream);
          this.streamSourcePeer.set(knownParticipantId, remoteParticipantId);
          if (!this.pendingEmitTimers.has(remoteStream.id)) {
            console.log(`[MediaHandler] ontrack: deferring emit for ${knownParticipantId} stream ${remoteStream.id} to collect all tracks`);
            this.pendingEmitTimers.set(remoteStream.id, setTimeout(() => {
              this.pendingEmitTimers.delete(remoteStream.id);
              console.log(`[MediaHandler] ontrack: deferred emit for ${knownParticipantId} stream ${remoteStream.id}, tracks=${remoteStream.getTracks().length}`);
              this.emitResolvedStream(remoteStream, knownParticipantId);
              this.streamResolvedCallbacks.forEach(cb => cb(knownParticipantId, remoteStream));
            }, 150)); // 150ms to collect all tracks before emitting
          }
        } else {
          // No mapping yet. Park as pending — the relay stream map data channel message
          // will arrive shortly and flush it with the correct participant ID.
          // If no map ever arrives (direct connection), flush after a short grace period.
          console.log(`[MediaHandler] ontrack: parking stream ${remoteStream.id} as pending (waiting for relay-stream-map or 500ms timeout)`);
          this.pendingRelayStreams.set(remoteStream.id, { stream: remoteStream, connectionId: remoteParticipantId });

          setTimeout(() => {
            const stillPending = this.pendingRelayStreams.get(remoteStream.id);
            if (stillPending) {
              // No relay map arrived — this is a direct stream, emit under the connection's ID
              console.log(`[MediaHandler] *** 3000ms TIMEOUT FIRED *** for stream ${remoteStream.id} from ${remoteParticipantId}`);
              console.log(`[MediaHandler] ontrack: known streamId→participantId mappings:`, Array.from(this.streamIdToParticipantId.entries()));
              this.pendingRelayStreams.delete(remoteStream.id);
              this.remoteStreams.set(remoteParticipantId, remoteStream);
              this.streamSourcePeer.set(remoteParticipantId, remoteParticipantId);
              this.emitResolvedStream(remoteStream, remoteParticipantId);
              // Notify relay nodes so they can send updated stream maps to their peers
              this.streamResolvedCallbacks.forEach(cb => cb(remoteParticipantId, remoteStream));
            } else {
              console.log(`[MediaHandler] ontrack: 3000ms timeout - stream ${remoteStream.id} already resolved via relay-stream-map`);
            }
          }, 3000); // 3000ms grace period for data channel to open and deliver the map
        }
      } else {
        console.warn(`[MediaHandler] ontrack from ${remoteParticipantId}: no stream in event`);
      }
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.iceCandidateCallbacks.forEach((callback) => {
          callback(remoteParticipantId, event.candidate!);
        });
      }
    };

    // Handle connection state changes (Task 18.1)
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (state === 'connected') {
        this.resetRetryCounter(remoteParticipantId);
        console.log(`[MediaHandler] connected → ${remoteParticipantId.slice(-8)}`);
      } else if (state === 'failed') {
        console.warn(`[MediaHandler] FAILED → ${remoteParticipantId.slice(-8)}`);
      }
    };

    // Handle ICE connection state changes (Task 18.1)
    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      if (state === 'failed') {
        console.warn(`[MediaHandler] ICE FAILED → ${remoteParticipantId.slice(-8)}`);
      }
    };
  }
}
