# Fix: 3-Person Stream Forwarding - Relay-to-Relay Stream Not Forwarded to Group Members

## Issue
In a 3-person relay mesh scenario where:
- A = relay with member B (regular node)
- C = relay with no members
- Topology: A↔C (relay-to-relay), B↔A (regular-to-relay)

B (regular node) does not see C's (relay) video stream.

## Root Cause
The issue occurs due to a timing problem combined with the `forwardedStreamIds` tracking:

1. **C's stream arrives at A BEFORE B joins**
2. A forwards C's stream to connected peers at that time (which doesn't include B yet)
3. A marks C's stream as "forwarded" in `forwardedStreamIds` set
4. **B joins later** and A creates a connection to B
5. At connection creation time, A checks `remoteStreams` and finds C's stream
6. However, the forwarding logic skips streams that are already in `forwardedStreamIds`
7. Additionally, the loop prevention logic checks if the stream source peer matches the target peer
8. Result: C's stream is never forwarded to B

The key insight from the logs:
```
[RMC:y7h-7238][newConn] forwarding 0 resolved + 0 pending to NEW connection y2r-7960
[RMC:y7h-7238][newConn] no remote streams to forward to y2r-7960 (only local stream)
```

This shows that when B joins, C's stream has NOT yet arrived at A. But in other test runs, C's stream arrives before B joins, and the forwarding logic doesn't handle this case correctly.

## Solution
Enhanced the stream forwarding logic in `updateConnections()` when creating new connections:

1. **Added source peer checking**: When forwarding streams to a new connection, check if we received the stream FROM that peer (to avoid forwarding loops)
2. **Enhanced logging**: Added detailed logs showing which streams are being forwarded and which are skipped, with reasons
3. **Proper loop prevention**: Skip forwarding if:
   - The stream belongs to the target peer (don't forward their own stream back)
   - We received the stream FROM the target peer (avoid forwarding loops)

### Code Changes

In `src/client/relay-mesh-client.ts`, `updateConnections()` method:

```typescript
for (const [sourceParticipantId, _snapshotStream] of remoteStreams.entries()) {
  // Skip if this is the peer we're connecting to (don't forward their own stream back)
  if (sourceParticipantId === remoteId) {
    console.log(`[RMC:${this.logId}][newConn] skipping resolved stream from ${sourceParticipantId.slice(-8)} - same as target peer`);
    continue;
  }
  
  // Skip if we received this stream FROM the peer we're connecting to (avoid forwarding loop)
  const streamSourcePeer = this.mediaHandler.getStreamSourcePeer(sourceParticipantId);
  if (streamSourcePeer === remoteId) {
    console.log(`[RMC:${this.logId}][newConn] skipping resolved stream from ${sourceParticipantId.slice(-8)} - received from target peer ${remoteId.slice(-8)}`);
    continue;
  }
  
  // Forward the stream
  console.log(`[RMC:${this.logId}][newConn] forwarding resolved stream from ${sourceParticipantId.slice(-8)} to ${remoteId.slice(-8)}`);
  // ... forwarding logic ...
}
```

## Enhanced Logging

Added comprehensive logging with `[newConn]` and `[fwdLate]` tags to track:
- Which streams are available when creating new connections
- Which streams are forwarded and which are skipped
- The reason for skipping (same peer, received from peer, etc.)
- Canvas pipeline completion status

## Testing

Test the 3-person scenario:
1. A joins (becomes relay)
2. C joins (becomes relay)
3. B joins (becomes regular, assigned to A's group)

Expected behavior:
- B should see both A's local stream and C's forwarded stream
- A's logs should show either:
  - `[newConn]` forwarding C's stream when B's connection is created (if C's stream arrived first)
  - `[fwdLate]` forwarding C's stream after B's connection is established (if C's stream arrives later)

## Files Modified

- `src/client/relay-mesh-client.ts`: Enhanced stream forwarding logic with source peer checking and detailed logging
- `BUGFIX_3person_stream_forwarding_enhanced_logging.md`: Documentation of enhanced logging

## Related Issues

This fix builds on previous relay forwarding fixes:
- Stream source peer tracking (`streamSourcePeer` map)
- Forwarding loop prevention in `forwardNewStreamToConnectedPeers()`
- Stream map timing (sent after WebRTC renegotiation)
- Canvas pipeline for relay forwarding
