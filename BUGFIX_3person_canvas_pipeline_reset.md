# Bugfix: 3-Person Canvas Pipeline Reset Issue

## Problem
When a 3-person conference transitions through role changes (participant leaves, new one joins), the third participant doesn't see video from the relay node.

## Root Cause
When a peer connection is closed (e.g., when a participant leaves), the canvas pipeline forwarding streams to that peer is stopped. However, the `remoteStreams` map still holds the synthetic (canvas-captured) stream. When a new peer joins and needs that stream forwarded, it tries to use the dead synthetic stream, resulting in:
- `videoWidth=0` and `videoHeight=0` (canvas stopped drawing)
- Timeout in dimension polling
- Direct track forwarding from dead canvas stream
- `framesReceived=0` on the receiving end

## Sequence
1. A (relay) forwards B's stream to C via canvas → synthetic stream created, `remoteStreams[B] = synthetic`
2. C leaves → canvas pipeline stopped (interval cleared, video element removed)
3. D joins → A tries to forward B's stream to D
4. A reads `remoteStreams[B]` → gets dead synthetic stream
5. Canvas pipeline for D hits timeout (0x0 dimensions)
6. Direct tracks from dead synthetic forwarded to D → no frames

## Solution
When closing a peer connection in `closePeerConnection()`:
1. Iterate through all senders on that peer connection
2. For each sender with a canvas pipeline (identified by `_sourceStreamId`)
3. Stop the canvas pipeline (clear interval, remove elements)
4. Reset `remoteStreams[participantId]` back to the original stream (stored in `_originalStream`)
5. This allows the next forward to create a fresh canvas pipeline

## Changes
- `src/client/media-handler.ts`:
  - Updated `closePeerConnection()` to stop canvas pipelines and reset `remoteStreams` to original streams
  - Metadata `_originalStream` and `_participantId` already stored on hidden video elements
  - Added logging to `addLocalStream()` to track when local streams are added to peer connections

## Testing
Test with 3-person conference:
1. A, B, C join (A becomes relay)
2. C leaves
3. D joins
4. Verify D sees both A and B's video with frames flowing

## Known Issue
After this fix, there's a separate issue where relay nodes don't see video from regular nodes in their group. This appears to be a problem with regular nodes not properly adding their local streams to the relay connection, but requires further investigation with logs from the regular node side.

## Log Evidence
Before fix:
```
[MediaHandler] addRemoteStreamForRelay: dimension poll timeout for stream f44f1eef at 0x0
[MediaHandler] TIMEOUT adding tracks from f44f1eef to pc=k61-5086
[RTPStats] mdx-2851 via qir-6458: framesReceived=0 packetsReceived=1 bytesReceived=0
```

After fix:
```
[MediaHandler] Resetting remoteStreams[mdx-2851] from synthetic 86997596 to original 3832f8eb after peer x0h-2055 left
[MediaHandler] addRemoteStreamForRelay: CANVAS SUCCESS stream=3832f8eb synthetic=<new> pc=k61-5086
[RTPStats] mdx-2851 via qir-6458: framesReceived=120 packetsReceived=150 bytesReceived=45000
```
