# RelayMesh Configuration Guide

## Overview

RelayMesh provides extensive configuration options to optimize the system for different deployment scenarios. This guide covers all configuration parameters, their effects, and recommended values for common use cases.

## Table of Contents

- [Configuration Sources](#configuration-sources)
- [Selection Algorithm Configuration](#selection-algorithm-configuration)
- [Peer Connection Configuration](#peer-connection-configuration)
- [Connection Timeouts](#connection-timeouts)
- [Server Configuration](#server-configuration)
- [Recommended Scenarios](#recommended-scenarios)
- [Performance Tuning](#performance-tuning)
- [Troubleshooting](#troubleshooting)

---

## Configuration Sources

RelayMesh loads configuration from multiple sources with the following precedence (highest to lowest):

1. **Environment Variables** (highest priority)
2. **Configuration File** (JSON)
3. **Default Values** (lowest priority)

### Using Environment Variables

Set configuration via environment variables:

```bash
export RELAYMESH_MIN_BANDWIDTH_MBPS=10
export RELAYMESH_MAX_PARTICIPANTS_PER_RELAY=7
export RELAYMESH_REEVALUATION_INTERVAL_MS=20000
node your-app.js
```

### Using Configuration File

Create a JSON configuration file:

```json
{
  "selection": {
    "bandwidthWeight": 0.35,
    "natWeight": 0.25,
    "latencyWeight": 0.20,
    "stabilityWeight": 0.10,
    "deviceWeight": 0.10,
    "minBandwidthMbps": 10,
    "maxParticipantsPerRelay": 7,
    "reevaluationIntervalMs": 20000
  },
  "peerConnection": {
    "iceServers": [
      { "urls": "stun:stun.example.com:3478" },
      {
        "urls": "turn:turn.example.com:3478",
        "username": "user",
        "credential": "pass"
      }
    ],
    "iceTransportPolicy": "all"
  },
  "connectionTimeouts": {
    "iceGatheringTimeoutMs": 15000,
    "connectionEstablishmentTimeoutMs": 45000,
    "reconnectionTimeoutMs": 10000
  }
}
```

Load the configuration:

```typescript
import { createConfigurationManager } from 'relay-mesh';

const configManager = createConfigurationManager('./config.json');
const config = configManager.getConfig();
```

---


## Selection Algorithm Configuration

The selection algorithm determines which participants become relay nodes based on weighted metrics.

### Parameters

#### bandwidthWeight

**Type:** `number` (0-1)  
**Default:** `0.30`  
**Environment Variable:** `RELAYMESH_BANDWIDTH_WEIGHT`

Weight for bandwidth score in relay selection. Higher values prioritize participants with better bandwidth.

**Recommendation:**
- **High bandwidth networks:** 0.25-0.30
- **Low bandwidth networks:** 0.35-0.40 (prioritize bandwidth more)
- **Mobile networks:** 0.40-0.45

#### natWeight

**Type:** `number` (0-1)  
**Default:** `0.25`  
**Environment Variable:** `RELAYMESH_NAT_WEIGHT`

Weight for NAT type score. Higher values prioritize participants with less restrictive NAT.

**Recommendation:**
- **Corporate networks:** 0.30-0.35 (often restrictive NAT)
- **Home networks:** 0.20-0.25
- **Public networks:** 0.25-0.30

#### latencyWeight

**Type:** `number` (0-1)  
**Default:** `0.20`  
**Environment Variable:** `RELAYMESH_LATENCY_WEIGHT`

Weight for latency score. Higher values prioritize participants with lower average latency.

**Recommendation:**
- **Geographically distributed:** 0.25-0.30 (latency matters more)
- **Local network:** 0.10-0.15 (latency less critical)
- **Real-time applications:** 0.25-0.30

#### stabilityWeight

**Type:** `number` (0-1)  
**Default:** `0.15`  
**Environment Variable:** `RELAYMESH_STABILITY_WEIGHT`

Weight for connection stability (packet loss, jitter, uptime).

**Recommendation:**
- **Unstable networks:** 0.20-0.25 (prioritize stable connections)
- **Stable networks:** 0.10-0.15
- **Mobile participants:** 0.20-0.25

#### deviceWeight

**Type:** `number` (0-1)  
**Default:** `0.10`  
**Environment Variable:** `RELAYMESH_DEVICE_WEIGHT`

Weight for device capabilities (CPU, memory, codecs).

**Recommendation:**
- **Mixed devices:** 0.10-0.15
- **Low-end devices:** 0.15-0.20 (avoid overloading weak devices)
- **High-end devices only:** 0.05-0.10

**Note:** All weights must sum to approximately 1.0.


#### minBandwidthMbps

**Type:** `number` (Mbps)  
**Default:** `5`  
**Environment Variable:** `RELAYMESH_MIN_BANDWIDTH_MBPS`  
**Range:** 0-100

Minimum upload bandwidth required for relay node eligibility.

**Recommendation:**
- **HD video (720p):** 5-7 Mbps
- **Full HD (1080p):** 10-15 Mbps
- **4K video:** 25-35 Mbps
- **Audio only:** 1-2 Mbps
- **Mobile networks:** 3-5 Mbps

**Formula:** `minBandwidth = (expectedStreams × bitratePerStream × 1.2)`

Example: For 5 participants at 2 Mbps each: `5 × 2 × 1.2 = 12 Mbps`

#### maxParticipantsPerRelay

**Type:** `number`  
**Default:** `5`  
**Environment Variable:** `RELAYMESH_MAX_PARTICIPANTS_PER_RELAY`  
**Range:** 1-20

Maximum number of regular participants assigned to each relay node.

**Recommendation:**
- **High bandwidth relays:** 7-10
- **Medium bandwidth relays:** 5-7
- **Low bandwidth relays:** 3-5
- **Mobile relays:** 2-4

**Impact:**
- **Lower values:** More relay nodes needed, better load distribution
- **Higher values:** Fewer relay nodes, higher load per relay

#### reevaluationIntervalMs

**Type:** `number` (milliseconds)  
**Default:** `30000` (30 seconds)  
**Environment Variable:** `RELAYMESH_REEVALUATION_INTERVAL_MS`  
**Range:** 1000-300000

Interval for re-evaluating relay node selection and metrics updates.

**Recommendation:**
- **Stable networks:** 30000-60000 ms (30-60 seconds)
- **Unstable networks:** 15000-30000 ms (15-30 seconds)
- **Mobile networks:** 20000-40000 ms (20-40 seconds)
- **Testing/development:** 10000-15000 ms (10-15 seconds)

**Impact:**
- **Lower values:** More responsive to changes, higher signaling overhead
- **Higher values:** Less responsive, lower signaling overhead

---

## Peer Connection Configuration

WebRTC peer connection settings.

### Parameters

#### iceServers

**Type:** `RTCIceServer[]`  
**Default:** Google STUN servers

STUN and TURN servers for NAT traversal.

**Example:**
```json
{
  "iceServers": [
    {
      "urls": "stun:stun.l.google.com:19302"
    },
    {
      "urls": "turn:turn.example.com:3478",
      "username": "user",
      "credential": "password"
    }
  ]
}
```

**Recommendation:**
- Always include at least one STUN server
- Include TURN servers for restrictive NAT environments
- Use multiple TURN servers for redundancy
- Consider geographic distribution of TURN servers


#### iceTransportPolicy

**Type:** `'all' | 'relay'`  
**Default:** `'all'`

ICE transport policy for connection establishment.

**Options:**
- `'all'`: Try direct connections first, fall back to TURN if needed (recommended)
- `'relay'`: Force all connections through TURN servers (for maximum privacy)

**Recommendation:**
- **Normal use:** `'all'` (better performance)
- **High security/privacy:** `'relay'` (all traffic through TURN)
- **Testing TURN:** `'relay'`

#### bundlePolicy

**Type:** `'balanced' | 'max-compat' | 'max-bundle'`  
**Default:** `'max-bundle'`

RTP bundle policy for media streams.

**Recommendation:** Use `'max-bundle'` for better security and performance.

#### rtcpMuxPolicy

**Type:** `'negotiate' | 'require'`  
**Default:** `'require'`

RTCP multiplexing policy.

**Recommendation:** Use `'require'` for better security.

---

## Connection Timeouts

Timeout values for connection establishment and recovery.

### Parameters

#### iceGatheringTimeoutMs

**Type:** `number` (milliseconds)  
**Default:** `10000` (10 seconds)  
**Environment Variable:** `RELAYMESH_ICE_GATHERING_TIMEOUT_MS`

Timeout for ICE candidate gathering.

**Recommendation:**
- **Fast networks:** 5000-10000 ms
- **Slow networks:** 15000-20000 ms
- **Mobile networks:** 15000-25000 ms

#### connectionEstablishmentTimeoutMs

**Type:** `number` (milliseconds)  
**Default:** `30000` (30 seconds)  
**Environment Variable:** `RELAYMESH_CONNECTION_ESTABLISHMENT_TIMEOUT_MS`

Timeout for complete connection establishment.

**Recommendation:**
- **Fast networks:** 20000-30000 ms
- **Slow networks:** 40000-60000 ms
- **Mobile networks:** 45000-60000 ms

#### reconnectionTimeoutMs

**Type:** `number` (milliseconds)  
**Default:** `5000` (5 seconds)  
**Environment Variable:** `RELAYMESH_RECONNECTION_TIMEOUT_MS`

Timeout for reconnection attempts.

**Recommendation:**
- **Stable networks:** 5000-10000 ms
- **Unstable networks:** 10000-15000 ms
- **Mobile networks:** 10000-20000 ms

---


## Server Configuration

Configuration for the RelayMesh signaling server.

### Parameters

#### port

**Type:** `number`  
**Default:** `8080`

Server listening port.

**Recommendation:**
- **Development:** 8080, 3000
- **Production (HTTP):** 80
- **Production (HTTPS):** 443, 8443

#### host

**Type:** `string`  
**Default:** `'0.0.0.0'`

Server listening host.

**Recommendation:**
- **Production:** `'0.0.0.0'` (all interfaces)
- **Development:** `'localhost'` or `'127.0.0.1'`

#### tlsEnabled

**Type:** `boolean`  
**Default:** `false`

Enable TLS/SSL encryption for signaling.

**Recommendation:**
- **Production:** `true` (always use TLS)
- **Development:** `false` (optional)

**Note:** Required for secure WebRTC in browsers (HTTPS pages require WSS).

#### tlsCertPath / tlsKeyPath

**Type:** `string`

Paths to TLS certificate and private key files.

**Example:**
```typescript
{
  tlsEnabled: true,
  tlsCertPath: '/etc/ssl/certs/server.crt',
  tlsKeyPath: '/etc/ssl/private/server.key'
}
```

#### authRequired

**Type:** `boolean`  
**Default:** `false`

Require authentication for conference access.

**Recommendation:**
- **Public conferences:** `false`
- **Private conferences:** `true`
- **Production:** `true` (recommended)

#### maxConferences

**Type:** `number`  
**Default:** `100`

Maximum number of concurrent conferences.

**Recommendation:**
- **Small deployments:** 10-50
- **Medium deployments:** 100-500
- **Large deployments:** 1000+

#### maxParticipantsPerConference

**Type:** `number`  
**Default:** `50`

Maximum participants per conference.

**Recommendation:**
- **Small conferences:** 10-20
- **Medium conferences:** 20-50
- **Large conferences:** 50-100

**Note:** Performance depends on relay node capacity and network conditions.

---


## Recommended Scenarios

### Scenario 1: Corporate Network (High Bandwidth, Restrictive NAT)

**Characteristics:**
- High bandwidth (100+ Mbps)
- Restrictive corporate firewalls
- Stable connections
- Desktop computers

**Configuration:**
```json
{
  "selection": {
    "bandwidthWeight": 0.25,
    "natWeight": 0.35,
    "latencyWeight": 0.20,
    "stabilityWeight": 0.10,
    "deviceWeight": 0.10,
    "minBandwidthMbps": 10,
    "maxParticipantsPerRelay": 7,
    "reevaluationIntervalMs": 45000
  },
  "peerConnection": {
    "iceServers": [
      { "urls": "stun:stun.example.com:3478" },
      { "urls": "turn:turn.example.com:3478", "username": "user", "credential": "pass" }
    ],
    "iceTransportPolicy": "all"
  },
  "connectionTimeouts": {
    "iceGatheringTimeoutMs": 15000,
    "connectionEstablishmentTimeoutMs": 40000,
    "reconnectionTimeoutMs": 10000
  }
}
```

**Rationale:**
- Higher NAT weight due to restrictive firewalls
- Higher min bandwidth due to available capacity
- Longer re-evaluation interval for stable networks
- TURN servers essential for NAT traversal

### Scenario 2: Home Networks (Mixed Bandwidth, Moderate NAT)

**Characteristics:**
- Variable bandwidth (10-100 Mbps)
- Moderate NAT restrictions
- Generally stable
- Mix of devices

**Configuration:**
```json
{
  "selection": {
    "bandwidthWeight": 0.30,
    "natWeight": 0.25,
    "latencyWeight": 0.20,
    "stabilityWeight": 0.15,
    "deviceWeight": 0.10,
    "minBandwidthMbps": 5,
    "maxParticipantsPerRelay": 5,
    "reevaluationIntervalMs": 30000
  },
  "peerConnection": {
    "iceServers": [
      { "urls": "stun:stun.l.google.com:19302" },
      { "urls": "stun:stun1.l.google.com:19302" }
    ],
    "iceTransportPolicy": "all"
  },
  "connectionTimeouts": {
    "iceGatheringTimeoutMs": 10000,
    "connectionEstablishmentTimeoutMs": 30000,
    "reconnectionTimeoutMs": 5000
  }
}
```

**Rationale:**
- Balanced weights for mixed conditions
- Standard min bandwidth for HD video
- Default timeouts work well
- STUN usually sufficient


### Scenario 3: Mobile Networks (Low Bandwidth, Variable Latency)

**Characteristics:**
- Limited bandwidth (1-20 Mbps)
- Variable latency and stability
- Battery constraints
- Frequent network changes

**Configuration:**
```json
{
  "selection": {
    "bandwidthWeight": 0.40,
    "natWeight": 0.20,
    "latencyWeight": 0.15,
    "stabilityWeight": 0.20,
    "deviceWeight": 0.05,
    "minBandwidthMbps": 3,
    "maxParticipantsPerRelay": 4,
    "reevaluationIntervalMs": 25000
  },
  "peerConnection": {
    "iceServers": [
      { "urls": "stun:stun.l.google.com:19302" },
      { "urls": "turn:turn.example.com:3478", "username": "user", "credential": "pass" }
    ],
    "iceTransportPolicy": "all"
  },
  "connectionTimeouts": {
    "iceGatheringTimeoutMs": 20000,
    "connectionEstablishmentTimeoutMs": 50000,
    "reconnectionTimeoutMs": 15000
  }
}
```

**Rationale:**
- High bandwidth weight (bandwidth is scarce)
- High stability weight (connections fluctuate)
- Lower min bandwidth for mobile constraints
- Fewer participants per relay
- Longer timeouts for slower networks
- TURN servers for mobile NAT

### Scenario 4: Geographically Distributed (High Latency)

**Characteristics:**
- Participants across continents
- High latency (100-300ms)
- Variable bandwidth
- Stable connections

**Configuration:**
```json
{
  "selection": {
    "bandwidthWeight": 0.25,
    "natWeight": 0.20,
    "latencyWeight": 0.30,
    "stabilityWeight": 0.15,
    "deviceWeight": 0.10,
    "minBandwidthMbps": 7,
    "maxParticipantsPerRelay": 6,
    "reevaluationIntervalMs": 40000
  },
  "peerConnection": {
    "iceServers": [
      { "urls": "stun:stun.l.google.com:19302" },
      { "urls": "turn:turn-us.example.com:3478", "username": "user", "credential": "pass" },
      { "urls": "turn:turn-eu.example.com:3478", "username": "user", "credential": "pass" },
      { "urls": "turn:turn-asia.example.com:3478", "username": "user", "credential": "pass" }
    ],
    "iceTransportPolicy": "all"
  },
  "connectionTimeouts": {
    "iceGatheringTimeoutMs": 15000,
    "connectionEstablishmentTimeoutMs": 45000,
    "reconnectionTimeoutMs": 10000
  }
}
```

**Rationale:**
- High latency weight (minimize latency impact)
- Multiple geographically distributed TURN servers
- Longer timeouts for high-latency connections
- Moderate re-evaluation interval


### Scenario 5: Audio-Only Conferences

**Characteristics:**
- Low bandwidth requirements
- Many participants possible
- Latency sensitive
- Stable connections

**Configuration:**
```json
{
  "selection": {
    "bandwidthWeight": 0.20,
    "natWeight": 0.25,
    "latencyWeight": 0.30,
    "stabilityWeight": 0.15,
    "deviceWeight": 0.10,
    "minBandwidthMbps": 1,
    "maxParticipantsPerRelay": 10,
    "reevaluationIntervalMs": 45000
  },
  "peerConnection": {
    "iceServers": [
      { "urls": "stun:stun.l.google.com:19302" }
    ],
    "iceTransportPolicy": "all"
  },
  "connectionTimeouts": {
    "iceGatheringTimeoutMs": 8000,
    "connectionEstablishmentTimeoutMs": 25000,
    "reconnectionTimeoutMs": 5000
  }
}
```

**Rationale:**
- Low bandwidth weight (audio uses little bandwidth)
- High latency weight (audio quality sensitive to latency)
- Very low min bandwidth (audio only needs ~100 kbps)
- More participants per relay (audio is lightweight)
- Shorter timeouts (audio connections faster)

---

## Performance Tuning

### Optimizing for Scale

**For conferences with 20+ participants:**

1. **Increase relay count:**
   - Lower `maxParticipantsPerRelay` to 4-5
   - Ensures better load distribution

2. **Adjust re-evaluation:**
   - Increase `reevaluationIntervalMs` to 45000-60000
   - Reduces signaling overhead

3. **Prioritize stability:**
   - Increase `stabilityWeight` to 0.20-0.25
   - Reduces relay churn

### Optimizing for Quality

**For high-quality video:**

1. **Increase bandwidth requirements:**
   - Set `minBandwidthMbps` to 15-20
   - Ensures relays can handle HD streams

2. **Prioritize bandwidth:**
   - Increase `bandwidthWeight` to 0.35-0.40
   - Selects best-connected relays

3. **Reduce participants per relay:**
   - Set `maxParticipantsPerRelay` to 3-4
   - Reduces load on each relay


### Optimizing for Unstable Networks

**For mobile or unstable connections:**

1. **Increase stability weight:**
   - Set `stabilityWeight` to 0.20-0.25
   - Prioritizes stable relays

2. **Shorter re-evaluation:**
   - Set `reevaluationIntervalMs` to 15000-20000
   - Responds faster to changes

3. **Longer timeouts:**
   - Increase all timeout values by 50-100%
   - Accommodates slower connections

4. **Add TURN servers:**
   - Essential for mobile NAT traversal
   - Use geographically close TURN servers

### Reducing Signaling Overhead

**For large-scale deployments:**

1. **Increase re-evaluation interval:**
   - Set `reevaluationIntervalMs` to 60000-90000
   - Reduces metrics broadcasts

2. **Increase stability weight:**
   - Reduces relay node changes
   - Fewer topology updates

3. **Optimize relay count:**
   - Use `sqrt(participants)` formula
   - Balances connections and overhead

---

## Troubleshooting

### Problem: Frequent Relay Changes

**Symptoms:**
- Relay nodes change frequently
- Topology updates every few seconds
- Connection instability

**Solutions:**
1. Increase `stabilityWeight` to 0.20-0.25
2. Increase `reevaluationIntervalMs` to 45000-60000
3. Add hysteresis to selection algorithm (custom implementation)

### Problem: Poor Video Quality

**Symptoms:**
- Pixelated or choppy video
- Frequent buffering
- High latency

**Solutions:**
1. Increase `minBandwidthMbps` to 10-15
2. Increase `bandwidthWeight` to 0.35-0.40
3. Reduce `maxParticipantsPerRelay` to 3-4
4. Check network conditions and TURN server performance

### Problem: Connection Failures

**Symptoms:**
- Participants can't connect
- Timeout errors
- ICE gathering failures

**Solutions:**
1. Add TURN servers to `iceServers` configuration
2. Increase timeout values by 50-100%
3. Check firewall and NAT configuration
4. Verify STUN/TURN server accessibility
5. Consider using `iceTransportPolicy: 'relay'` for testing


### Problem: High CPU Usage on Relays

**Symptoms:**
- Relay nodes show high CPU usage
- Device metrics degrading
- Relay demotions

**Solutions:**
1. Reduce `maxParticipantsPerRelay` to 3-4
2. Increase `deviceWeight` to 0.15-0.20
3. Ensure hardware acceleration is enabled
4. Consider adding more relay nodes

### Problem: Participants Behind Symmetric NAT

**Symptoms:**
- Some participants can't establish direct connections
- All connections go through TURN
- High TURN server load

**Solutions:**
1. Ensure TURN servers are configured and accessible
2. Reduce `natWeight` to 0.15-0.20 (don't over-penalize)
3. Consider dedicated TURN servers for symmetric NAT users
4. Use `iceTransportPolicy: 'relay'` if direct connections impossible

### Problem: Slow Connection Establishment

**Symptoms:**
- Long time to join conference (>30 seconds)
- ICE gathering takes too long
- Timeout errors

**Solutions:**
1. Increase `iceGatheringTimeoutMs` to 15000-20000
2. Increase `connectionEstablishmentTimeoutMs` to 45000-60000
3. Add more STUN servers for redundancy
4. Check network latency to STUN/TURN servers
5. Optimize TURN server placement (geographically closer)

---

## Configuration Validation

RelayMesh validates all configuration values and throws `ConfigValidationError` for invalid settings.

### Common Validation Errors

**Weights don't sum to 1.0:**
```
ConfigValidationError: weights must sum to approximately 1.0 (value: 0.85)
```
**Solution:** Ensure all five weights sum to 1.0 (±0.01)

**Invalid bandwidth threshold:**
```
ConfigValidationError: minBandwidthMbps unreasonably high (>100 Mbps) (value: 150)
```
**Solution:** Use realistic bandwidth values (0-100 Mbps)

**Invalid participant count:**
```
ConfigValidationError: maxParticipantsPerRelay must be at least 1 (value: 0)
```
**Solution:** Use positive values for participant limits

**Invalid timeout:**
```
ConfigValidationError: reevaluationIntervalMs must be at least 1000ms (value: 500)
```
**Solution:** Use minimum 1000ms for all timeout values

---

## Best Practices

1. **Start with defaults:** Use default configuration and adjust based on monitoring
2. **Test thoroughly:** Test configuration changes in staging before production
3. **Monitor metrics:** Track relay selection, topology changes, and connection quality
4. **Document changes:** Keep records of configuration changes and their effects
5. **Use environment variables:** For deployment-specific settings (TURN credentials, etc.)
6. **Version control:** Store configuration files in version control
7. **Gradual tuning:** Make small adjustments and measure impact
8. **Consider users:** Balance performance with user experience
9. **Plan for scale:** Configure for expected peak load, not average
10. **Security first:** Always use TLS in production, require authentication

---

## See Also

- [API Documentation](./API.md) - Complete API reference
- [Deployment Guide](./DEPLOYMENT.md) - Server setup and deployment
- [Examples](../examples/) - Example configurations and applications
