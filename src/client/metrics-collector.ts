// Metrics Collector component
// Task 3: Implement Metrics Collector component

import {
  ParticipantMetrics,
  BandwidthMetrics,
  NATType,
  LatencyMetrics,
  StabilityMetrics,
  DeviceMetrics,
} from '../shared/types';

export interface MetricsCollectorConfig {
  participantId: string;
  stunServers?: string[];
  reevaluationIntervalMs?: number;
  bandwidthTestDurationMs?: number;
  bandwidthTestPacketSize?: number;
}

export class MetricsCollector {
  private participantId: string;
  private stunServers: string[];
  private reevaluationIntervalMs: number;
  private bandwidthTestDurationMs: number;
  private bandwidthTestPacketSize: number;
  
  private currentMetrics: ParticipantMetrics | null = null;
  private updateCallbacks: Array<(metrics: ParticipantMetrics) => void> = [];
  private updateInterval: NodeJS.Timeout | null = null;
  private connectionStartTime: number = 0;
  private reconnectionCount: number = 0;
  
  // Latency tracking
  private latencyMeasurements: Map<string, number> = new Map();
  
  // Stability tracking
  private packetLossPercent: number = 0;
  private jitterMs: number = 0;

  // RTC-derived bandwidth (from outbound/inbound-rtp byte deltas)
  private rtcUploadMbps: number = 0;
  private rtcDownloadMbps: number = 0;
  private hasRTCBandwidth: boolean = false;

  constructor(config: MetricsCollectorConfig) {
    this.participantId = config.participantId;
    this.stunServers = config.stunServers || [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
    ];
    this.reevaluationIntervalMs = config.reevaluationIntervalMs || 30000;
    this.bandwidthTestDurationMs = config.bandwidthTestDurationMs || 2000;
    this.bandwidthTestPacketSize = config.bandwidthTestPacketSize || 1024;
  }

  /**
   * Start collecting metrics for this participant
   * Task 3.1, 3.5
   */
  async startCollection(): Promise<void> {
    this.connectionStartTime = Date.now();
    
    // Collect initial metrics
    await this.collectMetrics();
    
    // Set up periodic updates
    this.updateInterval = setInterval(async () => {
      await this.collectMetrics();
    }, this.reevaluationIntervalMs);
  }

