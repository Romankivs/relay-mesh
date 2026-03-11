# Bug Fix: Relay Stream Forwarding in 3+ Person Conferences

## Issue
In conferences with 2+ participants, relay nodes were not properly forwarding remote streams to other participants. This caused participants to not see/hear each other even though peer connections were established.

## Root Cause
Relay nodes were only sending their own local media streams to connected peers. When a relay node received a remote stream from another participant, it did not forward that stream to other connected peers. 

Additionally, when new streams arrived at a relay node after connections were already established, those streams were not added to existing connections.

## Solution
Implemented stream forwarding in relay nodes with connection recreation:

### 1. Track Remote Streams (media-handler.ts)
- Added `remoteStreams` map to store received remote streams
- Store streams when they arrive via `ontrack` event
- Added `getRemoteStreams()` method to retrieve all remote streams
- Added `addRemoteStreamForRelay()` method to add remote stream tracks to peer connections
- Added `getConnectedPeers()` and `getPeerConnection()` helper methods

### 2. Forward Streams on Connection Creation (relay-mesh-client.ts)
When a relay node creates a new peer connection:
- Add local stream (existing behavior)
- Add all remote streams except the one from the target peer (new behavior)
- This ensures new connections immediately receive all available streams

### 3. Recreate Connections When New Streams Arrive (relay-mesh-client.ts)
When a relay node receives a new remote stream:
- Detect if we're a relay with existing connections
- Trigger connection recreation after a short delay (500ms)
- Close all existing connections
- Recreate them with all streams (local + all remote streams)
- This ensures existing peers receive the new stream

### 4. Connection Recreation Logic (relay-mesh-client.ts)
In `updateConnections()`:
- If we're a relay node with remote streams, close ALL current connections
- Recreate them from scratch with all streams included
- This avoids complex renegotiation issues and ensures consistency

## Why Connection Recreation Instead of Renegotiation?
WebRTC renegotiation (adding tracks to existing connections) is complex and error-prone:
- Requires perfect negotiation pattern to avoid collisions
- Both peers might try to renegotiate simultaneously
- State management is tricky (have-local-offer vs stable states)
- Can cause "Ignoring answer - not in have-local-offer state" errors

Connection recreation is simpler and more reliable:
- Clean slate for each connection
- No state management issues
- All streams are added before the offer is created
- Works consistently across all scenarios

## Files Modified
- `src/client/media-handler.ts`: Added remote stream tracking and forwarding methods
- `src/client/relay-mesh-client.ts`: Added stream forwarding logic and connection recreation for relay nodes

## Testing
After rebuilding the browser bundle, test with 2+ participants:
1. Open multiple browser tabs with the simple client
2. Join the same conference
3. Verify all participants can see/hear each other
4. Check console logs for "Relay has X remote streams, recreating all connections" messages
5. Verify connections are recreated when new participants join

## Technical Details
- Relay nodes forward streams by adding tracks from remote MediaStreams to peer connections
- Connection recreation happens automatically when a relay receives a new stream
- A 500ms delay ensures the stream is fully received before recreation
- The relay maintains end-to-end encryption (tracks are forwarded without decryption)
- Each peer connection carries the local stream + all forwarded remote streams
