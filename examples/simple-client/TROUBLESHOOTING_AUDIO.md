# Troubleshooting: Audio Level Works in Test but Not in Simple Client

## Issue

The audio level indicator works in `audio-test.html` but not in the main `simple-client/index.html` page.

## Common Causes

### 1. Audio Context Suspended State

**Problem:** Browser autoplay policies may suspend the audio context until user interaction.

**Check:**
```javascript
// In browser console after joining
console.log('Audio context state:', audioContext?.state);
// Should be "running", not "suspended"
```

**Solution:** Click the mute button to trigger audio context resume, or the context will auto-resume when created.

### 2. Different Stream Object

**Problem:** The stream from `client.getLocalStream()` might be a different object than expected.

**Check:**
```javascript
// In browser console after joining
const stream = client.getLocalStream();
console.log('Stream:', stream);
console.log('Stream ID:', stream?.id);
console.log('Stream active:', stream?.active);
console.log('Audio tracks:', stream?.getAudioTracks());
```

**Expected:**
- Stream should exist (not null)
- Stream should be active (true)
- Should have at least 1 audio track

### 3. Audio Track Disabled or Muted

**Problem:** The audio track might be disabled or muted.

**Check:**
```javascript
// In browser console after joining
const stream = client.getLocalStream();
const track = stream?.getAudioTracks()[0];
console.log('Track enabled:', track?.enabled);
console.log('Track muted:', track?.muted);
console.log('Track readyState:', track?.readyState);
```

**Expected:**
- enabled: true
- muted: false
- readyState: "live"

### 4. Analyser Not Connected

**Problem:** The audio analyser might not be properly connected to the stream.

**Check:**
```javascript
// In browser console after joining
console.log('Audio context:', audioContext);
console.log('Local analyser:', localAnalyser);
console.log('Context state:', audioContext?.state);
```

**Expected:**
- audioContext should exist
- localAnalyser should exist
- state should be "running"

## Debugging Steps

### Step 1: Check Console Logs

After joining the conference, look for these logs:

```
✅ Expected logs:
[timestamp] Getting local stream...
[timestamp] Local stream ID: xxx, active: true
[timestamp] Local media: 1 audio, 1 video tracks
[timestamp] Audio track: xxx, enabled: true, muted: false
[timestamp] Setting up audio analyser...
[timestamp] Audio context created, state: running
[timestamp] Audio monitoring started
[Audio Level] RMS: 0.0234, Percentage: 7.0%, Context: running
```

```
❌ Problem indicators:
[timestamp] Warning: No local stream available
[timestamp] No audio tracks in stream
[timestamp] Audio context created, state: suspended
[timestamp] Audio monitoring failed: xxx
```

### Step 2: Manual Audio Context Resume

If the audio context is suspended, manually resume it:

```javascript
// In browser console
if (audioContext && audioContext.state === 'suspended') {
  audioContext.resume().then(() => {
    console.log('Audio context resumed:', audioContext.state);
  });
}
```

### Step 3: Verify Stream Source

Check if the stream source is properly created:

```javascript
// In browser console
const stream = client.getLocalStream();
if (stream) {
  try {
    const testContext = new AudioContext();
    const testSource = testContext.createMediaStreamSource(stream);
    console.log('✅ Stream source created successfully');
    testContext.close();
  } catch (error) {
    console.error('❌ Failed to create stream source:', error);
  }
}
```

### Step 4: Check for Multiple Audio Contexts

Multiple audio contexts can cause issues:

```javascript
// In browser console
console.log('Audio context instances:', 
  document.querySelectorAll('*').length // rough estimate
);

// Close and recreate if needed
if (audioContext) {
  audioContext.close();
  audioContext = null;
}
```

### Step 5: Test with Simple Stream

Create a test to verify the analyser works with the actual stream:

```javascript
// In browser console after joining
const stream = client.getLocalStream();
if (stream) {
  const testContext = new AudioContext();
  const testAnalyser = testContext.createAnalyser();
  const testSource = testContext.createMediaStreamSource(stream);
  testSource.connect(testAnalyser);
  
  const dataArray = new Uint8Array(testAnalyser.fftSize);
  
  function test() {
    testAnalyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const normalized = (dataArray[i] - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    console.log('Test RMS:', rms.toFixed(4));
    
    setTimeout(test, 1000);
  }
  
  test();
}
```

## Solutions

### Solution 1: Force Audio Context Resume

Add this after joining:

```javascript
// After setupAudioAnalyser is called
if (audioContext && audioContext.state === 'suspended') {
  await audioContext.resume();
  log('Audio context resumed', 'success');
}
```

