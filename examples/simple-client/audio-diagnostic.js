/**
 * Audio Diagnostic Script
 * 
 * Run this in the browser console after joining a conference
 * to diagnose audio level indicator issues.
 * 
 * Usage:
 * 1. Join a conference in simple-client
 * 2. Open browser console (F12)
 * 3. Copy and paste this entire script
 * 4. Press Enter
 */

(function() {
  console.log('=== Audio Diagnostic Tool ===\n');
  
  // Check if client exists
  if (typeof client === 'undefined') {
    console.error('❌ Client not found. Make sure you have joined a conference.');
    return;
  }
  
  console.log('✅ Client found');
  console.log('   State:', client.getCurrentState());
  
  // Check local stream
  const stream = client.getLocalStream();
  if (!stream) {
    console.error('❌ No local stream available');
    console.log('   Try: await client.joinConference("test-conference")');
    return;
  }
  
  console.log('✅ Local stream found');
  console.log('   Stream ID:', stream.id);
  console.log('   Active:', stream.active);
  
  // Check audio tracks
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    console.error('❌ No audio tracks in stream');
    console.log('   The stream has no audio. Check microphone permissions.');
    return;
  }
  
  console.log('✅ Audio tracks found:', audioTracks.length);
  
  audioTracks.forEach((track, i) => {
    console.log(`   Track ${i}:`);
    console.log('     Label:', track.label);
    console.log('     Enabled:', track.enabled);
    console.log('     Muted:', track.muted);
    console.log('     Ready state:', track.readyState);
  });
  
  // Check audio context
  if (typeof audioContext === 'undefined' || !audioContext) {
    console.error('❌ Audio context not found');
    console.log('   Audio monitoring may not have been set up.');
    console.log('   Try clicking the mute button to trigger setup.');
    return;
  }
  
  console.log('✅ Audio context found');
  console.log('   State:', audioContext.state);
  console.log('   Sample rate:', audioContext.sampleRate);
  
  if (audioContext.state === 'suspended') {
    console.warn('⚠️  Audio context is SUSPENDED');
    console.log('   Attempting to resume...');
    audioContext.resume().then(() => {
      console.log('✅ Audio context resumed:', audioContext.state);
    }).catch(err => {
      console.error('❌ Failed to resume:', err);
    });
  }
  
  // Check analyser
  if (typeof localAnalyser === 'undefined' || !localAnalyser) {
    console.error('❌ Audio analyser not found');
    console.log('   Audio monitoring was not set up properly.');
    return;
  }
  
  console.log('✅ Audio analyser found');
  console.log('   FFT size:', localAnalyser.fftSize);
  console.log('   Smoothing:', localAnalyser.smoothingTimeConstant);
  console.log('   Frequency bin count:', localAnalyser.frequencyBinCount);
  
  // Test audio analysis
  console.log('\n--- Testing Audio Analysis ---');
  console.log('Speak into your microphone...\n');
  
  const dataArray = new Uint8Array(localAnalyser.fftSize);
  let testCount = 0;
  const maxTests = 5;
  
  function testAudio() {
    if (testCount >= maxTests) {
      console.log('\n--- Test Complete ---');
      console.log('If RMS values are all near 0, there may be an issue.');
      console.log('If RMS values change when speaking, audio is working!');
      return;
    }
    
    localAnalyser.getByteTimeDomainData(dataArray);
    
    // Calculate RMS
    let sum = 0;
    let min = 255;
    let max = 0;
    
    for (let i = 0; i < dataArray.length; i++) {
      const value = dataArray[i];
      min = Math.min(min, value);
      max = Math.max(max, value);
      const normalized = (value - 128) / 128;
      sum += normalized * normalized;
    }
    
    const rms = Math.sqrt(sum / dataArray.length);
    const percentage = Math.min(100, rms * 300);
    
    console.log(`Test ${testCount + 1}/${maxTests}:`);
    console.log('  RMS:', rms.toFixed(4));
    console.log('  Percentage:', percentage.toFixed(1) + '%');
    console.log('  Data range:', min, '-', max);
    console.log('  Context state:', audioContext.state);
    
    if (rms < 0.001) {
      console.warn('  ⚠️  Very low RMS - speak louder or check microphone');
    } else if (rms > 0.01) {
      console.log('  ✅ Good audio level detected!');
    }
    
    testCount++;
    setTimeout(testAudio, 1000);
  }
  
  testAudio();
  
  // Check UI elements
  console.log('\n--- UI Elements ---');
  
  if (typeof elements !== 'undefined') {
    console.log('✅ Elements object found');
    
    if (elements.localAudioLevel) {
      console.log('✅ Audio level bar element found');
      console.log('   Current width:', elements.localAudioLevel.style.width);
    } else {
      console.error('❌ Audio level bar element not found');
    }
    
    if (elements.muteBtn) {
      console.log('✅ Mute button found');
      console.log('   Disabled:', elements.muteBtn.disabled);
      console.log('   Text:', elements.muteBtn.textContent);
    } else {
      console.error('❌ Mute button not found');
    }
  } else {
    console.error('❌ Elements object not found');
  }
  
  // Summary
  console.log('\n=== Diagnostic Summary ===');
  
  const issues = [];
  
  if (!stream) issues.push('No local stream');
  if (audioTracks.length === 0) issues.push('No audio tracks');
  if (!audioContext) issues.push('No audio context');
  if (audioContext && audioContext.state === 'suspended') issues.push('Audio context suspended');
  if (!localAnalyser) issues.push('No audio analyser');
  
  if (issues.length === 0) {
    console.log('✅ All checks passed!');
    console.log('   Audio monitoring should be working.');
    console.log('   If the bar still doesn\'t move, check the test results above.');
  } else {
    console.error('❌ Issues found:');
    issues.forEach(issue => console.error('   -', issue));
  }
  
  console.log('\n=== Recommendations ===');
  
  if (audioContext && audioContext.state === 'suspended') {
    console.log('1. Click the mute button to resume audio context');
  }
  
  if (audioTracks.length > 0 && audioTracks[0].muted) {
    console.log('2. Unmute your microphone in system settings');
  }
  
  if (!localAnalyser) {
    console.log('3. Try refreshing the page and rejoining');
  }
  
  console.log('\nFor more help, see TROUBLESHOOTING_AUDIO.md');
  console.log('=== End Diagnostic ===\n');
})();
