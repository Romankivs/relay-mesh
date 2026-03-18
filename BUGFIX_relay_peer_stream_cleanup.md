# Bugfix: Relay Peer Stream Cleanup Issue

## Problem
When a relay node leaves a 3-person conference, streams that were forwarded through that relay remain in `remoteStreams` but are now dead (no frames). When the topology reorganizes, these dead streams prevent new streams from being received and displayed.

## Scenario
1. A, B, C join → B becomes relay
2. B forwards C's stream to A via canvas → A receives stream `363bec5d` for C
3. B leaves
4. A becomes relay, C becomes relay
5. A should receive C's direct stream, but A still has C's old forwarded stream from B
6. A's video element for C shows black screen (dead stream from B's canvas)

## Root Cause
`remoteStreams` map doesn't track which peer connection each stream came from. When a peer connection is closed:
- The peer's own stream is removed via `removeRemoteStream(peerId)`
- But streams forwarded through that peer remain in `remoteStreams`
- These forwarded streams are now dead (canvas pipelines stopped)
- New streams for the same participants can't replace them

## Solution
Track the source peer connection for each stream in `remoteStreams`:
1. Add `streamSourcePeer` map: `participantId → peerId` (which PC the stream came from)
2. Update `streamSourcePeer` when setting `remoteStreams` (in canvas pipeline and ontrack)
3. In `closePeerConnection`, remove all streams where `streamSourcePeer[participantId] === peerId`
4. This clears forwarded streams when the relay peer leaves

## Changes
- `src/client/media-handler.ts`:
  - Added `streamSourcePeer: Map<string, string>` to track stream sources
  - Updated canvas pipeline to set `streamSourcePeer` when creating synthetic streams
  - Updated ontrack handler to set `streamSourcePeer` when receiving streams
  - Updated `closePeerConnection` to remove streams received through that peer

## Testing
Test with 3-person conference where relay changes:
1. A, B, C join (B becomes relay)
2. B forwards C's stream to A
3. B leaves
4. Verify A receives C's new direct stream and displays it correctly

## Log Evidence
Before fix:
```
[RMC:i04-2578] participant left: mpr-4648
[MediaHandler] removeRemoteStream: cleaned up participant mpr-4648
// C's stream 363bec5d remains in remoteStreams but is dead
[Remote Stream] Using nativeStream for participant-...hd3-2854
// Video element shows black screen
```

After fix:
```
[RMC:i04-2578] participant left: mpr-4648
[MediaHandler] Removing 1 streams received through peer mpr-4648: [hd3-2854]
// C's old stream removed, new stream can be received
[MediaHandler] emitResolvedStream: hd3-2854 stream=<new>
// Video element shows live video
```
