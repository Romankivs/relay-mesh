# Audio Flow Diagram

This document illustrates how audio flows through the RelayMesh simple client.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Simple Client                             │
│                                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Microphone  │───▶│ Audio Capture│───▶│   WebRTC     │      │
│  │   (Input)    │    │  getUserMedia│    │ Transmission │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
│                                                   │              │
│  ┌──────────────┐    ┌──────────────┐           │              │
│  │ Audio Level  │◀───│ Web Audio API│◀──────────┘              │
│  │  Indicator   │    │   Analyser   │                           │
│  └──────────────┘    └──────────────┘                           │
│                                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Speakers   │◀───│ HTML5 Audio  │◀───│   WebRTC     │      │
│  │   (Output)   │    │   Element    │    │   Reception  │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Detailed Audio Capture Flow

```
User Clicks "Join Conference"
         │
         ▼
┌─────────────────────────────────────────┐
│ navigator.mediaDevices.getUserMedia()   │
│ { audio: true, video: true }            │
└────────────────┬────────────────────────┘
                 │
                 ▼
         ┌───────────────┐
         │ MediaStream   │
         │ - Audio Track │
         │ - Video Track │
         └───────┬───────┘
                 │
         ┌───────┴────────┐
         │                │
         ▼                ▼
┌─────────────────┐  ┌──────────────────┐
│ setupAudioAnalyser│  │ Add to Peer     │
│ - Create Context  │  │ Connections     │
│ - Create Analyser │  │ - Send to Peers │
│ - Monitor Levels  │  │ - Via WebRTC    │
└─────────────────┘  └──────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│ Update Audio Level Indicator    │
│ - Get frequency data            │
│ - Calculate average amplitude   │
│ - Update green bar width        │
│ - Loop at 60fps                 │
└─────────────────────────────────┘
```

## Detailed Audio Playback Flow

```
Remote Peer Sends Audio
         │
         ▼
┌─────────────────────────────────────────┐
│ WebRTC Peer Connection                  │
│ - Receives remote MediaStream           │
│ - Triggers 'remoteStream' event         │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Event Handler: client.on('remoteStream')│
│ - Check for audio tracks                │
│ - Check for video tracks                │
└────────────────┬────────────────────────┘
                 │
                 ▼
         Has Audio Tracks?
                 │
         ┌───────┴────────┐
         │ Yes            │ No
         ▼                ▼
┌──────────────────┐  ┌────────────┐
│ addRemoteAudio   │  │ Skip Audio │
│ Element()        │  │ Setup      │
└────────┬─────────┘  └────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Create HTML5 Audio Element              │
│ - Set srcObject = stream                │
│ - Set autoplay = true                   │
│ - Set controls = true                   │
│ - Set volume = 0.8                      │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Add to DOM                              │
│ - Create container div                  │
│ - Add participant ID label              │
│ - Add audio element                     │
│ - Append to remoteAudioStreams          │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Audio Plays Automatically               │
│ - Browser autoplay policy               │
│ - User can control volume               │
│ - User can pause/play                   │
└─────────────────────────────────────────┘
```

## Mute/Unmute Flow

```
User Clicks "Mute" Button
         │
         ▼
┌─────────────────────────────────────────┐
│ muteBtn Click Handler                   │
│ - Toggle isMuted flag                   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Get Audio Tracks from Local Stream      │
│ localStream.getAudioTracks()            │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Set Track Enabled State                 │
│ track.enabled = !isMuted                │
│ - true: Audio transmitted               │
│ - false: Audio NOT transmitted          │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Update UI                               │
│ - Change button text                    │
│ - Change button color                   │
│ - Log action                            │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Effect on Remote Peers                  │
│ - Muted: No audio received              │
│ - Unmuted: Audio received               │
│ - No reconnection needed                │
└─────────────────────────────────────────┘
```

## Participant Leave Flow

```
Participant Leaves Conference
         │
         ▼
┌─────────────────────────────────────────┐
│ Signaling Server Notifies               │
│ - Sends 'participantLeft' message       │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Event Handler: client.on('participantLeft')│
│ - Receives participant ID               │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ removeRemoteAudioElement(participantId) │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Cleanup Audio Element                   │
│ - Set audio.srcObject = null            │
│ - Remove container from DOM             │
│ - Delete from remoteAudioElements Map   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Update UI                               │
│ - Audio element removed                 │
│ - Participant count updated             │
│ - Log participant left                  │
└─────────────────────────────────────────┘
```

## Conference Leave Flow

```
User Clicks "Leave Conference"
         │
         ▼
┌─────────────────────────────────────────┐
│ leaveBtn Click Handler                  │
│ - Call client.leaveConference()         │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Cleanup Audio Context                   │
│ - audioContext.close()                  │
│ - audioContext = null                   │
│ - localAnalyser = null                  │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Clear All Audio Elements                │
│ - remoteAudioStreams.innerHTML = ''     │
│ - remoteAudioElements.clear()           │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Reset Audio Controls                    │
│ - Disable mute button                   │
│ - Reset button text                     │
│ - Reset audio level bar                 │
│ - isMuted = false                       │
│ - localStream = null                    │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Update UI                               │
│ - Reset status fields                   │
│ - Enable join button                    │
│ - Log leave action                      │
└─────────────────────────────────────────┘
```

