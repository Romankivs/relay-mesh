# Bug Fix: 2-Person Conference - Role Transition Connection Issue

## Problem
In a 2-person conference, when relay selection re-evaluates and switches roles between participants, the connections are not properly recreated, causing participants to not see each other.

## Scenario
1. User 1 joins first → becomes relay (default selection)
2. User 2 joins → initially becomes regular node, connects to User 1
3. Relay selection re-evaluates based on metrics
4. User 2 has better metrics → becomes the new relay
5. User 1 should become regular node and connect to User 2
6. **Problem**: Connections are not properly recreated after role transition
7. Result: User 1 doesn't see User 2 (or vice versa)

## Root Cause
When a participant's role changes (relay ↔ regular), the topology changes but existing peer connections are not closed. This causes issues because:

1. **Relay → Regular transition**: The node was connected to other relays, but now should only connect to its assigned relay. Old connections to other relays remain open.

2. **Regular → Relay transition**: The node was connected to one relay, but now should connect to all other relays and its group members. The old connection might not be properly updated.

3. **Connection state mismatch**: The `updateConnections()` method compares target connections with current connections, but if the role changed, the current connections are based on the OLD topology, not the new one.

## Solution
When a role change is detected, close ALL existing peer connections before calling `updateConnections()`. This ensures:

1. All old connections are properly cleaned up
2. New connections are created based on the new topology
3. No stale connections remain that could interfere with the new topology

### Implementation

Added connection cleanup in both places where role changes are detected:

1. **In `handleTopologyUpdate()`** (when receiving topology update from server):
```typescript
if (oldRole !== newRole) {
  // ... existing role change handling ...
  
  // CRITICAL: Close ALL existing connections
  if (this.mediaHandler) {
    console.log('[RelayMeshClient] Role changed - closing all connections to recreate with new topology');
    const currentConnections = this.mediaHandler.getActiveConnections();
    for (const remoteId of currentConnections) {
      this.mediaHandler.closePeerConnection(remoteId);
    }
  }
}
```

2. **In `evaluateTopologyInternal()`** (when broadcasting new topology as leader):
```typescript
if (oldRole !== newRole) {
  // ... existing role change handling ...
  
  // CRITICAL: Close ALL existing connections
  if (this.mediaHandler) {
    console.log('[RelayMeshClient] Role changed - closing all connections to recreate with new topology');
    const currentConnections = this.mediaHandler.getActiveConnections();
    for (const remoteId of currentConnections) {
      this.mediaHandler.closePeerConnection(remoteId);
    }
  }
}
```

### Why This Works

1. **Clean slate**: Closing all connections ensures we start fresh with the new topology
2. **Correct target connections**: `updateConnections()` will calculate the correct target connections based on the new role
3. **Proper signaling**: New WebRTC offers will be created and sent to the correct peers
4. **No interference**: Old connections won't interfere with new connection establishment

## Changes Made

### `src/client/relay-mesh-client.ts`

1. Added connection cleanup in `handleTopologyUpdate()` role change handler (line ~535)
2. Added connection cleanup in `evaluateTopologyInternal()` role change handler (line ~770)

Both changes ensure that when a role transition occurs, all existing connections are closed before `updateConnections()` recreates them with the correct topology.

### `examples/simple-client/index.html`

Added `roleChange` event handler to clear the client-side stream processing cache:

```javascript
client.on('roleChange', (role) => {
  // Clear processed streams cache
  processedStreams.clear();
  
  // Clear all remote video and audio elements
  remoteVideoElements.clear();
  remoteAudioElements.clear();
  
  // This allows streams to be re-processed after role transition
  // Even though they have the same stream IDs
});
```

**Why this is needed**: When connections are recreated after a role change, the same MediaStream objects are received again (with the same stream IDs). Without clearing the cache, the client thinks these are duplicate streams and ignores them, resulting in no video/audio display.

## Testing

Test with 2 participants where relay selection changes:

1. User 1 joins first (becomes relay)
2. User 2 joins with better metrics (initially regular, then becomes relay)
3. Verify role change occurs (check console logs)
4. Verify connections are closed and recreated (check console logs)
5. Verify both users can see and hear each other after role transition

Expected console logs:
```
[RelayMeshClient] Role changed from relay to regular
[RelayMeshClient] Role changed - closing all connections to recreate with new topology
[RelayMeshClient] updateConnections called
[RelayMeshClient] Creating peer connection to: [new-relay-id]
```

## Impact

- Fixes 2-person conferences where relay selection changes after initial join
- Ensures role transitions work correctly in all conference sizes
- Prevents stale connections from interfering with new topology
- Maintains proper relay forwarding behavior after role changes

## Related Issues

This fix complements the previous fixes:
- `BUGFIX_2person_no_video.md`: Fixed relay count calculation (1 relay for 2 people)
- `BUGFIX_relay_stream_forwarding.md`: Fixed relay forwarding logic (no forwarding when totalPeers <= 1)
- `TROUBLESHOOTING_2PERSON_CONNECTION.md`: Fixed Perfect Negotiation collisions

Together, these fixes ensure 2-person conferences work correctly in all scenarios.
