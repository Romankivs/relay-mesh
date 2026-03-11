# Troubleshooting: 2-Person Conference Connection Issues

## Problem
After implementing stream forwarding logic for 3+ person conferences, 2-person conferences stopped working. Participants could join but couldn't see each other's video.

## Symptoms
- Both participants join successfully
- Topology is formed correctly (2 relays with empty groups)
- Peer connections are created
- WebRTC offers/answers are exchanged
- ICE candidates are generated and exchanged
- Remote tracks ARE received (audio + video)
- Video elements ARE created and added to DOM
- Local videos play successfully
- BUT: Remote videos do NOT play
- Connection state gets stuck in "connecting" - never reaches "connected"
- ICE connection state gets stuck in "checking" - never reaches "connected"

## Root Cause
**Perfect Negotiation Collision**: Both relays try to create offers simultaneously, causing a signaling collision:

1. Both peers create offers and send them at the same time
2. The "impolite" peer (with lower ID) ignores the incoming offer due to collision
3. The "polite" peer (with higher ID) receives the offer but is in "have-local-offer" state
4. The polite peer's answer gets ignored because the impolite peer is no longer in the right state
5. The WebRTC connection never completes - stays in "connecting" state

Log evidence:
```
[RelayMeshClient] Impolite peer ignoring offer due to collision
[RelayMeshClient] Ignoring answer - not in have-local-offer state (current: stable)
```

## Solution
Implemented proper Perfect Negotiation pattern with rollback:

### 1. Added `makingOffer` tracking
- Track when we're in the process of creating an offer for each peer
- Keep the flag true until negotiation completes (answer received) or collision is handled
- This prevents race conditions where the flag is cleared too early

### 2. Improved collision detection
- Detect collision if either:
  - Signaling state is not "stable" (already have a local offer pending)
  - OR `makingOffer` flag is true (we're in the process of creating an offer)
- This catches collisions even if the timing is very close

### 3. Added rollback for polite peer
When the polite peer receives an offer while having a local offer pending:
```typescript
if (polite && offerCollision) {
  console.log('[RelayMeshClient] Polite peer rolling back local offer due to collision');
  await peerConnection.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
  this.makingOffer.set(message.from, false); // Clear the flag after rollback
}
```

This allows the polite peer to:
- Rollback its local offer
- Clear the makingOffer flag
- Accept the remote offer
- Send an answer
- Complete the negotiation successfully

### 4. Clear makingOffer flag at the right times
- Clear on error during offer creation
- Clear when polite peer rolls back
- Clear when answer is received successfully
- Do NOT clear immediately after sending offer (keep it true until negotiation completes)

## Changes Made

### `src/client/relay-mesh-client.ts`

1. Added `makingOffer` property:
```typescript
private makingOffer: Map<string, boolean> = new Map();
```

2. Updated offer creation to track state (keep flag true until negotiation completes):
```typescript
this.makingOffer.set(remoteId, true);
try {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  this.signalingClient.sendWebRTCOffer(remoteId, offer);
} catch (error) {
  this.makingOffer.set(remoteId, false); // Only clear on error
}
// Note: flag is cleared when answer is received or collision is handled
```

3. Improved collision detection in `handleWebRTCOffer`:
```typescript
const offerCollision = peerConnection.signalingState !== 'stable' || this.makingOffer.get(message.from);
```

4. Added rollback for polite peer with flag clearing:
```typescript
if (polite && offerCollision) {
  await peerConnection.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
  this.makingOffer.set(message.from, false); // Clear after rollback
}
```

5. Clear flag in `handleWebRTCAnswer`:
```typescript
this.makingOffer.set(message.from, false);
```

## Testing
Test with 2 participants:
1. Both join conference
2. Both should see each other's video
3. Check console logs for:
   - "Polite peer rolling back local offer due to collision" (from one peer)
   - "Impolite peer ignoring offer due to collision" (from other peer)
   - "Connection state: connected" (from both peers)
   - "ICE connection state: connected" (from both peers)

## References
- [MDN: Perfect Negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
- [WebRTC Signaling State Machine](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/signalingState)
