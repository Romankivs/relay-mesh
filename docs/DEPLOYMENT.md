# RelayMesh Deployment Guide

## Overview

This guide covers deploying RelayMesh signaling servers and integrating clients into applications. It includes server setup, security best practices, monitoring, and production deployment strategies.

## Table of Contents

- [Server Deployment](#server-deployment)
- [Client Integration](#client-integration)
- [Security Best Practices](#security-best-practices)
- [Monitoring and Logging](#monitoring-and-logging)
- [Scaling and High Availability](#scaling-and-high-availability)
- [Troubleshooting](#troubleshooting)
- [Production Checklist](#production-checklist)

---

## Server Deployment

### Prerequisites

- Node.js 16+ or 18+ (LTS recommended)
- npm or yarn package manager
- TLS certificate and private key (for production)
- Firewall access for WebSocket port
- (Optional) TURN server for NAT traversal

### Installation

#### 1. Install RelayMesh

```bash
npm install relay-mesh
# or
yarn add relay-mesh
```

#### 2. Create Server Script

Create `server.js`:

```javascript
const { createServer } = require('relay-mesh');

async function main() {
  const server = await createServer({
    port: 8443,
    host: '0.0.0.0',
    tlsEnabled: true,
    tlsCertPath: '/etc/ssl/certs/server.crt',
    tlsKeyPath: '/etc/ssl/private/server.key',
    authRequired: true,
    maxConferences: 100,
    maxParticipantsPerConference: 50
  });

  console.log('RelayMesh server started');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await server.stop();
    process.exit(0);
  });
}

main().catch(console.error);
```

#### 3. Run Server

```bash
node server.js
```

### TLS Certificate Setup

#### Option 1: Let's Encrypt (Recommended for Production)

```bash
# Install certbot
sudo apt-get install certbot

# Obtain certificate
sudo certbot certonly --standalone -d signaling.example.com

# Certificates will be in:
# /etc/letsencrypt/live/signaling.example.com/fullchain.pem
# /etc/letsencrypt/live/signaling.example.com/privkey.pem
```

Update server configuration:
```javascript
{
  tlsCertPath: '/etc/letsencrypt/live/signaling.example.com/fullchain.pem',
  tlsKeyPath: '/etc/letsencrypt/live/signaling.example.com/privkey.pem'
}
```


#### Option 2: Self-Signed Certificate (Development Only)

```bash
# Generate self-signed certificate
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes

# Use in configuration
{
  tlsCertPath: './cert.pem',
  tlsKeyPath: './key.pem'
}
```

**Warning:** Self-signed certificates should only be used for development. Browsers will show security warnings.

### Firewall Configuration

Open the WebSocket port:

```bash
# UFW (Ubuntu)
sudo ufw allow 8443/tcp

# iptables
sudo iptables -A INPUT -p tcp --dport 8443 -j ACCEPT

# firewalld (CentOS/RHEL)
sudo firewall-cmd --permanent --add-port=8443/tcp
sudo firewall-cmd --reload
```

### Process Management

#### Using PM2 (Recommended)

```bash
# Install PM2
npm install -g pm2

# Start server
pm2 start server.js --name relaymesh-server

# Configure auto-restart on system boot
pm2 startup
pm2 save

# Monitor
pm2 status
pm2 logs relaymesh-server

# Restart
pm2 restart relaymesh-server

# Stop
pm2 stop relaymesh-server
```

#### Using systemd

Create `/etc/systemd/system/relaymesh.service`:

```ini
[Unit]
Description=RelayMesh Signaling Server
After=network.target

[Service]
Type=simple
User=relaymesh
WorkingDirectory=/opt/relaymesh
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=relaymesh

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable relaymesh
sudo systemctl start relaymesh
sudo systemctl status relaymesh
```

### Docker Deployment

Create `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application
COPY . .

# Expose port
EXPOSE 8443

# Run server
CMD ["node", "server.js"]
```

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  relaymesh:
    build: .
    ports:
      - "8443:8443"
    volumes:
      - ./certs:/etc/ssl/certs:ro
      - ./config.json:/app/config.json:ro
    environment:
      - NODE_ENV=production
      - RELAYMESH_MIN_BANDWIDTH_MBPS=5
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Build and run:

```bash
docker-compose up -d
docker-compose logs -f
```


---

## Client Integration

### Web Application Integration

#### 1. Install Client Library

```bash
npm install relay-mesh
# or
yarn add relay-mesh
```

#### 2. Basic Integration

```javascript
import { RelayMeshClient } from 'relay-mesh';

// Create client
const client = new RelayMeshClient({
  signalingServerUrl: 'wss://signaling.example.com:8443',
  participantName: 'User Name'
});

// Handle events
client.on('remoteStream', (stream) => {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  document.getElementById('videos').appendChild(video);
});

client.on('roleChange', (role) => {
  console.log(`My role: ${role}`);
  document.getElementById('role').textContent = role;
});

// Join conference
async function joinConference(conferenceId) {
  try {
    const info = await client.joinConference(conferenceId);
    console.log('Joined conference:', info);
  } catch (error) {
    console.error('Failed to join:', error);
  }
}

// Leave conference
async function leaveConference() {
  try {
    await client.leaveConference();
    console.log('Left conference');
  } catch (error) {
    console.error('Failed to leave:', error);
  }
}
```

#### 3. React Integration

```jsx
import React, { useEffect, useState, useRef } from 'react';
import { RelayMeshClient } from 'relay-mesh';

function VideoConference({ conferenceId, userName }) {
  const [client] = useState(() => new RelayMeshClient({
    signalingServerUrl: 'wss://signaling.example.com:8443',
    participantName: userName
  }));
  const [role, setRole] = useState('regular');
  const [streams, setStreams] = useState([]);
  const videosRef = useRef(null);

  useEffect(() => {
    // Setup event handlers
    client.on('roleChange', setRole);
    
    client.on('remoteStream', (stream) => {
      setStreams(prev => [...prev, stream]);
    });

    // Join conference
    client.joinConference(conferenceId);

    // Cleanup
    return () => {
      client.leaveConference();
    };
  }, [client, conferenceId]);

  return (
    <div>
      <div>Role: {role}</div>
      <div ref={videosRef}>
        {streams.map((stream, idx) => (
          <video
            key={idx}
            autoPlay
            ref={el => el && (el.srcObject = stream)}
          />
        ))}
      </div>
    </div>
  );
}
```

### Mobile Application Integration

#### React Native

```javascript
import { RelayMeshClient } from 'relay-mesh';
import { RTCView } from 'react-native-webrtc';

// Similar to web integration
const client = new RelayMeshClient({
  signalingServerUrl: 'wss://signaling.example.com:8443',
  participantName: 'Mobile User'
});

// Render video streams
<RTCView streamURL={stream.toURL()} />
```

### Electron Integration

```javascript
const { RelayMeshClient } = require('relay-mesh');

// Same as web integration
const client = new RelayMeshClient({
  signalingServerUrl: 'wss://signaling.example.com:8443',
  participantName: 'Desktop User'
});
```


---

## Security Best Practices

### 1. Always Use TLS in Production

**Why:** Browsers require secure contexts (HTTPS) for WebRTC. Unencrypted signaling is vulnerable to eavesdropping and tampering.

**Implementation:**
```javascript
{
  tlsEnabled: true,
  tlsCertPath: '/path/to/cert.pem',
  tlsKeyPath: '/path/to/key.pem'
}
```

### 2. Enable Authentication

**Why:** Prevents unauthorized access to conferences.

**Implementation:**

Create custom auth provider:

```javascript
class TokenAuthProvider {
  async authenticate(token) {
    // Verify JWT token
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      return {
        authenticated: true,
        participantId: decoded.sub,
        participantName: decoded.name
      };
    } catch (error) {
      return { authenticated: false };
    }
  }
}

const server = await createServer({
  authRequired: true,
  authProvider: new TokenAuthProvider()
});
```

Client-side:

```javascript
const client = new RelayMeshClient({
  signalingServerUrl: 'wss://signaling.example.com:8443',
  participantName: 'User',
  authToken: 'your-jwt-token'
});
```

### 3. Use TURN Servers with Authentication

**Why:** Prevents unauthorized use of TURN servers (bandwidth costs).

**Implementation:**

```javascript
{
  peerConnectionConfig: {
    iceServers: [
      { urls: 'stun:stun.example.com:3478' },
      {
        urls: 'turn:turn.example.com:3478',
        username: 'user',
        credential: 'password'
      }
    ]
  }
}
```

**Best Practice:** Generate time-limited TURN credentials:

```javascript
// Server-side: Generate temporary TURN credentials
function generateTurnCredentials(username) {
  const timestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const turnUsername = `${timestamp}:${username}`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(turnUsername);
  const turnPassword = hmac.digest('base64');
  
  return { username: turnUsername, credential: turnPassword };
}
```

### 4. Implement Rate Limiting

**Why:** Prevents abuse and DoS attacks.

**Implementation:**

```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use('/api/', limiter);
```

### 5. Validate Input

**Why:** Prevents injection attacks and malformed data.

**Implementation:**

```javascript
function validateConferenceId(id) {
  if (typeof id !== 'string' || id.length > 100) {
    throw new Error('Invalid conference ID');
  }
  if (!/^[a-zA-Z0-9-_]+$/.test(id)) {
    throw new Error('Conference ID contains invalid characters');
  }
  return id;
}
```


### 6. Secure WebSocket Connections

**Why:** Prevents connection hijacking and man-in-the-middle attacks.

**Best Practices:**
- Always use WSS (WebSocket Secure) in production
- Validate origin headers
- Implement connection timeouts
- Use secure session management

```javascript
// Validate origin
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  const allowedOrigins = ['https://app.example.com'];
  
  if (!allowedOrigins.includes(origin)) {
    ws.close(1008, 'Unauthorized origin');
    return;
  }
});
```

### 7. Implement Conference Access Control

**Why:** Ensures only authorized participants can join specific conferences.

**Implementation:**

```javascript
class ConferenceAccessControl {
  async canJoin(participantId, conferenceId) {
    // Check database or cache
    const conference = await db.getConference(conferenceId);
    if (!conference) return false;
    
    // Check if participant is invited
    return conference.participants.includes(participantId);
  }
}
```

### 8. Enable Logging and Auditing

**Why:** Track security events and troubleshoot issues.

**Implementation:**

```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Log security events
logger.info('Authentication attempt', {
  participantId,
  success: true,
  timestamp: Date.now()
});
```

### 9. Keep Dependencies Updated

**Why:** Security vulnerabilities are regularly discovered and patched.

```bash
# Check for vulnerabilities
npm audit

# Update dependencies
npm update

# Fix vulnerabilities
npm audit fix
```

### 10. Use Environment Variables for Secrets

**Why:** Prevents hardcoding sensitive information.

```javascript
// .env file
JWT_SECRET=your-secret-key
TURN_SECRET=your-turn-secret
DB_PASSWORD=your-db-password

// Load in application
require('dotenv').config();

const jwtSecret = process.env.JWT_SECRET;
```

**Never commit `.env` files to version control!**

---

## Monitoring and Logging

### Server Monitoring

#### Health Check Endpoint

```javascript
const express = require('express');
const app = express();

app.get('/health', (req, res) => {
  const status = server.getStatus();
  res.json({
    status: 'ok',
    uptime: status.uptime,
    conferences: status.conferences,
    participants: status.participants
  });
});

app.listen(3000);
```

#### Metrics Collection

```javascript
const prometheus = require('prom-client');

// Create metrics
const activeConferences = new prometheus.Gauge({
  name: 'relaymesh_active_conferences',
  help: 'Number of active conferences'
});

const activeParticipants = new prometheus.Gauge({
  name: 'relaymesh_active_participants',
  help: 'Number of active participants'
});

// Update metrics
setInterval(() => {
  const status = server.getStatus();
  activeConferences.set(status.conferences);
  activeParticipants.set(status.participants);
}, 10000);

// Expose metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prometheus.register.contentType);
  res.end(await prometheus.register.metrics());
});
```


### Logging Best Practices

#### Structured Logging

```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log' 
    })
  ]
});

// Log important events
logger.info('Participant joined', {
  conferenceId,
  participantId,
  role: 'regular'
});

logger.warn('Relay node demoted', {
  relayId,
  reason: 'low bandwidth',
  metrics: { uploadMbps: 3.2 }
});

logger.error('Connection failed', {
  participantId,
  error: error.message,
  stack: error.stack
});
```

#### Log Rotation

```javascript
const winston = require('winston');
require('winston-daily-rotate-file');

const transport = new winston.transports.DailyRotateFile({
  filename: 'logs/relaymesh-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d'
});

const logger = winston.createLogger({
  transports: [transport]
});
```

### Alerting

#### Email Alerts

```javascript
const nodemailer = require('nodemailer');

async function sendAlert(subject, message) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: 'alerts@example.com',
    to: 'admin@example.com',
    subject,
    text: message
  });
}

// Alert on critical errors
server.on('error', (error) => {
  logger.error('Server error', { error });
  sendAlert('RelayMesh Server Error', error.message);
});
```

#### Slack Alerts

```javascript
const axios = require('axios');

async function sendSlackAlert(message) {
  await axios.post(process.env.SLACK_WEBHOOK_URL, {
    text: message,
    username: 'RelayMesh Monitor',
    icon_emoji: ':warning:'
  });
}

// Monitor server health
setInterval(async () => {
  const status = server.getStatus();
  if (status.participants > 1000) {
    await sendSlackAlert(`High load: ${status.participants} participants`);
  }
}, 60000);
```

---

## Scaling and High Availability

### Horizontal Scaling

RelayMesh signaling servers can be scaled horizontally using a load balancer.

#### Load Balancer Configuration (nginx)

```nginx
upstream relaymesh_servers {
    least_conn;
    server 10.0.1.10:8443;
    server 10.0.1.11:8443;
    server 10.0.1.12:8443;
}

server {
    listen 443 ssl;
    server_name signaling.example.com;

    ssl_certificate /etc/ssl/certs/server.crt;
    ssl_certificate_key /etc/ssl/private/server.key;

    location / {
        proxy_pass https://relaymesh_servers;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```


### Database for State Persistence

For multi-server deployments, use Redis for shared state:

```javascript
const Redis = require('ioredis');
const redis = new Redis({
  host: 'redis.example.com',
  port: 6379,
  password: process.env.REDIS_PASSWORD
});

// Store conference state
async function saveConferenceState(conferenceId, topology) {
  await redis.set(
    `conference:${conferenceId}`,
    JSON.stringify(topology),
    'EX',
    3600 // 1 hour expiry
  );
}

// Retrieve conference state
async function getConferenceState(conferenceId) {
  const data = await redis.get(`conference:${conferenceId}`);
  return data ? JSON.parse(data) : null;
}
```

### Auto-Scaling

#### AWS Auto Scaling Group

```yaml
# CloudFormation template
Resources:
  RelayMeshASG:
    Type: AWS::AutoScaling::AutoScalingGroup
    Properties:
      MinSize: 2
      MaxSize: 10
      DesiredCapacity: 3
      TargetGroupARNs:
        - !Ref RelayMeshTargetGroup
      LaunchTemplate:
        LaunchTemplateId: !Ref RelayMeshLaunchTemplate
        Version: !GetAtt RelayMeshLaunchTemplate.LatestVersionNumber
      MetricsCollection:
        - Granularity: 1Minute

  ScaleUpPolicy:
    Type: AWS::AutoScaling::ScalingPolicy
    Properties:
      AutoScalingGroupName: !Ref RelayMeshASG
      PolicyType: TargetTrackingScaling
      TargetTrackingConfiguration:
        PredefinedMetricSpecification:
          PredefinedMetricType: ASGAverageCPUUtilization
        TargetValue: 70.0
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: relaymesh-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: relaymesh
  template:
    metadata:
      labels:
        app: relaymesh
    spec:
      containers:
      - name: relaymesh
        image: your-registry/relaymesh:latest
        ports:
        - containerPort: 8443
        env:
        - name: NODE_ENV
          value: "production"
        - name: REDIS_HOST
          value: "redis-service"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: relaymesh-service
spec:
  type: LoadBalancer
  ports:
  - port: 443
    targetPort: 8443
    protocol: TCP
  selector:
    app: relaymesh
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: relaymesh-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: relaymesh-server
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

---


## Troubleshooting

### Common Issues

#### Issue: WebSocket Connection Fails

**Symptoms:**
- Client can't connect to server
- "Connection refused" errors
- Timeout errors

**Solutions:**
1. Check server is running: `systemctl status relaymesh`
2. Verify firewall allows port: `sudo ufw status`
3. Check TLS certificate is valid: `openssl s_client -connect signaling.example.com:8443`
4. Verify DNS resolves correctly: `nslookup signaling.example.com`
5. Check server logs: `journalctl -u relaymesh -f`

#### Issue: High Memory Usage

**Symptoms:**
- Server memory usage grows over time
- Out of memory errors
- Server crashes

**Solutions:**
1. Check for memory leaks in application code
2. Implement connection limits
3. Add memory monitoring and alerts
4. Increase server memory or scale horizontally
5. Review and optimize conference state storage

#### Issue: Participants Can't Hear/See Each Other

**Symptoms:**
- Connections established but no media
- One-way audio/video
- Black screens

**Solutions:**
1. Check WebRTC peer connections are established
2. Verify STUN/TURN servers are accessible
3. Check firewall allows UDP traffic for media
4. Verify media permissions in browser
5. Check relay node is forwarding packets correctly
6. Review browser console for WebRTC errors

#### Issue: Frequent Disconnections

**Symptoms:**
- Participants randomly disconnect
- "Connection lost" messages
- Reconnection loops

**Solutions:**
1. Check network stability
2. Increase connection timeouts
3. Verify WebSocket keep-alive is working
4. Check server resource usage (CPU, memory)
5. Review server logs for errors
6. Implement exponential backoff for reconnections

### Debug Mode

Enable debug logging:

```javascript
// Server
const server = await createServer({
  logLevel: 'debug'
});

// Client
const client = new RelayMeshClient({
  signalingServerUrl: 'wss://signaling.example.com:8443',
  participantName: 'User',
  debug: true
});
```

### Performance Profiling

```javascript
// Enable Node.js profiling
node --prof server.js

// After running, process the profile
node --prof-process isolate-*.log > profile.txt
```

---

## Production Checklist

### Pre-Deployment

- [ ] TLS certificates obtained and configured
- [ ] Authentication system implemented and tested
- [ ] TURN servers configured with authentication
- [ ] Firewall rules configured
- [ ] Environment variables set
- [ ] Configuration file reviewed
- [ ] Logging configured
- [ ] Monitoring and alerting set up
- [ ] Backup and recovery plan in place
- [ ] Load testing completed
- [ ] Security audit performed

### Deployment

- [ ] Deploy to staging environment first
- [ ] Run integration tests
- [ ] Verify all services are running
- [ ] Check health endpoints
- [ ] Monitor logs for errors
- [ ] Test client connections
- [ ] Verify media flows correctly
- [ ] Test failover scenarios
- [ ] Document deployment process

### Post-Deployment

- [ ] Monitor server metrics
- [ ] Check error rates
- [ ] Verify performance meets SLAs
- [ ] Review logs for issues
- [ ] Test from different networks
- [ ] Gather user feedback
- [ ] Plan for scaling if needed
- [ ] Schedule regular maintenance


### Security Checklist

- [ ] TLS enabled for all connections
- [ ] Authentication required
- [ ] TURN servers use authentication
- [ ] Rate limiting implemented
- [ ] Input validation in place
- [ ] Origin validation configured
- [ ] Secrets stored in environment variables
- [ ] Dependencies updated and audited
- [ ] Logging and auditing enabled
- [ ] Access control implemented
- [ ] Regular security updates scheduled

### Monitoring Checklist

- [ ] Health check endpoint configured
- [ ] Metrics collection enabled
- [ ] Log aggregation set up
- [ ] Alerting configured
- [ ] Dashboard created
- [ ] Performance baselines established
- [ ] SLA monitoring in place
- [ ] Incident response plan documented

---

## Performance Optimization

### Server Optimization

1. **Enable HTTP/2:**
```javascript
const http2 = require('http2');
const server = http2.createSecureServer({
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
});
```

2. **Use Connection Pooling:**
```javascript
const pool = new Pool({
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});
```

3. **Enable Compression:**
```javascript
const compression = require('compression');
app.use(compression());
```

4. **Optimize Node.js:**
```bash
# Increase memory limit
node --max-old-space-size=4096 server.js

# Enable performance optimizations
node --optimize-for-size server.js
```

### Client Optimization

1. **Lazy Load Components:**
```javascript
const RelayMeshClient = lazy(() => import('relay-mesh'));
```

2. **Optimize Video Constraints:**
```javascript
const constraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  },
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 }
  }
};
```

3. **Implement Adaptive Bitrate:**
```javascript
client.on('networkQualityChange', (quality) => {
  if (quality === 'poor') {
    // Reduce video quality
    mediaHandler.adaptBitrate(peerConnection, 500000); // 500 kbps
  }
});
```

---

## Backup and Recovery

### Configuration Backup

```bash
# Backup configuration
tar -czf config-backup-$(date +%Y%m%d).tar.gz \
  /opt/relaymesh/config.json \
  /etc/ssl/certs/server.crt \
  /etc/ssl/private/server.key

# Restore configuration
tar -xzf config-backup-20240101.tar.gz -C /
```

### Database Backup (if using Redis)

```bash
# Backup Redis
redis-cli SAVE
cp /var/lib/redis/dump.rdb /backup/redis-$(date +%Y%m%d).rdb

# Restore Redis
systemctl stop redis
cp /backup/redis-20240101.rdb /var/lib/redis/dump.rdb
systemctl start redis
```

### Disaster Recovery Plan

1. **Document Recovery Procedures:**
   - Server rebuild steps
   - Configuration restoration
   - Certificate renewal process
   - Database recovery

2. **Test Recovery Regularly:**
   - Schedule quarterly DR tests
   - Document test results
   - Update procedures based on findings

3. **Maintain Redundancy:**
   - Multiple server instances
   - Geographic distribution
   - Backup TURN servers
   - Redundant monitoring

---

## See Also

- [API Documentation](./API.md) - Complete API reference
- [Configuration Guide](./CONFIGURATION.md) - Detailed configuration options
- [Examples](../examples/) - Example applications and configurations
