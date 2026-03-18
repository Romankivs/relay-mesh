# Analysis: 3-Person Missing Relay Stream

## Observed Issue
User C joins a conference with existing relays A and B. C only sees A's video, not B's video.

## Log Analysis (C's perspective)

**Participants:**
- A = nwy-7555 (relay)
- B = b7e-4276 (relay)  
- C = e18-6367 (regular, joins last)

**Topology:**
```
relays=nwy-7555,b7e-4276
groups=[{"r":"nwy-7555","m":["e18-6367"]},{"r":"b7e-4276","m":[]}]
```

C is in A's group, B has no group members.

**What C receives:**
1. C connects to A (its relay) ✓
2. C receives A's stream `8b7df049` ✓
3. C creates video element for A ✓
4. C never receives B's stream ✗

**Expected behavior:**
A should forward B's stream to C via canvas pipeline, so C sees both A and B.

## Root Cause Hypothesis

A doesn't forward B's stream to C because:

1. **Timing issue**: When C joins and A creates PC to C, A hasn't received B's stream yet
   - A and B should connect (relay-to-relay) and exchange camera streams
   - But this might happen AFTER C joins
   - When B's stream later arrives at A, A should forward it to C
   - The `forwardNewStreamToConnectedPeers` should handle this

2. **Connection issue**: A and B never connect
   - `getTargetConnections` for relay A should return `[B, C]`
   - But maybe A's `updateConnections` doesn't run after B joins?
   - Or A connects to B but doesn't receive B's stream?

3. **Forwarding condition**: A receives B's stream but doesn't forward it
   - `shouldForward` condition might be false
   - Or `forwardedStreamIds` already has B, so forwarding is skipped

## Required Information

To diagnose further, need A's logs showing:
- Does A connect to B? (`creating PC to b7e-4276`)
- Does A receive B's stream? (`remoteStream from=b7e-4276`)
- Does A forward B's stream to C? (`forwarding stream from b7e-4276 to peers=[e18-6367]`)

## Potential Fixes

1. **Ensure relay-to-relay connections happen early**: When a new relay joins, immediately connect to existing relays before group members join

2. **Trigger forwarding when new peer connects**: When C joins and A creates PC to C, check if A has any streams that should be forwarded to C and forward them immediately

3. **Add defensive check**: In `updateConnections`, after creating PC to a new group member, iterate through all `remoteStreams` and forward any that aren't already forwarded to that peer

## Next Steps

1. Get A's logs to confirm which hypothesis is correct
2. Add more diagnostic logging to track relay-to-relay connection timing
3. Implement fix based on root cause
