# Bug Fix: WebRTC Signaling Implementation

## Issue
Remote audio streams were not being received despite peer connections being established. The audio capture and local metering worked perfectly, and peer connections were created, but the `remoteStream` event never fired.

## Root Cause
The WebRTC signaling flow (offer/answer/ICE candidate exchange) was not implemented. The code was creating `RTCPeerConnection` objects but never:
1. Adding local media tracks to the connections
2. Creating and exchanging SDP offers/answers
3. Exchanging ICE candidates

Additionally, the P2P connection logic was incorrect - when there were no relay nodes, participants were only connecting to one "hub" participant instead of creating a full mesh where everyone connects to everyone.

This meant that while peer connection objects existed, no actual media negotiation occurred, so no tracks were ever sent or received.

## Changes Made

### 1. MediaHandler (`src/client/media-handler.ts`)
- Added `ICECandidateCallback` type for ICE candidate events
- Added `iceCandidateCallbacks` array to store ICE candidate handlers
- Added `onICECandidate()` method to register ICE candidate callbacks
- Updated `setupPeerConnectionHandlers()` to:
  - Handle `onicecandidate` events and notify callbacks
  - Add enhanced logging for track reception and connection states

### 2. RelayMeshClient (`src/client/relay-mesh-client.ts`)
- Updated `setupEventHandlers()` to register WebRTC signaling handlers:
  - `onWebRTCOffer()` - handles incoming offers
  - `onWebRTCAnswer()` - handles incoming answers
  - `onICECandidate()` - handles incoming ICE candidates
- Added `handleWebRTCOffer()` method:
  - Creates/gets peer connection
  - Adds local stream if not already added
  - Sets remote description (offer)
  - Creates and sends answer
- Added `handleWebRTCAnswer()` method:
  - Gets existing peer connection
  - Sets remote description (answer)
- Added `handleICECandidate()` method:
  - Gets existing peer connection
  - Adds ICE candidate
- Updated `joinConference()` to register ICE candidate handler
- Updated `updateConnections()` to:
  - Check for local stream before proceeding
  - Add local stream to new peer connections
  - Create and send WebRTC offers for new connections
- Updated `getTargetConnections()` to handle P2P mode:
  - When `relayNodes.length === 0`, create full mesh connections
  - All participants in a P2P group connect to each other
  - Fixes star topology issue where only one participant was the hub

## WebRTC Flow

### Connection Initiator (Offerer)
1. Create peer connection
2. Add local media tracks
3. Create offer
4. Set local description (offer)
5. Send offer via signaling
6. Receive answer via signaling
7. Set remote description (answer)
8. Exchange ICE candidates
9. Connection established → `ontrack` fires → remote stream received

### Connection Responder (Answerer)
1. Receive offer via signaling
2. Create peer connection
3. Add local media tracks
4. Set remote description (offer)
5. Create answer
6. Set local description (answer)
7. Send answer via signaling
8. Exchange ICE candidates
9. Connection established → `ontrack` fires → remote stream received

## Testing
1. Open two browser windows with simple-client
2. Both join the same conference
3. Verify console logs show:
   - "Creating WebRTC offer for: participant-xxx"
   - "Sent WebRTC offer to: participant-xxx"
   - "Received WebRTC offer from: participant-xxx"
   - "Sent WebRTC answer to: participant-xxx"
   - "Received WebRTC answer from: participant-xxx"
   - "Generated ICE candidate for participant-xxx"
   - "Received ICE candidate from: participant-xxx"
   - "Added ICE candidate from: participant-xxx"
   - "[MediaHandler] Received track from participant-xxx: audio"
   - "[MediaHandler] Emitting remoteStream event for participant-xxx"
   - "Received remote stream: xxx"
4. Verify remote audio is heard in both windows

## Version
- Updated to v1.1.3
- Bundle cache version: v=18

## Related Files
- `src/client/media-handler.ts`
- `src/client/relay-mesh-client.ts`
- `examples/simple-client/index.html`
- `dist/browser/relay-mesh.esm.js`