  /**
   * Stop collecting metrics and clean up
   */
  stopCollection(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Get current metrics snapshot
   * Task 3.1
   */
  getCurrentMetrics(): ParticipantMetrics {
    if (!this.currentMetrics) {
      throw new Error('Metrics not yet collected. Call startCollection() first.');
    }
    return this.currentMetrics;
  }

  /**
   * Measure bandwidth using test packets
   * Task 3.1
   */
  async measureBandwidth(): Promise<BandwidthMetrics> {
      try {
        // Create a test peer connection for bandwidth measurement
        const pc = new RTCPeerConnection({
          iceServers: this.stunServers.map(url => ({ urls: url })),
        });

        try {
          // Create a data channel for testing
          const dataChannel = pc.createDataChannel('bandwidth-test', {
            ordered: false,
            maxRetransmits: 0,
          });

          let uploadBytes = 0;
          let downloadBytes = 0;
          let uploadStartTime = 0;
          let downloadStartTime = 0;

          // Set up data channel handlers
          dataChannel.onopen = () => {
            uploadStartTime = Date.now();

            // Send test packets
            const testData = new ArrayBuffer(this.bandwidthTestPacketSize);
            const sendInterval = setInterval(() => {
              if (dataChannel.readyState === 'open') {
                try {
                  dataChannel.send(testData);
                  uploadBytes += this.bandwidthTestPacketSize;
                } catch (e) {
                  clearInterval(sendInterval);
                }
              }
            }, 10);

            // Stop after test duration
            setTimeout(() => {
              clearInterval(sendInterval);
              dataChannel.close();
            }, this.bandwidthTestDurationMs);
          };

          dataChannel.onmessage = (event) => {
            if (downloadStartTime === 0) {
              downloadStartTime = Date.now();
            }
            downloadBytes += event.data.byteLength || event.data.length || 0;
          };

          // Create offer and set local description
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          // Wait for test to complete (skip if duration is 0)
          if (this.bandwidthTestDurationMs > 0) {
            await new Promise(resolve => setTimeout(resolve, this.bandwidthTestDurationMs + 500));
          }

          // Calculate bandwidth in Mbps
          const uploadDurationSec = (Date.now() - uploadStartTime) / 1000;
          const downloadDurationSec = downloadStartTime > 0 
            ? (Date.now() - downloadStartTime) / 1000 
            : uploadDurationSec;

          const uploadMbps = uploadDurationSec > 0 
            ? (uploadBytes * 8) / (uploadDurationSec * 1000000) 
            : 0;
          const downloadMbps = downloadDurationSec > 0 
            ? (downloadBytes * 8) / (downloadDurationSec * 1000000) 
            : 0;

          // Confidence based on whether we got bidirectional data
          const measurementConfidence = downloadBytes > 0 ? 0.8 : 0.5;

          return {
            uploadMbps: Math.max(0, uploadMbps),
            downloadMbps: Math.max(0, downloadMbps),
            measurementConfidence,
          };
        } finally {
          pc.close();
        }
      } catch (error) {
        console.warn('Bandwidth measurement failed, using fallback values:', error);

        // Task 18.4: Use last known value if available
        if (this.currentMetrics?.bandwidth) {
          console.log('Using last known bandwidth values');
          return {
            ...this.currentMetrics.bandwidth,
            measurementConfidence: 0.3, // Lower confidence for stale data
          };
        }

        // Task 18.4: Use conservative default values (Requirement 2.1)
        // 5 Mbps upload, 10 Mbps download as specified in design document
        console.log('Using conservative default bandwidth values');
        return {
          uploadMbps: 5.0,
          downloadMbps: 10.0,
          measurementConfidence: 0.1, // Very low confidence for defaults
        };
      }
    }

  /**
   * Collect all metrics
   * Internal method called periodically
   * Made public for testing purposes
   */
  async collectMetrics(): Promise<void> {
    const bandwidth = await this.measureBandwidth();
    const natType = await this.detectNATType();
    const device = await this.assessDeviceCapabilities();
    
    const latency: LatencyMetrics = {
      averageRttMs: this.calculateAverageLatency(),
      minRttMs: this.calculateMinLatency(),
      maxRttMs: this.calculateMaxLatency(),
      measurements: new Map(this.latencyMeasurements),
    };

    const connectionUptime = (Date.now() - this.connectionStartTime) / 1000;
    const stability: StabilityMetrics = {
      packetLossPercent: this.packetLossPercent,
      jitterMs: this.jitterMs,
      connectionUptime,
      reconnectionCount: this.reconnectionCount,
    };

    this.currentMetrics = {
      participantId: this.participantId,
      timestamp: Date.now(),
      bandwidth,
      natType,
      latency,
      stability,
      device,
    };

    // Notify subscribers
    this.notifySubscribers();
  }

  /**
   * Detect NAT type using STUN
   * Task 3.2
   * 
   * Uses STUN server interactions to classify NAT type:
   * - OPEN: Direct public IP, no NAT
   * - FULL_CONE: Most permissive NAT
   * - RESTRICTED: Restricted cone NAT
   * - PORT_RESTRICTED: Port-restricted cone NAT
   * - SYMMETRIC: Most restrictive, requires TURN
   */
  async detectNATType(): Promise<NATType> {
      try {
        // Create peer connection with STUN servers
        const pc = new RTCPeerConnection({
          iceServers: this.stunServers.map(url => ({ urls: url })),
        });

        // Create a data channel to trigger ICE gathering
        pc.createDataChannel('nat-detection');

        // Create offer to start ICE gathering
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering to complete
        const candidates = await this.gatherICECandidates(pc);

        pc.close();

        // Analyze candidates to determine NAT type
        return this.analyzeNATType(candidates);
      } catch (error) {
        console.warn('NAT type detection failed, using fallback:', error);

        // Task 18.4: Use last known value if available
        if (this.currentMetrics?.natType !== undefined) {
          console.log('Using last known NAT type');
          return this.currentMetrics.natType;
        }

        // Task 18.4: Assume SYMMETRIC NAT (most restrictive) on error (Requirement 2.2)
        // This ensures participant won't be eligible for relay role if NAT detection fails
        console.log('Assuming SYMMETRIC NAT (most restrictive) as fallback');
        return NATType.SYMMETRIC;
      }
    }

  /**
   * Gather ICE candidates from peer connection
   */
  private gatherICECandidates(pc: RTCPeerConnection): Promise<RTCIceCandidate[]> {
    return new Promise((resolve) => {
      const candidates: RTCIceCandidate[] = [];
      const timeout = setTimeout(() => {
        resolve(candidates);
      }, 5000); // 5 second timeout

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          candidates.push(event.candidate);
        } else {
          // ICE gathering complete
          clearTimeout(timeout);
          resolve(candidates);
        }
      };
    });
  }

  /**
   * Analyze ICE candidates to determine NAT type
   */
  private analyzeNATType(candidates: RTCIceCandidate[]): NATType {
    let hasHostCandidate = false;
    let hasSrflxCandidate = false;
    let hasRelayCandidate = false;
    let publicIpCount = 0;

    for (const candidate of candidates) {
      const type = candidate.type;
      
      if (type === 'host') {
        hasHostCandidate = true;
        // Check if host candidate has public IP
        if (this.isPublicIP(candidate.address || '')) {
          publicIpCount++;
        }
      } else if (type === 'srflx') {
        hasSrflxCandidate = true;
      } else if (type === 'relay') {
        hasRelayCandidate = true;
      }
    }

    // Classification logic based on RFC 5780 and practical observations
    
    // If we have a public IP in host candidates, likely no NAT (OPEN)
    if (hasHostCandidate && publicIpCount > 0) {
      return NATType.OPEN;
    }

    // If we have both host and srflx candidates, we're behind NAT
    if (hasHostCandidate && hasSrflxCandidate) {
      // Check if multiple srflx candidates with different ports
      const srflxCandidates = candidates.filter(c => c.type === 'srflx');
      
      if (srflxCandidates.length > 1) {
        // Multiple mappings suggest symmetric NAT
        const ports = new Set(srflxCandidates.map(c => c.port));
        if (ports.size > 1) {
          return NATType.SYMMETRIC;
        }
      }

      // Single consistent mapping suggests cone NAT
      // Default to FULL_CONE as we can't easily distinguish between cone types
      // without more sophisticated testing
      return NATType.FULL_CONE;
    }

    // If we only have relay candidates, likely symmetric NAT
    if (hasRelayCandidate && !hasSrflxCandidate) {
      return NATType.SYMMETRIC;
    }

    // Default to PORT_RESTRICTED as a middle ground
    return NATType.PORT_RESTRICTED;
  }

  /**
   * Check if an IP address is public (not private/local)
   */
  private isPublicIP(ip: string): boolean {
    // Check for private IP ranges
    const privateRanges = [
      /^10\./,                    // 10.0.0.0/8
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
      /^192\.168\./,              // 192.168.0.0/16
      /^127\./,                   // 127.0.0.0/8 (loopback)
      /^169\.254\./,              // 169.254.0.0/16 (link-local)
      /^::1$/,                    // IPv6 loopback
      /^fe80:/,                   // IPv6 link-local
      /^fc00:/,                   // IPv6 unique local
    ];

    return !privateRanges.some(range => range.test(ip));
  }

  /**
   * Assess device capabilities
   * Task 3.4
   * 
   * Measures CPU usage, available memory, codec support, and hardware acceleration
   */
  private async assessDeviceCapabilities(): Promise<DeviceMetrics> {
    const cpuUsage = await this.measureCPUUsage();
    const availableMemory = this.measureAvailableMemory();
    const supportedCodecs = await this.detectSupportedCodecs();
    const hardwareAcceleration = await this.detectHardwareAcceleration();

    return {
      cpuUsagePercent: cpuUsage,
      availableMemoryMB: availableMemory,
      supportedCodecs,
      hardwareAcceleration,
    };
  }

  /**
   * Measure CPU usage
   * Uses performance.now() timing to estimate CPU load
   */
  private async measureCPUUsage(): Promise<number> {
    // In browser environment, we can't directly measure CPU usage
    // We'll use a heuristic based on task execution time
    const iterations = 100000;
    const startTime = performance.now();
    
    // Perform some CPU-intensive work
    let sum = 0;
    for (let i = 0; i < iterations; i++) {
      sum += Math.sqrt(i);
    }
    
    const endTime = performance.now();
    const executionTime = endTime - startTime;
    
    // Normalize to 0-100 scale (baseline: 10ms for 100k iterations)
    // Slower execution suggests higher CPU usage
    const baseline = 10;
    const cpuUsage = Math.min(100, (executionTime / baseline) * 50);
    
    return Math.round(cpuUsage);
  }

  /**
   * Measure available memory
   * Uses performance.memory API if available (Chrome/Edge)
   */
  private measureAvailableMemory(): number {
    // Check if performance.memory is available (Chrome/Edge)
    const perfMemory = (performance as any).memory;
    
    if (perfMemory && typeof perfMemory.jsHeapSizeLimit === 'number') {
      const totalHeapMB = perfMemory.jsHeapSizeLimit / (1024 * 1024);
      const usedHeapMB = perfMemory.usedJSHeapSize / (1024 * 1024);
      return Math.round(totalHeapMB - usedHeapMB);
    }
    
    // Fallback: estimate based on device type
    // Most modern devices have at least 2GB available for browser
    return 2048;
  }

  /**
   * Detect supported codecs
   * Checks which video and audio codecs are supported by the browser
   */
  private async detectSupportedCodecs(): Promise<string[]> {
    const supportedCodecs: string[] = [];
    
    // Common video codecs to test
    const videoCodecs = [
      'video/VP8',
      'video/VP9',
      'video/H264',
      'video/H265',
      'video/AV1',
    ];
    
    // Common audio codecs to test
    const audioCodecs = [
      'audio/opus',
      'audio/PCMU',
      'audio/PCMA',
      'audio/G722',
      'audio/ISAC',
    ];

    // Check if RTCRtpSender.getCapabilities is available
    if (typeof RTCRtpSender !== 'undefined' && RTCRtpSender.getCapabilities) {
      // Check video codecs
      try {
        const videoCapabilities = RTCRtpSender.getCapabilities('video');
        if (videoCapabilities && videoCapabilities.codecs) {
          videoCapabilities.codecs.forEach(codec => {
            const mimeType = codec.mimeType;
            if (mimeType && !supportedCodecs.includes(mimeType)) {
              supportedCodecs.push(mimeType);
            }
          });
        }
      } catch (e) {
        // Video capabilities not available
      }

      // Check audio codecs
      try {
        const audioCapabilities = RTCRtpSender.getCapabilities('audio');
        if (audioCapabilities && audioCapabilities.codecs) {
          audioCapabilities.codecs.forEach(codec => {
            const mimeType = codec.mimeType;
            if (mimeType && !supportedCodecs.includes(mimeType)) {
              supportedCodecs.push(mimeType);
            }
          });
        }
      } catch (e) {
        // Audio capabilities not available
      }
    }

    // Fallback: assume common codecs are supported
    if (supportedCodecs.length === 0) {
      supportedCodecs.push('video/VP8', 'video/H264', 'audio/opus');
    }

    return supportedCodecs;
  }

  /**
   * Detect hardware acceleration support
   * Checks if the browser/device supports hardware-accelerated video encoding/decoding
   */
  private async detectHardwareAcceleration(): Promise<boolean> {
    // Check for WebGL support as a proxy for hardware acceleration
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      
      if (gl && 'getParameter' in gl) {
        // Check for specific hardware acceleration indicators
        const debugInfo = (gl as any).getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          const renderer = (gl as any).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
          // If renderer contains GPU-related keywords, likely hardware accelerated
          const gpuKeywords = ['nvidia', 'amd', 'intel', 'radeon', 'geforce', 'mali', 'adreno'];
          const hasGPU = gpuKeywords.some(keyword => 
            renderer.toLowerCase().includes(keyword)
          );
          return hasGPU;
        }
        
        // WebGL available suggests some level of hardware acceleration
        return true;
      }
    } catch (e) {
      // WebGL not available
    }

    // Check if we're in a Node.js environment (no hardware acceleration for video)
    if (typeof window === 'undefined') {
      return false;
    }

    // Default to true for modern browsers
    return true;
  }

  /**
   * Update bandwidth from real RTCStats byte deltas (called by relay-mesh-client stats poller)
   */
  updateBandwidth(uploadMbps: number, downloadMbps: number): void {
    this.rtcUploadMbps = uploadMbps;
    this.rtcDownloadMbps = downloadMbps;
    this.hasRTCBandwidth = true;
  }

  /**
   * Snapshot current latency/stability/bandwidth into currentMetrics and notify subscribers.
   * Called after each RTCStats poll so the dashboard sees fresh values without waiting
   * for the full 30s collectMetrics cycle.
   */
  async snapshotFromRTCStats(): Promise<void> {
    if (!this.currentMetrics) return;

    const connectionUptime = (Date.now() - this.connectionStartTime) / 1000;

    const bandwidth: BandwidthMetrics = this.hasRTCBandwidth
      ? { uploadMbps: this.rtcUploadMbps, downloadMbps: this.rtcDownloadMbps, measurementConfidence: 0.8 }
      : this.currentMetrics.bandwidth;

    this.currentMetrics = {
      ...this.currentMetrics,
      timestamp: Date.now(),
      bandwidth,
      latency: {
        averageRttMs: this.calculateAverageLatency(),
        minRttMs: this.calculateMinLatency(),
        maxRttMs: this.calculateMaxLatency(),
        measurements: new Map(this.latencyMeasurements),
      },
      stability: {
        packetLossPercent: this.packetLossPercent,
        jitterMs: this.jitterMs,
        connectionUptime,
        reconnectionCount: this.reconnectionCount,
      },
    };

    this.notifySubscribers();
  }

  /**
   * Update latency measurement for a participant
   * Task 3.3
   * 
   * Called when RTT measurements are available from RTCP reports
   */
  updateLatency(participantId: string, rtt: number): void {
    if (rtt >= 0) {
      this.latencyMeasurements.set(participantId, rtt);
    }
  }

  /**
   * Update stability metrics from connection stats
   * Task 3.3
   * 
   * Extracts packet loss, jitter, and other stability metrics from RTCStatsReport
   */
  updateStability(stats: RTCStatsReport): void {
    let totalPacketsLost = 0;
    let totalPacketsReceived = 0;
    let jitterSum = 0;
    let jitterCount = 0;

    stats.forEach((report) => {
      // Process inbound RTP stream stats
      if (report.type === 'inbound-rtp') {
        const inboundReport = report as any;
        
        // Extract packet loss
        if (typeof inboundReport.packetsLost === 'number') {
          totalPacketsLost += inboundReport.packetsLost;
        }
        
        if (typeof inboundReport.packetsReceived === 'number') {
          totalPacketsReceived += inboundReport.packetsReceived;
        }

        // Extract jitter (in seconds, convert to ms)
        if (typeof inboundReport.jitter === 'number') {
          jitterSum += inboundReport.jitter * 1000;
          jitterCount++;
        }
      }

      // Also check remote-inbound-rtp for additional metrics
      if (report.type === 'remote-inbound-rtp') {
        const remoteReport = report as any;
        
        if (typeof remoteReport.packetsLost === 'number') {
          totalPacketsLost += remoteReport.packetsLost;
        }

        if (typeof remoteReport.jitter === 'number') {
          jitterSum += remoteReport.jitter * 1000;
          jitterCount++;
        }
      }
    });

    // Calculate packet loss percentage
    const totalPackets = totalPacketsReceived + totalPacketsLost;
    if (totalPackets > 0) {
      this.packetLossPercent = (totalPacketsLost / totalPackets) * 100;
    }

    // Calculate average jitter
    if (jitterCount > 0) {
      this.jitterMs = jitterSum / jitterCount;
    }
  }

  /**
   * Subscribe to metrics updates
   * Task 3.5
   */
  onMetricsUpdate(callback: (metrics: ParticipantMetrics) => void): void {
    this.updateCallbacks.push(callback);
  }

  /**
   * Notify all subscribers of metrics update
   */
  private notifySubscribers(): void {
    if (this.currentMetrics) {
      this.updateCallbacks.forEach(callback => {
        try {
          callback(this.currentMetrics!);
        } catch (error) {
          console.error('Error in metrics update callback:', error);
        }
      });
    }
  }

  /**
   * Calculate average latency across all participants
   */
  private calculateAverageLatency(): number {
    if (this.latencyMeasurements.size === 0) return 0;
    const sum = Array.from(this.latencyMeasurements.values()).reduce((a, b) => a + b, 0);
    return sum / this.latencyMeasurements.size;
  }

  /**
   * Calculate minimum latency
   */
  private calculateMinLatency(): number {
    if (this.latencyMeasurements.size === 0) return 0;
    return Math.min(...Array.from(this.latencyMeasurements.values()));
  }

  /**
   * Calculate maximum latency
   */
  private calculateMaxLatency(): number {
    if (this.latencyMeasurements.size === 0) return 0;
    return Math.max(...Array.from(this.latencyMeasurements.values()));
  }

  /**
   * Increment reconnection count (called externally when reconnection occurs)
   */
  incrementReconnectionCount(): void {
    this.reconnectionCount++;
  }
}