## Multi-Participant Audio Flow

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│ Participant │         │ Participant │         │ Participant │
│      A      │         │      B      │         │      C      │
└──────┬──────┘         └──────┬──────┘         └──────┬──────┘
       │                       │                       │
       │ Audio Stream          │ Audio Stream          │ Audio Stream
       │                       │                       │
       ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    Signaling Server                          │
│  - Coordinates peer connections                             │
│  - Manages topology (relay vs direct)                       │
└────────────┬────────────────────────┬────────────────────┬──┘
             │                        │                    │
             ▼                        ▼                    ▼
    ┌────────────────┐      ┌────────────────┐   ┌────────────────┐
    │ Peer Connection│      │ Peer Connection│   │ Peer Connection│
    │   A ←→ B       │      │   B ←→ C       │   │   A ←→ C       │
    └────────────────┘      └────────────────┘   └────────────────┘

Direct P2P Mode (< 5 participants):
- Each participant connects to every other participant
- Audio sent directly peer-to-peer
- Low latency, high bandwidth usage

Relay Mode (≥ 5 participants):
- Some participants become relay nodes
- Audio forwarded through relay nodes
- Higher latency, lower bandwidth usage
```

## Audio Level Monitoring Flow

```
┌─────────────────────────────────────────┐
│ setupAudioAnalyser(stream)              │
│ - Called after joining conference       │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Create Audio Context                    │
│ audioContext = new AudioContext()       │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Create Media Stream Source              │
│ source = audioContext.createMediaStreamSource(stream)│
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Create Analyser Node                    │
│ analyser = audioContext.createAnalyser()│
│ analyser.fftSize = 256                  │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Connect Source to Analyser              │
│ source.connect(analyser)                │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Start Animation Loop (60fps)            │
└────────────────┬────────────────────────┘
                 │
                 ▼
         ┌───────────────┐
         │ updateAudioLevel()│
         └───────┬───────┘
                 │
         ┌───────┴────────┐
         │                │
         ▼                │
┌─────────────────────────┴───────────────┐
│ Get Frequency Data                      │
│ analyser.getByteFrequencyData(dataArray)│
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Calculate Average Amplitude             │
│ average = sum(dataArray) / length       │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Convert to Percentage                   │
│ percentage = (average / 128) * 100      │
│ percentage = min(100, percentage)       │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│ Update Visual Indicator                 │
│ localAudioLevel.style.width = percentage│
└────────────────┬────────────────────────┘
                 │
                 ▼
         ┌───────────────┐
         │ Still Connected?│
         └───────┬───────┘
                 │
         ┌───────┴────────┐
         │ Yes            │ No
         │                ▼
         │         ┌──────────┐
         │         │   Stop   │
         │         └──────────┘
         │
         └────────────────┐
                          │
                          ▼
                 requestAnimationFrame(updateAudioLevel)
                          │
                          └──────────┘ (Loop)
```

## Data Flow Summary

### Outgoing Audio Path
```
Microphone → getUserMedia → MediaStream → Peer Connection → Remote Peer
                    │
                    └──→ Web Audio API → Analyser → Visual Indicator
```

### Incoming Audio Path
```
Remote Peer → Peer Connection → MediaStream → HTML5 Audio → Speakers
```

### Control Flow
```
User Action → Event Handler → Track Enable/Disable → UI Update
```

## Performance Characteristics

### Audio Capture
- Latency: ~10-20ms (hardware + OS)
- CPU: ~1-2% per stream
- Memory: ~2 MB for audio context

### Audio Analysis
- Update Rate: 60fps (16.67ms per frame)
- FFT Size: 256 samples
- CPU: ~1% for analysis
- Memory: ~1 KB for data arrays

### Audio Playback
- Latency: ~50-200ms (network + jitter buffer)
- CPU: ~1% per stream
- Memory: ~1-2 MB per audio element

### Total System Impact
- 3 Participants: ~5% CPU, ~10 MB memory
- 5 Participants: ~8% CPU, ~15 MB memory
- 10 Participants: ~15% CPU, ~25 MB memory

## Error Handling Flow

```
Error Occurs
     │
     ▼
┌─────────────────────────────────────────┐
│ Identify Error Type                     │
└────────────────┬────────────────────────┘
                 │
         ┌───────┴────────┐
         │                │
         ▼                ▼
┌─────────────────┐  ┌──────────────────┐
│ Media Capture   │  │ Audio Context    │
│ Error           │  │ Error            │
└────────┬────────┘  └────────┬─────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌──────────────────┐
│ - Log error     │  │ - Log warning    │
│ - Show message  │  │ - Continue       │
│ - Disable join  │  │ - No indicator   │
└─────────────────┘  └──────────────────┘
```

## Conclusion

This audio flow architecture provides:
- Low-latency audio transmission
- Real-time visual feedback
- Efficient resource usage
- Proper error handling
- Clean resource cleanup
- Scalable multi-participant support

The implementation follows WebRTC best practices and provides a solid foundation for audio communication in the RelayMesh system.