### Solution 2: Delay Audio Setup

Sometimes the stream needs a moment to stabilize:

```javascript
// After getting local stream
if (localStream && audioTracks.length > 0) {
  setTimeout(() => {
    setupAudioAnalyser(localStream);
    elements.muteBtn.disabled = false;
  }, 500); // Wait 500ms
}
```

### Solution 3: User Interaction Trigger

Add a button to manually start audio monitoring:

```html
<button id="startAudioBtn">Start Audio Monitoring</button>
```

```javascript
elements.startAudioBtn.addEventListener('click', () => {
  if (localStream) {
    setupAudioAnalyser(localStream);
    if (audioContext) {
      audioContext.resume();
    }
  }
});
```

### Solution 4: Check Stream Before Setup

Verify the stream is valid before setting up analyser:

```javascript
if (localStream) {
  const audioTracks = localStream.getAudioTracks();
  
  if (audioTracks.length > 0 && 
      audioTracks[0].enabled && 
      audioTracks[0].readyState === 'live') {
    setupAudioAnalyser(localStream);
  } else {
    log('Audio track not ready, retrying...', 'warning');
    setTimeout(() => {
      if (localStream) setupAudioAnalyser(localStream);
    }, 1000);
  }
}
```

## Quick Fix Checklist

Try these in order:

1. ✅ Hard refresh the page (Ctrl+Shift+R or Cmd+Shift+R)
2. ✅ Check browser console for errors
3. ✅ Click the mute button after joining (triggers audio context resume)
4. ✅ Verify microphone permissions are granted
5. ✅ Try in a different browser
6. ✅ Check if audio-test.html still works
7. ✅ Clear browser cache and reload
8. ✅ Restart the signaling server
9. ✅ Rebuild the browser bundle: `npm run build:browser`

## Comparison: Test vs Simple Client

### audio-test.html (Works)
- Direct stream from getUserMedia
- Audio context created immediately
- No other components interfering
- Simple, isolated environment

### simple-client (May Not Work)
- Stream from RelayMeshClient
- Audio context created after join
- Multiple components (signaling, metrics, etc.)
- More complex environment
- Browser autoplay policies may apply

## Browser-Specific Issues

### Chrome/Edge
- Usually works without issues
- May need user interaction for audio context

### Firefox
- May require explicit audio context resume
- Check about:config for media.autoplay settings

### Safari
- Strict autoplay policy
- Always requires user interaction
- May need to click mute button first

## Still Not Working?

If none of the above helps:

1. **Capture debug info:**
   ```javascript
   const debugInfo = {
     stream: client.getLocalStream(),
     streamActive: client.getLocalStream()?.active,
     audioTracks: client.getLocalStream()?.getAudioTracks().length,
     trackEnabled: client.getLocalStream()?.getAudioTracks()[0]?.enabled,
     trackMuted: client.getLocalStream()?.getAudioTracks()[0]?.muted,
     trackState: client.getLocalStream()?.getAudioTracks()[0]?.readyState,
     contextState: audioContext?.state,
     analyserExists: !!localAnalyser,
     clientState: client.getCurrentState()
   };
   console.log('Debug info:', JSON.stringify(debugInfo, null, 2));
   ```

2. **Compare with working test:**
   - Open audio-test.html
   - Open simple-client in another tab
   - Compare console logs
   - Look for differences

3. **Check for conflicts:**
   - Disable browser extensions
   - Try incognito/private mode
   - Check for other tabs using microphone

4. **Report the issue:**
   - Include browser version
   - Include debug info from step 1
   - Include console logs
   - Include steps to reproduce

## Expected Behavior

When working correctly, you should see:

1. **In Event Log:**
   - "Getting local stream..."
   - "Local stream ID: xxx, active: true"
   - "Audio track: xxx, enabled: true, muted: false"
   - "Setting up audio analyser..."
   - "Audio context created, state: running"
   - "Audio monitoring started"

2. **In Browser Console:**
   - "[Audio Level] RMS: 0.0234, Percentage: 7.0%, Context: running"
   - Logs appear every second
   - RMS values change when speaking

3. **Visual Feedback:**
   - Green bar appears in audio level indicator
   - Bar moves when speaking
   - Bar shows 5-30% for normal speech
   - Bar responds smoothly to voice

## Success Criteria

✅ Audio level indicator shows green bar  
✅ Bar moves when speaking  
✅ Console shows RMS values  
✅ Audio context state is "running"  
✅ No errors in console  
✅ Mute button works  
✅ Remote audio plays correctly  

If all criteria are met, the audio features are working correctly!
