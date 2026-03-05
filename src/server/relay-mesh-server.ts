// Main server application entry point for RelayMesh
import { SignalingServer } from './signaling-server';
import type { SignalingServerConfig } from './signaling-server';
import type { AuthProvider } from '../shared/auth';
import { EventEmitter } from 'events';

export interface RelayMeshServerConfig {
  port?: number;
  host?: string;
  tlsEnabled?: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  authRequired?: boolean;
  authProvider?: AuthProvider;
  maxConferences?: number;
  maxParticipantsPerConference?: number;
}

export interface ServerInfo {
  port: number;
  host: string;
  tlsEnabled: boolean;
  activeConferences: number;
  totalParticipants: number;
  uptime: number;
}

export class RelayMeshServer extends EventEmitter {
  private signalingServer: SignalingServer;
  private config: RelayMeshServerConfig;
  private startTime: number = 0;
  private isRunning: boolean = false;

  constructor(config: RelayMeshServerConfig = {}) {
    super();
    this.config = {
      port: 8080,
      host: '0.0.0.0',
      tlsEnabled: false,
      authRequired: false,
      maxConferences: 100,
      maxParticipantsPerConference: 50,
      ...config,
    };

    // Build signaling server config
    const signalingConfig: SignalingServerConfig = {
      port: this.config.port!,
      enforceTLS: this.config.tlsEnabled,
      requireAuth: this.config.authRequired,
      authProvider: this.config.authProvider,
    };

    // Add TLS options if enabled
    if (this.config.tlsEnabled && this.config.tlsCertPath && this.config.tlsKeyPath) {
      const fs = require('fs');
      signalingConfig.tlsOptions = {
        key: fs.readFileSync(this.config.tlsKeyPath),
        cert: fs.readFileSync(this.config.tlsCertPath),
      };
    }

    this.signalingServer = new SignalingServer(signalingConfig);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Server is already running');
    }

    try {
      await this.signalingServer.start();
      this.startTime = Date.now();
      this.isRunning = true;

      const serverInfo = this.signalingServer.getServerInfo();
      this.emit('started', {
        port: serverInfo.port,
        host: this.config.host,
        tlsEnabled: serverInfo.tlsEnabled,
      });

      console.log(`RelayMesh server started on ${this.config.host}:${serverInfo.port}`);
      console.log(`TLS: ${serverInfo.tlsEnabled ? 'enabled' : 'disabled'}`);
      console.log(`Authentication: ${this.config.authRequired ? 'required' : 'optional'}`);
    } catch (error) {
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Server is not running');
    }

    try {
      await this.signalingServer.stop();
      this.isRunning = false;
      this.emit('stopped');
      console.log('RelayMesh server stopped');
    } catch (error) {
      throw error;
    }
  }

  getServerInfo(): ServerInfo {
    const signalingInfo = this.signalingServer.getServerInfo();
    
    return {
      port: signalingInfo.port,
      host: this.config.host!,
      tlsEnabled: signalingInfo.tlsEnabled,
      activeConferences: signalingInfo.activeConferences,
      totalParticipants: signalingInfo.activeConnections,
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
    };
  }

  getConferenceInfo(conferenceId: string): {
    topology: any | null;
    participants: string[];
  } {
    return {
      topology: this.signalingServer.getConferenceTopology(conferenceId),
      participants: this.signalingServer.getConferenceParticipants(conferenceId),
    };
  }

  isParticipantConnected(participantId: string): boolean {
    return this.signalingServer.isParticipantConnected(participantId);
  }

  isParticipantAuthenticated(participantId: string): boolean {
    return this.signalingServer.isParticipantAuthenticated(participantId);
  }

  getStatus(): {
    running: boolean;
    uptime: number;
    conferences: number;
    participants: number;
  } {
    const info = this.getServerInfo();
    return {
      running: this.isRunning,
      uptime: info.uptime,
      conferences: info.activeConferences,
      participants: info.totalParticipants,
    };
  }
}

// Export a convenience function to create and start a server
export async function createServer(config?: RelayMeshServerConfig): Promise<RelayMeshServer> {
  const server = new RelayMeshServer(config);
  await server.start();
  return server;
}
