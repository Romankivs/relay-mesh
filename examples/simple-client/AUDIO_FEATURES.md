# Audio Features in Simple Client

This document describes the audio transmission and playback features implemented in the RelayMesh simple client.

## Features Overview

### 1. Real-time Audio Transmission
- Captures audio from your microphone using WebRTC's `getUserMedia` API
- Transmits audio to all participants in the conference through peer connections
- Supports both direct P2P and relay-based transmission

### 2. Audio Level Monitoring
- Visual indicator showing your microphone input level in real-time
- Uses Web Audio API's `AnalyserNode` for frequency analysis
- Green bar that responds to your voice amplitude
- Updates at 60fps for smooth visualization

### 3. Mute/Unmute Controls
- Toggle button to mute/unmute your microphone
- Visual feedback (button changes color when muted)
- Disables audio tracks without disconnecting from the conference
- Preserves bandwidth by stopping audio transmission when muted

### 4. Remote Audio Playback
- Automatically plays audio from all remote participants
- Individual HTML5 audio controls for each participant
- Volume control for each remote stream
- Displays participant ID for easy identification

## Technical Implementation

### Audio Capture
```javascript
// Audio is captured when joining the conference
const stream = await navigator.mediaDevices.getUserMedia({ 
  audio: true, 
  video: true 
});
```

### Audio Level Monitoring
```javascript
// Web Audio API analyzes frequency data
const audioContext = new AudioContext();
const analyser = audioContext.createAnalyser();
analyser.fftSize = 256;

// Updates visual indicator based on audio amplitude
const dataArray = new Uint8Array(analyser.frequencyBinCount);
analyser.getByteFrequencyData(dataArray);
const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
```

### Mute/Unmute
```javascript
// Disables audio tracks without closing connections
audioTracks.forEach(track => {
  track.enabled = !isMuted;
});
```

### Remote Audio Playback
```javascript
// Creates HTML5 audio element for each remote stream
const audio = document.createElement('audio');
audio.srcObject = remoteStream;
audio.autoplay = true;
audio.controls = true;
```

## User Interface

### Audio Controls Section
Located below the join/leave buttons:
- **Mute Button**: Toggle microphone on/off
- **Audio Level Indicator**: Visual bar showing your audio input level

### Remote Audio Streams Section
Located below the video grid:
- Shows all active remote audio streams
- Each stream has:
  - Participant ID label
  - HTML5 audio controls (play/pause, volume, timeline)
  - Default volume set to 80%

## Browser Compatibility

Audio features require:
- WebRTC support (`getUserMedia`, `RTCPeerConnection`)
- Web Audio API support (`AudioContext`, `AnalyserNode`)
- HTML5 audio element support

Supported browsers:
- Chrome 74+
- Firefox 66+
- Safari 12.1+
- Edge 79+

## Troubleshooting

### No audio level indicator
- Check if microphone permissions are granted
- Verify Web Audio API is supported in your browser
- Look for errors in browser console

### Can't hear remote participants
- Check if audio elements appear in "Remote Audio Streams" section
- Verify audio controls are not muted
- Check system volume settings
- Ensure remote participants have their microphones enabled

### Mute button not working
- Verify you have joined the conference
- Check if local stream has audio tracks
- Look for errors in browser console

### Audio quality issues
- Check network connection quality
- Verify sufficient bandwidth is available
- Try reducing number of participants
- Check if relay nodes are being used efficiently

## Performance Considerations

### CPU Usage
- Audio level monitoring uses minimal CPU (~1-2%)
- Runs at 60fps using `requestAnimationFrame`
- Automatically stops when disconnected

### Bandwidth Usage
- Audio typically uses 32-64 kbps per connection
- Muting stops audio transmission, saving bandwidth
- Relay nodes help reduce bandwidth for large conferences

### Memory Usage
- Each remote audio element uses ~1-2 MB
- Audio contexts are properly cleaned up on disconnect
- No memory leaks from audio processing

## Future Enhancements

Potential improvements for audio features:
- Noise suppression and echo cancellation controls
- Audio quality settings (bitrate, sample rate)
- Speaker selection for audio output
- Audio recording and playback
- Spatial audio for better participant positioning
- Voice activity detection (VAD)
- Automatic gain control (AGC)
