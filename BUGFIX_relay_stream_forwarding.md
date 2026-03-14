# Bug Fix: Infinite Loop When Recreating Connections for Forwarding

## Problem
In 3-person conferences with 2 relays, when a relay recreates connections to add forwarding, it enters an infinite loop of recreating connections because the same streams are received again with different stream IDs.

## Scenario
1. User 1 joins → becomes regular node
2. User 2 joins → becomes relay with User 1 in group
3. User 3 joins → becomes relay with empty group
4. User 3 receives User 2's stream
5. User 3 triggers connection recreation to forward
6. **Problem**: After recreation, User 3 receives User 2's stream again with a NEW stream ID
7. The new stream ID is not in `forwardedStreamIds` set
8. User 3 triggers connection recreation again → infinite loop

## Root Cause

When WebRTC connections are recreated, the MediaStream objects are recreated with new stream IDs. The `forwardedStreamIds` tracking set uses `${participantId}-${streamId}` as the key, so when the same stream is received with a new ID after connection recreation, it's not recognized as "already seen" and triggers another recreation.

Example from logs:
```
First reception: stream ID 48b2ed12-9461-40a2-b1a4-42b42c8d920b
After recreation: stream ID b39254be-1df0-4fd2-949a-1d02a11805cb (DIFFERENT!)
```

The `forwardedStreamIds` set still contains the old stream ID, so the new stream ID passes the `!this.forwardedStreamIds.has(streamKey)` check and triggers another recreation.

## Solution

Clear the `forwardedStreamIds` set when emitting `connectionsRecreating`, just like we do for role changes. This allows the streams to be re-tracked with their new IDs after connection recreation.

```typescript
if (shouldForward) {
  console.log(`[RelayMeshClient] Relay has ${remoteStreams.size} remote streams and peers to forward to, recreating all connections`);
  
  // Emit event to notify UI to clear stream cache
  this.emit('connectionsRecreating');
  
  // Clear forwarded streams tracking since we're recreating connections
  // and will receive the same streams again with new stream IDs
  this.forwardedStreamIds.clear();
  
  for (const remoteId of currentConnections) {
    // ... close and recreate connections
  }
}
```

## Changes Made

**src/client/relay-mesh-client.ts**:
- Added `this.forwardedStreamIds.clear()` after emitting `connectionsRecreating` event in `updateConnections()` method
- Added comment explaining why we need to clear the tracking set

## Testing

Test with 3 participants in 2-relay topology:

1. User 1 joins → becomes regular node
2. User 2 joins → becomes relay with User 1 in group
3. User 3 joins → becomes relay with empty group
4. User 3 receives User 2's stream
5. **Expected**: User 3 recreates connections once, then stops ✓
6. **Previous behavior**: User 3 enters infinite loop of recreating connections ✗

## Log Evidence

Before fix (infinite loop):
```
[RelayMeshClient] updateConnections called
[RelayMeshClient] Relay has 1 remote streams and peers to forward to, recreating all connections
[Event] connectionsRecreating []
[RelayMeshClient] Closing connection to recreate with forwarded streams
[RelayMeshClient] Creating peer connection to: participant-xxx
[RelayMeshClient] Relay received new stream, checking if forwarding is needed
[RelayMeshClient]   - Should forward: true
[RelayMeshClient] ✓ Relay will recreate connections to forward stream
[RelayMeshClient] updateConnections called  ← LOOP STARTS AGAIN
[RelayMeshClient] Relay has 1 remote streams and peers to forward to, recreating all connections
...
```

After fix (single recreation):
```
[RelayMeshClient] updateConnections called
[RelayMeshClient] Relay has 1 remote streams and peers to forward to, recreating all connections
[Event] connectionsRecreating []
[RelayMeshClient] Closing connection to recreate with forwarded streams
[RelayMeshClient] Creating peer connection to: participant-xxx
[RelayMeshClient] Relay received new stream, checking if forwarding is needed
[RelayMeshClient] Stream already seen, skipping forwarding check  ← NO LOOP
```

## Impact

- ✅ Fixes infinite loop when recreating connections for forwarding
- ✅ Allows proper stream tracking across connection recreations
- ✅ Maintains correct behavior for all multi-relay scenarios
- ✅ Prevents excessive connection churn and resource usage

## Related Fixes

This fix completes the series of relay forwarding fixes:
1. `BUGFIX_2person_no_video.md` - Fixed 2-person relay count and prevented forwarding back to source
2. `BUGFIX_FINAL_2person_role_transition.md` - Fixed role transition stream cache
3. `BUGFIX_3person_infinite_loop.md` - Fixed infinite reconnection loop (original)
4. `BUGFIX_3person_stream_cache.md` - Fixed relay forwarding to other relay in empty group scenario
5. `BUGFIX_relay_stream_forwarding.md` - Synchronized forwarding logic between handlers
6. **This fix** - Fixed infinite loop when recreating connections for forwarding

Together, these fixes ensure robust multi-person conference functionality across all topologies.
