# Debug: Relay Stream Map Timing Issue

## Problem Statement
In a 3-person relay mesh conference, User B (regular node) doesn't see User C's video stream.

**Topology:**
- A = relay node (has member B)
- B = regular node (member of A's group)
- C = relay node (no members, connects to A via relay-to-relay)

**Expected Flow:**
1. C sends its local stream to A (relay-to-relay connection)
2. A receives C's stream via ontrack events
3. A forwards C's stream to B via canvas pipeline
4. B receives C's stream and displays it

**Actual Behavior:**
- B doesn't see C's video
- Logs show "no pending stream for 48fc8834" at some relay

## Root Cause Analysis

### Issue 1: Stream Map Timing (FIXED)
The relay was sending `relay-stream-map` messages immediately after calling `addTrack()`, but BEFORE the WebRTC renegotiation completed. This caused the stream map to arrive before ontrack events fired.

**Fix Applied:**
- Moved stream map sending from immediate callbacks to `handleWebRTCAnswer()` 
- Stream maps now sent AFTER answer is received (renegotiation complete)
- Also added stream map sending in `handleWebRTCOffer()` after answer is sent

### Issue 2: Forwarding Back to Source (NEW FIX)
When relay A receives a stream from relay C, A might try to forward that stream back to C if C is in the connectedPeers list. This creates unnecessary traffic and can cause issues.

**Example:**
- C forwards B's stream to A
- A receives B's stream (sourcePeer = C)
- A tries to forward B's stream to all connectedPeers, including C
- This sends B's stream back to C (wrong!)

**Fix:**
Added check in `forwardNewStreamToConnectedPeers()` and `streamResolved` callback to skip forwarding back to the peer we received the stream from:

```typescript
const sourcePeer = this.mediaHandler.getStreamSourcePeer(stream.participantId);
if (sourcePeer && peerId === sourcePeer) {
  console.log(`skipping source peer (received from this peer)`);
  continue;
}
```

Also added `getStreamSourcePeer()` getter method to MediaHandler to expose the streamSourcePeer map.

## Code Changes Made

### 1. Enhanced logging throughout relay-mesh-client.ts
- `handleWebRTCOffer`: Added detailed logging for offer processing
- `onNegotiationNeeded`: Added sender count and track types
- `onRemoteStream`: Added stream ID and forwarding decision logging
- `streamResolved`: Added detailed peer list and forwarding tracking
- `forwardNewStreamToConnectedPeers`: Added source peer tracking

### 2. Added stream map sending in handleWebRTCOffer
When A receives an offer and sends back an answer, A also sends its stream map.

### 3. Added getStreamSourcePeer() to MediaHandler
New getter method to expose which peer we received each stream from.

### 4. Added source peer check in forwarding logic
Both `forwardNewStreamToConnectedPeers()` and `streamResolved` callback now skip forwarding back to the peer we received the stream from.

## Testing Instructions

1. Start signaling server
2. Open 3 browser tabs
3. Join conference in order: A, B, C
4. Check console logs for each participant
5. Verify:
   - A receives C's stream (ontrack events)
   - A forwards C's stream to B (forwarding logs)
   - A does NOT forward C's stream back to C
   - B receives C's forwarded stream (ontrack events)
   - B receives stream map from A (relay-stream-map logs)
   - B displays C's video

## Expected Log Sequence

### At C (relay, no members):
```
[RMC:C][onRemoteStream] received stream from A streamId=[A's stream]
[RMC:C][streamResolved] A resolved, forwarding to 0 peers (no members)
```

### At A (relay with member B):
```
[RMC:A][handleWebRTCOffer] Received offer from C
[MediaHandler] ontrack from C: kind=audio streamId=[C's stream]
[MediaHandler] ontrack from C: kind=video streamId=[C's stream]
[RMC:A][onRemoteStream] received stream from C streamId=[C's stream] alreadyForwarded=false
[RMC:A][onRemoteStream] NEW stream from C, forwarding
[RMC:A][fwd] forwarding stream from C to peers=[B]
[RMC:A][fwd] sourcePeer for C is C (direct connection)
[RMC:A][fwd] → B signalingState=stable sendersBefore=[audio, video]
[MediaHandler] addRemoteStreamForRelay: CANVAS adding tracks
[RMC:A][negotiationNeeded] triggered for B
[RMC:A][renegotiate] offer sent to B
[RMC:A][handleWebRTCAnswer] received from B
[RMC:A][handleWebRTCAnswer] sending relay-stream-map to B: {[C's stream]: C}
```

### At B (regular node, member of A):
```
[MediaHandler] ontrack from A: kind=audio streamId=[forwarded]
[MediaHandler] ontrack from A: kind=video streamId=[forwarded]
[MediaHandler] ontrack: parking stream [forwarded] as pending
[MediaHandler] relay-stream-map from A: {[forwarded]: C}
[MediaHandler] relay-stream-map: flushing pending stream [forwarded] as C
[Event] remoteStream {participantId: C, stream: MediaStream}
```

## Next Steps

1. Test with the enhanced logging and fixes
2. Collect logs from all three participants
3. Verify the source peer check prevents forwarding loops
4. Confirm B receives and displays C's video
