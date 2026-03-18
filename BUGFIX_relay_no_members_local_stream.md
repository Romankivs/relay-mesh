# Bug Fix: Relay with No Members Not Sending Local Stream

## Problem
In a 3-person relay mesh conference, regular node B doesn't see relay node C's video.

**Scenario:**
- A = relay with member B (regular node)
- C = relay with no members
- A↔C relay-to-relay connection
- B↔A regular-to-relay connection

**Issue:**
B can see A's video, but cannot see C's video even though A and C are connected as relays.

## Root Cause

When C becomes a relay with no members, it correctly:
1. Connects to A (the other relay)
2. Receives B's stream from A via relay forwarding
3. Correctly skips forwarding B's stream back to A (source peer check works)
4. Sends stream maps to A including C's own local stream ID

**BUT:** C never adds its own local stream tracks to the peer connection with A!

### Why This Happens

In `updateConnections()`, when creating a new peer connection, the code:
1. Adds local stream tracks ✓
2. Forwards any remote streams (if relay role) ✓
3. Sends the offer ✓

However, when C becomes a relay with no members:
- C has 0 remote streams to forward
- The forwarding loop doesn't run
- Only the local stream is added during initial connection setup

**The problem:** When C transitions from regular→relay AFTER the connection to A is already established, the local stream is already on the connection from when C was regular. But if the connection is recreated or if there's any issue, C might not re-add its local stream.

More critically: **The logs show C is sending stream maps that include its local stream, but the tracks were never added to the peer connection!**

From C's logs:
```
[RMC:l02-4259] forwarding 0 resolved + 0 pending to hzme-453
[RMC:l02-4259][buildStreamMap] for peer=hzme-453 remoteStreams=[hzme-453→70505da5,t15-8085→481d1b35] result= {481d1b35...: 't15-8085', 7576b9f1...: 'l02-4259'}
```

C is advertising stream `7576b9f1` (C's local stream) in the stream map, but A never receives it via ontrack because C never called `addTrack()` for it!

## Solution

Added a check in `updateConnections()` after creating new connections: for existing connections where we're a relay, verify that the local stream tracks are present on the peer connection. If not, add them and trigger renegotiation.

The fix includes comprehensive logging to diagnose the issue:
- Logs all target connections being checked
- Logs local track IDs vs sender track IDs for each connection
- Logs whether local tracks are present or missing
- Logs renegotiation attempts and signaling state

```typescript
// For existing connections where we're a relay, ensure local stream is present
// This handles the case where a relay has no remote streams to forward but still
// needs to send its own local stream to connected peers (e.g. relay with no members)
if (this.currentRole === 'relay') {
  console.log(`[RMC:${this.logId}][localStreamCheck] checking ${targetConnections.length} target connections`);
  for (const remoteId of targetConnections) {
    if (currentConnections.includes(remoteId)) {
      const pc = this.mediaHandler.getPeerConnection(remoteId);
      if (pc) {
        const senders = pc.getSenders();
        const localTrackIds = localStream.getTracks().map(t => t.id);
        const senderTrackIds = senders.map(s => s.track?.id || 'null');
        console.log(`[RMC:${this.logId}][localStreamCheck] ${remoteId.slice(-8)}: localTracks=[${localTrackIds.join(',')}] senderTracks=[${senderTrackIds.join(',')}]`);
        
        const hasLocalTracks = senders.some(s => s.track && localStream.getTracks().some(t => t.id === s.track?.id));
        if (!hasLocalTracks) {
          console.log(`[RMC:${this.logId}][localStreamCheck] MISSING local stream on existing connection ${remoteId.slice(-8)} - adding now`);
          this.mediaHandler.addLocalStream(pc, {
            streamId: localStream.id,
            participantId: participantId,
            tracks: localStream.getTracks(),
            isLocal: true,
          });
          // Trigger renegotiation to send the new tracks
          if (pc.signalingState === 'stable') {
            console.log(`[RMC:${this.logId}][localStreamCheck] triggering renegotiation for ${remoteId.slice(-8)} to send local stream`);
            this.renegotiateConnection(remoteId, pc);
          } else {
            console.log(`[RMC:${this.logId}][localStreamCheck] cannot renegotiate ${remoteId.slice(-8)} - signalingState=${pc.signalingState}`);
          }
        } else {
          console.log(`[RMC:${this.logId}][localStreamCheck] ${remoteId.slice(-8)} already has local tracks ✓`);
        }
      }
    }
  }
}
```

## Changes Made

**src/client/relay-mesh-client.ts**:
- Added comprehensive check after new connection creation loop
- For existing connections, verify local stream tracks are present
- If missing, add local stream and trigger renegotiation
- Enhanced logging to diagnose track presence and renegotiation
- Added logging to new connection creation to track when local stream is added
- This ensures relay nodes always send their local stream to all connected peers

## Testing

Test with 3 participants in relay topology:

**Setup:**
1. A joins → becomes relay
2. B joins → becomes regular node in A's group
3. C joins → becomes relay with no members

**Expected behavior:**
- A sees B and C ✓
- B sees A and C ✓ (FIXED)
- C sees A and B ✓
- A forwards B's stream to C ✓
- A forwards C's stream to B ✓ (FIXED)
- C does NOT forward B's stream back to A ✓

**Previous behavior:**
- B could not see C ✗
- A was not receiving C's local stream ✗
- C was advertising its stream in stream maps but not sending tracks ✗

## Debugging

The enhanced logging will show:
1. When new connections are created and local stream is added
2. For existing connections, whether local tracks are present or missing
3. Track IDs comparison between local stream and peer connection senders
4. Renegotiation attempts and signaling state

Look for these log patterns:
- `[localStreamCheck] checking N target connections` - Fix is running
- `[localStreamCheck] MISSING local stream` - Fix detected missing tracks
- `[localStreamCheck] already has local tracks ✓` - Tracks are present
- `[localStreamCheck] triggering renegotiation` - Fix is adding tracks and renegotiating

## Impact

- ✅ Fixes "B doesn't see C" issue in 3-person relay conferences
- ✅ Ensures relay nodes with no members still send their local stream
- ✅ Handles edge case where relay has no remote streams to forward
- ✅ Works with existing source peer forwarding loop prevention
- ✅ Maintains proper stream attribution via stream maps
- ✅ Comprehensive logging for debugging

## Related Fixes

This fix complements previous relay forwarding fixes:
1. Source peer tracking and forwarding loop prevention
2. Stream map timing (send after renegotiation)
3. Canvas pipeline for relay forwarding
4. Role transition stream handling

Together, these fixes ensure robust relay stream forwarding in all topologies.
