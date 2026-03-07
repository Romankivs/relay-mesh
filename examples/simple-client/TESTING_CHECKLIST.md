# Audio Features Testing Checklist

Use this checklist to verify that all audio features are working correctly.

## Pre-Testing Setup

- [ ] Build the browser bundle: `npm run build:browser`
- [ ] Start the signaling server: `cd examples/server && node server.js`
- [ ] Serve the client: `npx http-server . -p 3000`
- [ ] Open http://localhost:3000/examples/simple-client/ in browser

## Single Participant Tests

### Audio Capture
- [ ] Click "Join Conference"
- [ ] Grant microphone permissions when prompted
- [ ] Verify "Audio monitoring started" appears in log
- [ ] Speak into microphone
- [ ] Verify green audio level bar responds to your voice
- [ ] Verify bar increases with louder sounds
- [ ] Verify bar decreases when quiet

### Mute/Unmute
- [ ] Click "Mute" button
- [ ] Verify button text changes to "🔇 Unmute"
- [ ] Verify button turns red
- [ ] Verify "Microphone muted" appears in log
- [ ] Speak into microphone
- [ ] Verify audio level bar stops responding
- [ ] Click "Unmute" button
- [ ] Verify button text changes to "🎤 Mute"
- [ ] Verify button turns green
- [ ] Verify "Microphone unmuted" appears in log
- [ ] Verify audio level bar responds again

### Leave Conference
- [ ] Click "Leave Conference"
- [ ] Verify audio level bar resets to 0%
- [ ] Verify mute button is disabled
- [ ] Verify "Left conference" appears in log

## Multi-Participant Tests

### Two Participants
- [ ] Open two browser tabs/windows
- [ ] Join same conference in both tabs
- [ ] In Tab 1: Speak into microphone
- [ ] In Tab 2: Verify audio element appears in "Remote Audio Streams"
- [ ] In Tab 2: Verify you can hear Tab 1's audio
- [ ] In Tab 2: Verify audio controls show participant ID
- [ ] In Tab 1: Click mute
- [ ] In Tab 2: Verify audio stops
- [ ] In Tab 1: Click unmute
- [ ] In Tab 2: Verify audio resumes

### Volume Control
- [ ] With two participants connected
- [ ] In Tab 2: Find remote audio controls
- [ ] Adjust volume slider to 50%
- [ ] Verify audio volume decreases
- [ ] Adjust volume slider to 100%
- [ ] Verify audio volume increases
- [ ] Click mute on audio control
- [ ] Verify audio stops
- [ ] Click unmute on audio control
- [ ] Verify audio resumes

### Three or More Participants
- [ ] Open three or more browser tabs
- [ ] Join same conference in all tabs
- [ ] Verify each tab shows N-1 remote audio streams
- [ ] Speak in different tabs
- [ ] Verify audio from all participants is audible
- [ ] Verify each audio stream has independent controls
- [ ] Mute one participant
- [ ] Verify only that participant's audio stops

### Participant Leave
- [ ] With multiple participants connected
- [ ] Note participant IDs in "Remote Audio Streams"
- [ ] Close one tab
- [ ] In remaining tabs: Verify that participant's audio element is removed
- [ ] Verify "Participant left" appears in log
- [ ] Verify remaining audio streams still work

## Edge Cases

### No Microphone
- [ ] Disconnect/disable microphone
- [ ] Try to join conference
- [ ] Verify appropriate error message
- [ ] Verify mute button remains disabled

### Microphone Permission Denied
- [ ] Block microphone permissions in browser
- [ ] Try to join conference
- [ ] Verify "Permission denied" error message
- [ ] Grant permissions and reload
- [ ] Verify can join successfully

### Network Issues
- [ ] Join conference with two participants
- [ ] Disconnect network on one participant
- [ ] Verify audio stops
- [ ] Reconnect network
- [ ] Verify audio resumes (may require rejoin)

### Browser Compatibility
- [ ] Test in Chrome
- [ ] Test in Firefox
- [ ] Test in Safari
- [ ] Test in Edge
- [ ] Verify audio works in all browsers

## Performance Tests

### CPU Usage
- [ ] Join conference
- [ ] Open browser task manager
- [ ] Verify CPU usage is reasonable (<5%)
- [ ] Speak continuously for 1 minute
- [ ] Verify CPU usage remains stable

### Memory Usage
- [ ] Join conference with 5+ participants
- [ ] Monitor memory usage in browser task manager
- [ ] Leave and rejoin conference 5 times
- [ ] Verify no significant memory increase (memory leaks)

### Long Duration
- [ ] Join conference
- [ ] Stay connected for 10+ minutes
- [ ] Verify audio continues to work
- [ ] Verify no degradation in quality
- [ ] Verify no browser crashes or freezes

## Known Issues to Verify

### Participant Count Delay
- [ ] Join conference with multiple participants
- [ ] Verify participant count shows 1 initially
- [ ] Wait 3-5 seconds
- [ ] Verify participant count updates correctly

### Audio Context Autoplay Policy
- [ ] Join conference in browser with strict autoplay policy
- [ ] Verify audio monitoring still works
- [ ] Verify remote audio plays automatically

## Cleanup Verification

### Proper Resource Cleanup
- [ ] Join conference
- [ ] Open browser console
- [ ] Leave conference
- [ ] Verify no errors in console
- [ ] Verify audio context is closed
- [ ] Verify audio elements are removed from DOM
- [ ] Verify no orphaned event listeners

## Accessibility Tests

### Keyboard Navigation
- [ ] Use Tab key to navigate controls
- [ ] Verify can reach all buttons
- [ ] Verify can activate buttons with Enter/Space
- [ ] Verify focus indicators are visible

### Screen Reader
- [ ] Enable screen reader
- [ ] Navigate through interface
- [ ] Verify buttons are properly labeled
- [ ] Verify status updates are announced

## Test Results

Date: _______________
Tester: _______________
Browser: _______________
OS: _______________

Pass Rate: _____ / _____ tests passed

Notes:
_______________________________________
_______________________________________
_______________________________________
