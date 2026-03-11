# Bug Fix: 3-Person Conference Issues

## Problem 1: Infinite Reconnection Loop
In a 3-person conference, the relay node enters an infinite loop of recreating connections, causing constant disconnections and reconnections.

### Root Cause
When a relay node receives a remote stream, it triggers `updateConnections()` to recreate all peer connections with stream forwarding enabled. However, this creates a feedback loop where the relay treats every stream reception (including re-reception of the same stream after reconnection) as a new stream requiring connection recreation.

### Solution
Added stream tracking to prevent reconnection loops:
- Added `forwardedStreamIds` Set to track seen streams
- Modified `onRemoteStream` handler to check for new streams before triggering reconnection
- Clear tracking set on role change and conference leave

## Problem 2: User 1 Can't See Others (addTrack Error)
User 1 (first participant, becomes relay) cannot see other participants. Error in console:

```
InvalidAccessError: Failed to execute 'addTrack' on 'RTCPeerConnection': A sender already exists for the track.
```

### Root Cause
When recreating peer connections to add stream forwarding, the code attempts to add tracks that are already being sent on the peer connection. WebRTC doesn't allow adding the same track multiple times to the same peer connection.

This happens because:
1. User 1 connects to User 2 (adds local stream tracks)
2. User 3 joins, topology changes
3. Code tries to recreate connection to User 2 with forwarding
4. Attempts to add local stream tracks again → ERROR
5. Connection creation fails, User 1 never establishes proper connections

### Solution
Modified `addLocalStream` and `addRemoteStreamForRelay` methods to check if tracks are already added before calling `addTrack()`:

```typescript
// Check if this track is already being sent on this peer connection
const senders = peerConnection.getSenders();
const trackAlreadyAdded = senders.some(sender => sender.track === track);

if (!trackAlreadyAdded) {
  peerConnection.addTrack(track, stream);
}
```

## Changes Made
- `src/client/relay-mesh-client.ts`:
  - Added `forwardedStreamIds` property to track seen streams
  - Modified `onRemoteStream` handler to check for new streams before triggering reconnection
  - Clear tracking set on role change and conference leave

- `src/client/media-handler.ts`:
  - Modified `addLocalStream()` to check if tracks already exist before adding
  - Modified `addRemoteStreamForRelay()` to check if tracks already exist before adding

## Testing
Test with 3 participants:
1. Join participant 1 (becomes relay)
2. Join participant 2 (becomes relay)
3. Join participant 3 (assigned to a relay group)

Expected behavior:
- All connections establish successfully
- No "sender already exists" errors
- No infinite reconnection loops
- All participants can see/hear each other
- Logs show "Relay received new stream" only once per actual new stream

## Impact
- Fixes infinite reconnection loop in 3+ person conferences
- Fixes User 1 not seeing other participants
- Improves connection stability for relay nodes
- Reduces unnecessary WebRTC renegotiations
- No impact on 2-person conferences (no relay nodes)
