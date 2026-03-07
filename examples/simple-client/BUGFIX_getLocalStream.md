# Bug Fix: client.getLocalStream is not a function

## Problem

When trying to access the local media stream from the RelayMeshClient, the following error occurred:

```
Error: client.getLocalStream is not a function
```

This happened in the simple-client example when trying to set up audio monitoring:

```javascript
// Get local stream and setup audio monitoring
localStream = client.getLocalStream(); // ❌ Error!
```

## Root Cause

The `RelayMeshClient` class did not expose a `getLocalStream()` method, even though the underlying `MediaHandler` class had this method. The client had no public API to access the local media stream.

## Solution

Added a `getLocalStream()` method to the `RelayMeshClient` class that delegates to the `MediaHandler`:

```typescript
/**
 * Get the local media stream
 * 
 * @returns The local media stream or null if not initialized
 */
getLocalStream(): globalThis.MediaStream | null {
  return this.mediaHandler?.getLocalStream() || null;
}
```

## Changes Made

### 1. Source Code Update

**File:** `src/client/relay-mesh-client.ts`

**Location:** Added after `getConferenceInfo()` method (around line 245)

**Code:**
```typescript
getLocalStream(): globalThis.MediaStream | null {
  return this.mediaHandler?.getLocalStream() || null;
}
```

### 2. Browser Bundle Rebuild

Rebuilt the browser bundle to include the new method:

```bash
npm run build:browser
```

This updated:
- `dist/browser/relay-mesh.js`
- `dist/browser/relay-mesh.min.js`
- `dist/browser/relay-mesh.esm.js`

### 3. Cache Buster Update

Updated the import statement in `examples/simple-client/index.html`:

```javascript
// Before
import { RelayMeshClient } from '../../dist/browser/relay-mesh.esm.js?v=9';

// After
import { RelayMeshClient } from '../../dist/browser/relay-mesh.esm.js?v=10';
```

## Verification

### Method Signature

```typescript
getLocalStream(): globalThis.MediaStream | null
```

**Returns:**
- `MediaStream` - The local media stream if available
- `null` - If media handler is not initialized or no stream exists

### Usage Example

```javascript
const client = new RelayMeshClient(config);
await client.joinConference('my-conference');

// Now safe to call
const localStream = client.getLocalStream();

if (localStream) {
  // Stream is available
  const audioTracks = localStream.getAudioTracks();
  const videoTracks = localStream.getVideoTracks();
  
  console.log(`Audio tracks: ${audioTracks.length}`);
  console.log(`Video tracks: ${videoTracks.length}`);
} else {
  // Stream not available yet or media handler not initialized
  console.log('No local stream available');
}
```

### When to Call

**Safe to call:**
- ✅ After `joinConference()` completes successfully
- ✅ While in CONNECTED state
- ✅ Before calling `leaveConference()`

**Returns null:**
- ❌ Before calling `joinConference()`
- ❌ After calling `leaveConference()`
- ❌ If media initialization failed
- ❌ If no media devices available

## Testing

### Manual Test

1. Build the bundle:
   ```bash
   npm run build:browser
   ```

2. Start the server:
   ```bash
   cd examples/server && node server.js
   ```

3. Serve the client:
   ```bash
   npx http-server . -p 3000
   ```

4. Open http://localhost:3000/examples/simple-client/

5. Open browser console (F12)

6. Join a conference

7. Check console for:
   ```
   Local media: 1 audio, 1 video tracks
   Audio monitoring started
   ```

8. Verify:
   - No "getLocalStream is not a function" error
   - Audio level indicator is working
   - Green bar responds to your voice

### Automated Test

```javascript
// Quick verification script
const client = new RelayMeshClient(config);

// Check method exists
console.assert(
  typeof client.getLocalStream === 'function',
  'getLocalStream should be a function'
);

// Check returns null before join
console.assert(
  client.getLocalStream() === null,
  'Should return null before joining'
);

// After joining
await client.joinConference('test');
const stream = client.getLocalStream();

console.assert(
  stream instanceof MediaStream || stream === null,
  'Should return MediaStream or null'
);
```

## Impact

### Before Fix

```javascript
// ❌ Error
const stream = client.getLocalStream();
// TypeError: client.getLocalStream is not a function

// Workaround (accessing private property - bad practice)
const stream = client['mediaHandler']?.getLocalStream();
```

### After Fix

```javascript
// ✅ Works
const stream = client.getLocalStream();
// Returns MediaStream or null
```

## Related Files

### Modified
- `src/client/relay-mesh-client.ts` - Added method
- `examples/simple-client/index.html` - Updated cache version
- `dist/browser/*.js` - Rebuilt bundles

### Documentation
- `CHANGELOG.md` - Version history
- `BUGFIX_getLocalStream.md` - This file
- `AUDIO_FEATURES.md` - Audio implementation details
- `IMPLEMENTATION_SUMMARY.md` - Complete implementation

## API Documentation

### Method: getLocalStream()

**Description:** Returns the local media stream captured from the user's camera and microphone.

**Signature:**
```typescript
getLocalStream(): globalThis.MediaStream | null
```

**Parameters:** None

**Returns:**
- `MediaStream` - The local media stream containing audio and/or video tracks
- `null` - If the media handler is not initialized or no stream is available

**Throws:** None (returns null instead of throwing)

**Example:**
```javascript
const stream = client.getLocalStream();

if (stream) {
  // Access tracks
  const audioTracks = stream.getAudioTracks();
  const videoTracks = stream.getVideoTracks();
  
  // Get stream ID
  console.log('Stream ID:', stream.id);
  
  // Check if active
  console.log('Active:', stream.active);
  
  // Listen for track events
  stream.addEventListener('addtrack', (event) => {
    console.log('Track added:', event.track);
  });
  
  stream.addEventListener('removetrack', (event) => {
    console.log('Track removed:', event.track);
  });
}
```

**See Also:**
- `MediaHandler.getLocalStream()` - Underlying implementation
- `joinConference()` - Initializes the media stream
- `leaveConference()` - Cleans up the media stream

## Backward Compatibility

This is a **non-breaking change**:
- ✅ Adds new public method
- ✅ Does not modify existing methods
- ✅ Does not change method signatures
- ✅ Does not alter behavior of existing code
- ✅ Safe to upgrade without code changes

Existing code will continue to work. New code can use the new method.

## Future Considerations

### Potential Enhancements

1. **Add getLocalVideoStream()** - Return only video tracks
2. **Add getLocalAudioStream()** - Return only audio tracks
3. **Add replaceLocalStream()** - Replace stream without reconnecting
4. **Add getStreamStats()** - Get stream statistics
5. **Add onStreamChange event** - Notify when stream changes

### Related Methods to Consider

```typescript
// Potential future additions
getLocalVideoTracks(): MediaStreamTrack[]
getLocalAudioTracks(): MediaStreamTrack[]
replaceLocalStream(stream: MediaStream): Promise<void>
getStreamConstraints(): MediaStreamConstraints
updateStreamConstraints(constraints: MediaStreamConstraints): Promise<void>
```

## Conclusion

The bug has been fixed by adding the `getLocalStream()` method to `RelayMeshClient`. The method is now available in the browser bundle and can be used to access the local media stream for audio monitoring and other purposes.

**Status:** ✅ Fixed and verified

**Version:** 1.1.0

**Date:** March 7, 2026
