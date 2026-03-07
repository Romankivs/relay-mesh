# Quick Start: Testing Audio Features

This guide will help you quickly test the audio transmission and playback features.

## 5-Minute Test

### Step 1: Build and Start (2 minutes)

```bash
# Terminal 1: Build the browser bundle
npm run build:browser

# Terminal 2: Start signaling server
cd examples/server
node server.js

# Terminal 3: Serve the client
npx http-server . -p 3000
```

### Step 2: Open Two Browser Windows (1 minute)

1. Open http://localhost:3000/examples/simple-client/ in Chrome
2. Open the same URL in another Chrome window (or tab)
3. Position windows side-by-side

### Step 3: Join Conference (1 minute)

**Window 1:**
- Name: "Alice"
- Conference ID: "test-audio"
- Click "Join Conference"
- Allow microphone permissions

**Window 2:**
- Name: "Bob"  
- Conference ID: "test-audio"
- Click "Join Conference"
- Allow microphone permissions

### Step 4: Test Audio (1 minute)

**In Window 1 (Alice):**
- Speak into your microphone
- Watch the green audio level bar respond
- You should see your own audio level indicator moving

**In Window 2 (Bob):**
- You should see "Remote Audio Streams" section appear
- You should see an audio control labeled with Alice's participant ID
- You should HEAR Alice's voice through your speakers
- The audio control should show a waveform/timeline

**Test Mute:**
- In Window 1: Click "Mute" button
- In Window 2: Audio should stop
- In Window 1: Click "Unmute" button
- In Window 2: Audio should resume

## What You Should See

### Window 1 (Alice's View)
```
Status:
- State: CONNECTED
- Role: REGULAR (or RELAY)
- Participant ID: [long ID]
- Participants: 2

Audio Controls:
- [🎤 Mute] button (green)
- Your Audio: [====    ] (green bar moving)

Remote Audio Streams:
- 🔊 [Bob's ID]... [audio controls]
```

### Window 2 (Bob's View)
```
Status:
- State: CONNECTED
- Role: REGULAR (or RELAY)
- Participant ID: [long ID]
- Participants: 2

Audio Controls:
- [🎤 Mute] button (green)
- Your Audio: [====    ] (green bar moving)

Remote Audio Streams:
- 🔊 [Alice's ID]... [audio controls]
```

## Troubleshooting Quick Fixes

### "No audio from remote participant"

**Check 1: Audio Element**
- Look for audio controls in "Remote Audio Streams" section
- If missing, check browser console for errors

**Check 2: Browser Audio**
- Ensure browser tab is not muted (check tab icon)
- Check system volume is not muted
- Try clicking play on the audio control

**Check 3: Microphone**
- Verify remote participant's audio level bar is moving
- Verify remote participant is not muted
- Try speaking louder

### "Audio level bar not moving"

**Check 1: Microphone Permissions**
- Look for microphone icon in browser address bar
- Click and ensure "Allow" is selected
- Reload page if you just granted permissions

**Check 2: Microphone Selection**
- Check if correct microphone is selected in system settings
- Try unplugging and replugging microphone
- Try a different microphone

**Check 3: Browser Support**
- Ensure you're using Chrome 74+, Firefox 66+, Safari 12.1+, or Edge 79+
- Try a different browser
- Check browser console for errors

### "Can't join conference"

**Check 1: Server Running**
```bash
# Should see: "Signaling server listening on port 8080"
cd examples/server
node server.js
```

**Check 2: Browser Bundle Built**
```bash
# Should create dist/browser/relay-mesh.esm.js
npm run build:browser
ls -la dist/browser/
```

**Check 3: Correct URL**
- Ensure using http://localhost:3000/examples/simple-client/
- Not http://localhost:3000/examples/simple-client/index.html
- Not http://localhost:8080 (that's the signaling server)

## Advanced Testing

### Test with 3+ Participants

Open 3 or more browser windows and join the same conference. You should:
- See N-1 remote audio streams in each window
- Hear audio from all participants simultaneously
- Be able to control volume for each participant independently

### Test Relay Behavior

With 3+ participants, one may become a RELAY:
- Watch the "Role" field in Status section
- RELAY nodes forward audio from other participants
- Audio quality should remain good even through relays

### Test Network Resilience

1. Join conference with 2 participants
2. Open browser DevTools → Network tab
3. Throttle to "Slow 3G"
4. Verify audio continues (may have slight delay)
5. Reset to "No throttling"
6. Verify audio quality improves

## Performance Monitoring

### Check CPU Usage

**Chrome:**
1. Shift+Esc to open Task Manager
2. Find your tab
3. CPU should be < 5% when idle
4. CPU may spike to 10-15% when speaking

**Firefox:**
1. about:performance
2. Find your tab
3. Should show low CPU usage

### Check Memory Usage

**Chrome Task Manager:**
- Memory should be 50-100 MB per tab
- Should not increase significantly over time
- Leaving and rejoining should not leak memory

## Next Steps

Once basic audio is working:

1. Read [AUDIO_FEATURES.md](./AUDIO_FEATURES.md) for technical details
2. Review [TESTING_CHECKLIST.md](./TESTING_CHECKLIST.md) for comprehensive tests
3. Check [README.md](./README.md) for full documentation
4. Explore the code in [index.html](./index.html) to understand implementation

## Getting Help

If you encounter issues:

1. Check browser console for errors (F12 → Console)
2. Check signaling server logs in terminal
3. Review the troubleshooting section in README.md
4. Check if your browser/OS is supported
5. Try with a different browser or device

## Success Criteria

You've successfully tested audio features when:

✅ Audio level bar responds to your voice  
✅ Remote participants appear in "Remote Audio Streams"  
✅ You can hear remote participants' audio  
✅ Mute/unmute works correctly  
✅ Multiple participants can communicate simultaneously  
✅ Audio continues working for several minutes  
✅ No errors in browser console  

Congratulations! The audio features are working correctly. 🎉
