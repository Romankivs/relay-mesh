# Bug Fix: Prevent Relay Forwarding Loops

## Problem
In relay mesh conferences, relays were forwarding streams back to the peer they received them from, creating unnecessary traffic and preventing proper stream distribution.

**Scenario:**
- A = relay with member B (regular node)
- C = relay with no members
- C↔A relay-to-relay connection

**Issue:**
1. A forwards B's stream to C (correct)
2. C receives B's stream from A via relay-stream-map
3. C tries to forward B's stream back to A (WRONG!)
4. This prevents proper stream distribution and causes "no pending stream" warnings

**Result:** B doesn't see C's video because A is receiving duplicate stream maps from C instead of C's local stream.

## Root Cause

The `streamSourcePeer` map tracks which peer we received each stream from, but it was only being set in the `ontrack` handler when the stream map arrived BEFORE ontrack. When the stream map arrived AFTER ontrack (via the relay-stream-map data channel), the `streamSourcePeer` was never set.

**Code flow:**
1. C receives B's stream from A via ontrack
2. Stream is parked as pending (no map yet)
3. Stream map arrives: `{streamId: 'iu8-4166'}`
4. Pending stream is flushed and emitted
5. **BUG:** `streamSourcePeer` is NOT set, so C doesn't know B's stream came from A
6. C's forwarding logic checks `sourcePeer` and finds it's `undefined`
7. C forwards B's stream back to A (creating a loop)

**Log evidence from C:**
```
[MediaHandler] relay-stream-map: flushing pending stream 4c99d715 as iu8-4166
[RMC:h3b-3094][fwd] sourcePeer for iu8-4166 is unknown  ← BUG!
[RMC:h3b-3094][fwd] forwarding stream from iu8-4166 to peers=[xlt-7496]  ← WRONG!
```

## Solution

### 1. Set streamSourcePeer when flushing pending streams
When the relay-stream-map data channel message flushes a pending stream, also set the `streamSourcePeer` to track where we received it from:

```typescript
// Flush pending stream
this.remoteStreams.set(originalParticipantId, pending.stream);

// Track which peer we received this stream from (to prevent forwarding loops)
this.streamSourcePeer.set(originalParticipantId, remoteParticipantId);
console.log(`[MediaHandler] relay-stream-map: set sourcePeer for ${originalParticipantId} = ${remoteParticipantId}`);
```

### 2. Set streamSourcePeer when re-attributing streams
When a stream was already emitted under the wrong ID (3000ms timeout fired), also set the source peer:

```typescript
this.remoteStreams.set(originalParticipantId, alreadyEmittedAsWrongId);

// Track which peer we received this stream from
this.streamSourcePeer.set(originalParticipantId, remoteParticipantId);
```

### 3. Added getStreamSourcePeer() to MediaHandler
New getter method to expose which peer we received each stream from:

```typescript
getStreamSourcePeer(participantId: string): string | undefined {
  return this.streamSourcePeer.get(participantId);
}
```

### 4. Added source peer check in forwarding logic
Both `forwardNewStreamToConnectedPeers()` and `streamResolved` callback now skip forwarding back to the source peer:

```typescript
const sourcePeer = this.mediaHandler.getStreamSourcePeer(stream.participantId);
if (sourcePeer && peerId === sourcePeer) {
  console.log(`skipping source peer (received from this peer)`);
  continue;
}
```

### 5. Enhanced logging throughout
Added comprehensive logging to track:
- Which peer we received each stream from
- Forwarding decisions (skip source peer, skip stream owner)
- Stream resolution and forwarding triggers
- Negotiation state and sender counts

## Changes Made

**src/client/media-handler.ts**:
- Added `streamSourcePeer.set()` when flushing pending streams in relay-stream-map handler
- Added `streamSourcePeer.set()` when re-attributing already-emitted streams
- Added `getStreamSourcePeer()` getter method
- Added logging for source peer tracking

**src/client/relay-mesh-client.ts**:
- Added source peer check in `forwardNewStreamToConnectedPeers()`
- Added source peer check in `streamResolved` callback
- Enhanced logging in `onRemoteStream` callback
- Enhanced logging in `streamResolved` callback
- Enhanced logging in `onNegotiationNeeded` callback
- Enhanced logging in `handleWebRTCOffer`
- Added stream map sending in `handleWebRTCOffer()` after answer

## Testing

Test with 3 participants in relay topology:

**Setup:**
1. A joins → becomes relay
2. B joins → becomes regular node in A's group
3. C joins → becomes relay with no members

**Expected behavior:**
- A forwards B's stream to C ✓
- C does NOT forward B's stream back to A ✓
- A forwards C's stream to B ✓
- C does NOT forward A's stream back to A ✓
- B sees both A and C's videos ✓
- C sees both A and B's videos ✓

**Previous behavior:**
- C forwards B's stream back to A ✗
- Causes duplicate streams and "no pending stream" warnings ✗
- B doesn't see C's video ✗

## Log Evidence

**With fix (C's logs):**
```
[MediaHandler] relay-stream-map: flushing pending stream 4c99d715 as iu8-4166
[MediaHandler] relay-stream-map: set sourcePeer for iu8-4166 = xlt-7496
[RMC:h3b-3094][fwd] sourcePeer for iu8-4166 is xlt-7496
[RMC:h3b-3094][fwd] skipping source peer xlt-7496 (received from this peer)
```

**Without fix (C's logs):**
```
[MediaHandler] relay-stream-map: flushing pending stream 4c99d715 as iu8-4166
[RMC:h3b-3094][fwd] sourcePeer for iu8-4166 is unknown
[RMC:h3b-3094][fwd] forwarding stream from iu8-4166 to peers=[xlt-7496]  ← WRONG!
[MediaHandler] addRemoteStreamForRelay: CANVAS adding tracks to xlt-7496
```

## Impact

- ✅ Prevents forwarding loops where streams are sent back to their source
- ✅ Fixes "B doesn't see C" issue in 3-person relay conferences
- ✅ Reduces unnecessary WebRTC renegotiations
- ✅ Fixes "no pending stream" warnings caused by duplicate stream maps
- ✅ Improves relay mesh efficiency and stability
- ✅ Ensures proper stream attribution in multi-relay scenarios

## Related Fixes

This fix builds on previous relay forwarding fixes:
1. Stream map timing fix (send after renegotiation completes)
2. Canvas pipeline deduplication
3. Role transition stream cache clearing
4. Infinite loop prevention on connection recreation

Together, these fixes ensure robust relay stream forwarding in all topologies.
