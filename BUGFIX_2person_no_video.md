# Bug Fix: 2-Person Conference - Participants Can't See Each Other

## Problem
In a 2-person conference, both participants join successfully but they cannot see or hear each other. The video elements are created but remain black/empty.

## Symptoms
- Both participants show as connected (participant count: 2)
- Both participants are assigned relay role
- WebRTC connections establish successfully (ICE connected)
- Remote stream events are received
- Video elements are created in the DOM
- But no actual video/audio is transmitted

## Root Cause
The relay selection algorithm was incorrectly calculating that 2 relays are needed for a 2-person conference:

```typescript
calculateOptimalRelayCount(participantCount: number): number {
  return Math.ceil(Math.sqrt(participantCount));
}
```

For 2 participants: `Math.ceil(Math.sqrt(2))` = `Math.ceil(1.414...)` = `2`

This caused both participants to become relays, creating an incorrect topology where:
- Both participants are relays with empty groups
- Each relay tries to forward streams to the other relay
- But there's no clear relay-to-regular node relationship
- The forwarding logic gets confused about what to forward where

## Correct Topology for 2 People
With 2 participants, the correct topology is:
- 1 relay node
- 1 regular node connected to that relay
- Direct P2P-style connection through the relay

This is simpler and more efficient than having both be relays.

## Solution
Added a special case for small participant counts in the relay selection algorithm:

```typescript
calculateOptimalRelayCount(participantCount: number): number {
  // Special case: with 2 participants, only 1 relay is needed
  // (one relay, one regular node connected to it)
  if (participantCount <= 2) {
    return 1;
  }
  
  return Math.ceil(Math.sqrt(participantCount));
}
```

Now with 2 participants:
- Algorithm selects 1 relay (the participant with better metrics)
- The other participant becomes a regular node
- Regular node connects directly to the relay
- Relay forwards the regular node's stream back to them
- Both can see and hear each other

## Changes Made
- `src/client/selection-algorithm.ts`:
  - Modified `calculateOptimalRelayCount()` to return 1 for 2 or fewer participants
  - Added comment explaining the special case

## Testing
Test with 2 participants:
1. Join participant 1 (becomes relay)
2. Join participant 2 (becomes regular node)

Expected behavior:
- Participant 1 is assigned relay role
- Participant 2 is assigned regular role
- Both participants can see and hear each other
- Video elements show actual video feeds
- Audio is transmitted bidirectionally
- Topology shows 1 relay with 1 regular node in its group

## Impact
- Fixes 2-person conferences (the most common use case!)
- More efficient topology for small conferences
- No impact on 3+ person conferences (sqrt formula still applies)
- Maintains proper relay forwarding behavior across all scenarios


## Additional Issue: Relay Forwarding Stream Back to Source

After fixing the relay count, another issue was discovered: the relay was trying to forward a participant's stream back to that same participant.

### Problem
In a 2-person conference (1 relay + 1 regular node):
- Regular node sends stream to relay
- Relay receives the stream
- Relay logic detects "I have a group member, so I should forward streams"
- Relay recreates connection to forward the stream
- But it's forwarding the regular node's stream BACK to the regular node!
- This causes the connection to be constantly recreated

### Root Cause
The forwarding logic was checking if there are group members OR other relays, but not checking if there are enough peers to actually need forwarding. In a 2-person conference, there's only 1 peer (the source of the stream), so there's nowhere else to forward to.

### Solution
Added a check to ensure there are multiple peers before enabling forwarding:

```typescript
// Count total peers (group members + other relays)
const totalPeers = (myGroup?.regularNodeIds.length || 0) + (this.currentTopology.relayNodes.length - 1);

// Only recreate if we have multiple peers (need at least 2: one source, one destination)
// In a 2-person conference (1 relay + 1 regular), totalPeers = 1, so don't forward
// In a 3-person conference (1 relay + 2 regulars OR 2 relays + 1 regular), totalPeers >= 2, so forward
if (totalPeers > 1 && (hasGroupMembers || hasOtherRelays)) {
  // Recreate connections with forwarding
}
```

Now:
- 2-person conference: totalPeers = 1, no forwarding needed, connections stay stable
- 3-person conference: totalPeers >= 2, forwarding enabled, streams forwarded to other participants

## Final Changes Made
- `src/client/selection-algorithm.ts`:
  - Modified `calculateOptimalRelayCount()` to return 1 for 2 or fewer participants
  
- `src/client/relay-mesh-client.ts`:
  - Added `totalPeers` calculation to check if forwarding is actually needed
  - Only recreate connections for forwarding when `totalPeers > 1`
