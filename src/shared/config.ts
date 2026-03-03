// Configuration interfaces and defaults

import { SelectionConfig, PeerConnectionConfig } from './types';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Default Configuration Values (Task 2.3)
// ============================================================================

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  bandwidthWeight: 0.30,
  natWeight: 0.25,
  latencyWeight: 0.20,
  stabilityWeight: 0.15,
  deviceWeight: 0.10,
  minBandwidthMbps: 5,
  maxParticipantsPerRelay: 5,
  reevaluationIntervalMs: 30000,
};

export const DEFAULT_PEER_CONNECTION_CONFIG: PeerConnectionConfig = {
  iceServers: [
    {
      urls: 'stun:stun.l.google.com:19302',
    },
    {
      urls: 'stun:stun1.l.google.com:19302',
    },
  ],
  iceTransportPolicy: 'all',
  // Security-focused defaults (Task 14.1, Requirement 12.1)
  bundlePolicy: 'max-bundle', // Bundle all media on single transport for better security
  rtcpMuxPolicy: 'require', // Multiplex RTP and RTCP for security
};

// ============================================================================
// Configuration Management System (Task 16.1)
// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
// ============================================================================

/**
 * Complete RelayMesh configuration
 */
export interface RelayMeshConfig {
  selection: SelectionConfig;
  peerConnection: PeerConnectionConfig;
  connectionTimeouts?: {
    iceGatheringTimeoutMs?: number;
    connectionEstablishmentTimeoutMs?: number;
    reconnectionTimeoutMs?: number;
  };
}

/**
 * Partial configuration for loading from sources
 */
export interface PartialRelayMeshConfig {
  selection?: Partial<SelectionConfig>;
  peerConnection?: Partial<PeerConnectionConfig>;
  connectionTimeouts?: {
    iceGatheringTimeoutMs?: number;
    connectionEstablishmentTimeoutMs?: number;
    reconnectionTimeoutMs?: number;
  };
}

/**
 * Validation error for configuration values
 */
export class ConfigValidationError extends Error {
  constructor(
    public field: string,
    public value: any,
    public reason: string
  ) {
    super(`Configuration validation failed for ${field}: ${reason} (value: ${value})`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates SelectionConfig values
 * Requirement 13.1, 13.2, 13.3, 13.4, 13.5
 */
function validateSelectionConfig(config: Partial<SelectionConfig>): void {
  // Validate weights (should sum to ~1.0 and be between 0 and 1)
  const weights = [
    config.bandwidthWeight,
    config.natWeight,
    config.latencyWeight,
    config.stabilityWeight,
    config.deviceWeight,
  ].filter((w) => w !== undefined) as number[];

  for (const weight of weights) {
    if (weight < 0 || weight > 1) {
      throw new ConfigValidationError('weight', weight, 'must be between 0 and 1');
    }
  }

  // If all weights are provided, check they sum to approximately 1.0
  if (weights.length === 5) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1.0) > 0.01) {
      throw new ConfigValidationError(
        'weights',
        sum,
        'all weights must sum to approximately 1.0'
      );
    }
  }

  // Validate minBandwidthMbps (Requirement 13.1)
  if (config.minBandwidthMbps !== undefined) {
    if (config.minBandwidthMbps < 0) {
      throw new ConfigValidationError(
        'minBandwidthMbps',
        config.minBandwidthMbps,
        'must be non-negative'
      );
    }
    if (config.minBandwidthMbps > 100) {
      throw new ConfigValidationError(
        'minBandwidthMbps',
        config.minBandwidthMbps,
        'unreasonably high (>100 Mbps)'
      );
    }
  }

  // Validate maxParticipantsPerRelay (Requirement 13.2)
  if (config.maxParticipantsPerRelay !== undefined) {
    if (config.maxParticipantsPerRelay < 1) {
      throw new ConfigValidationError(
        'maxParticipantsPerRelay',
        config.maxParticipantsPerRelay,
        'must be at least 1'
      );
    }
    if (config.maxParticipantsPerRelay > 20) {
      throw new ConfigValidationError(
        'maxParticipantsPerRelay',
        config.maxParticipantsPerRelay,
        'unreasonably high (>20)'
      );
    }
  }

  // Validate reevaluationIntervalMs (Requirement 13.4)
  if (config.reevaluationIntervalMs !== undefined) {
    if (config.reevaluationIntervalMs < 1000) {
      throw new ConfigValidationError(
        'reevaluationIntervalMs',
        config.reevaluationIntervalMs,
        'must be at least 1000ms'
      );
    }
    if (config.reevaluationIntervalMs > 300000) {
      throw new ConfigValidationError(
        'reevaluationIntervalMs',
        config.reevaluationIntervalMs,
        'unreasonably high (>5 minutes)'
      );
    }
  }
}

/**
 * Validates connection timeout configuration
 * Requirement 13.5
 */
function validateConnectionTimeouts(timeouts: Partial<RelayMeshConfig['connectionTimeouts']>): void {
  if (!timeouts) return;

  if (timeouts.iceGatheringTimeoutMs !== undefined) {
    if (timeouts.iceGatheringTimeoutMs < 1000) {
      throw new ConfigValidationError(
        'iceGatheringTimeoutMs',
        timeouts.iceGatheringTimeoutMs,
        'must be at least 1000ms'
      );
    }
  }

  if (timeouts.connectionEstablishmentTimeoutMs !== undefined) {
    if (timeouts.connectionEstablishmentTimeoutMs < 1000) {
      throw new ConfigValidationError(
        'connectionEstablishmentTimeoutMs',
        timeouts.connectionEstablishmentTimeoutMs,
        'must be at least 1000ms'
      );
    }
  }

  if (timeouts.reconnectionTimeoutMs !== undefined) {
    if (timeouts.reconnectionTimeoutMs < 1000) {
      throw new ConfigValidationError(
        'reconnectionTimeoutMs',
        timeouts.reconnectionTimeoutMs,
        'must be at least 1000ms'
      );
    }
  }
}

/**
 * Loads configuration from environment variables
 * Requirement 13.1, 13.2, 13.3, 13.4, 13.5
 */
function loadConfigFromEnv(): PartialRelayMeshConfig {
  const config: PartialRelayMeshConfig = {};
  const selection: Partial<SelectionConfig> = {};
  const connectionTimeouts: Partial<NonNullable<RelayMeshConfig['connectionTimeouts']>> = {};

  // Load selection config from environment
  if (process.env.RELAYMESH_BANDWIDTH_WEIGHT) {
    selection.bandwidthWeight = parseFloat(process.env.RELAYMESH_BANDWIDTH_WEIGHT);
  }
  if (process.env.RELAYMESH_NAT_WEIGHT) {
    selection.natWeight = parseFloat(process.env.RELAYMESH_NAT_WEIGHT);
  }
  if (process.env.RELAYMESH_LATENCY_WEIGHT) {
    selection.latencyWeight = parseFloat(process.env.RELAYMESH_LATENCY_WEIGHT);
  }
  if (process.env.RELAYMESH_STABILITY_WEIGHT) {
    selection.stabilityWeight = parseFloat(process.env.RELAYMESH_STABILITY_WEIGHT);
  }
  if (process.env.RELAYMESH_DEVICE_WEIGHT) {
    selection.deviceWeight = parseFloat(process.env.RELAYMESH_DEVICE_WEIGHT);
  }
  if (process.env.RELAYMESH_MIN_BANDWIDTH_MBPS) {
    selection.minBandwidthMbps = parseFloat(process.env.RELAYMESH_MIN_BANDWIDTH_MBPS);
  }
  if (process.env.RELAYMESH_MAX_PARTICIPANTS_PER_RELAY) {
    selection.maxParticipantsPerRelay = parseInt(
      process.env.RELAYMESH_MAX_PARTICIPANTS_PER_RELAY,
      10
    );
  }
  if (process.env.RELAYMESH_REEVALUATION_INTERVAL_MS) {
    selection.reevaluationIntervalMs = parseInt(
      process.env.RELAYMESH_REEVALUATION_INTERVAL_MS,
      10
    );
  }

  // Load connection timeouts from environment
  if (process.env.RELAYMESH_ICE_GATHERING_TIMEOUT_MS) {
    connectionTimeouts.iceGatheringTimeoutMs = parseInt(
      process.env.RELAYMESH_ICE_GATHERING_TIMEOUT_MS,
      10
    );
  }
  if (process.env.RELAYMESH_CONNECTION_ESTABLISHMENT_TIMEOUT_MS) {
    connectionTimeouts.connectionEstablishmentTimeoutMs = parseInt(
      process.env.RELAYMESH_CONNECTION_ESTABLISHMENT_TIMEOUT_MS,
      10
    );
  }
  if (process.env.RELAYMESH_RECONNECTION_TIMEOUT_MS) {
    connectionTimeouts.reconnectionTimeoutMs = parseInt(
      process.env.RELAYMESH_RECONNECTION_TIMEOUT_MS,
      10
    );
  }

  if (Object.keys(selection).length > 0) {
    config.selection = selection;
  }
  if (Object.keys(connectionTimeouts).length > 0) {
    config.connectionTimeouts = connectionTimeouts;
  }

  return config;
}

/**
 * Loads configuration from a JSON file
 * Requirement 13.1, 13.2, 13.3, 13.4, 13.5
 */
function loadConfigFromFile(filePath: string): PartialRelayMeshConfig {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, return empty config
      return {};
    }
    throw new Error(`Failed to load configuration from ${filePath}: ${(error as Error).message}`);
  }
}

/**
 * Configuration Manager
 * Handles loading, validation, and merging of configuration from multiple sources
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
 */
export class ConfigurationManager {
  private config: RelayMeshConfig;

  constructor(configFilePath?: string) {
    // Load configuration from multiple sources with precedence:
    // 1. Default values (lowest priority)
    // 2. Configuration file (if provided)
    // 3. Environment variables (highest priority)

    let fileConfig: PartialRelayMeshConfig = {};
    if (configFilePath) {
      fileConfig = loadConfigFromFile(configFilePath);
    }

    const envConfig = loadConfigFromEnv();

    // Merge configurations (env overrides file, file overrides defaults)
    const mergedSelection: Partial<SelectionConfig> = {
      ...fileConfig.selection,
      ...envConfig.selection,
    };

    const mergedPeerConnection: Partial<PeerConnectionConfig> = {
      ...fileConfig.peerConnection,
      ...envConfig.peerConnection,
    };

    const mergedTimeouts: Partial<NonNullable<RelayMeshConfig['connectionTimeouts']>> = {
      ...fileConfig.connectionTimeouts,
      ...envConfig.connectionTimeouts,
    };

    // Validate before applying defaults
    validateSelectionConfig(mergedSelection);
    validateConnectionTimeouts(mergedTimeouts);

    // Apply defaults for missing values (Requirement 13.6)
    this.config = {
      selection: {
        ...DEFAULT_SELECTION_CONFIG,
        ...mergedSelection,
      },
      peerConnection: {
        ...DEFAULT_PEER_CONNECTION_CONFIG,
        ...mergedPeerConnection,
      },
      connectionTimeouts: {
        iceGatheringTimeoutMs: 10000,
        connectionEstablishmentTimeoutMs: 30000,
        reconnectionTimeoutMs: 5000,
        ...mergedTimeouts,
      },
    };
  }

  /**
   * Get the complete configuration
   */
  getConfig(): RelayMeshConfig {
    return this.config;
  }

  /**
   * Get selection configuration
   * Requirement 13.3 - Allow configuration of metrics evaluation weights
   */
  getSelectionConfig(): SelectionConfig {
    return this.config.selection;
  }

  /**
   * Get peer connection configuration
   */
  getPeerConnectionConfig(): PeerConnectionConfig {
    return this.config.peerConnection;
  }

  /**
   * Get connection timeout configuration
   * Requirement 13.5 - Allow configuration of connection timeout values
   */
  getConnectionTimeouts(): Required<RelayMeshConfig['connectionTimeouts']> {
    return this.config.connectionTimeouts as Required<RelayMeshConfig['connectionTimeouts']>;
  }

  /**
   * Update configuration at runtime (for testing or dynamic adjustment)
   */
  updateConfig(partial: PartialRelayMeshConfig): void {
    // Validate updates
    if (partial.selection) {
      validateSelectionConfig(partial.selection);
    }
    if (partial.connectionTimeouts) {
      validateConnectionTimeouts(partial.connectionTimeouts);
    }

    // Apply updates
    this.config = {
      selection: {
        ...this.config.selection,
        ...partial.selection,
      },
      peerConnection: {
        ...this.config.peerConnection,
        ...partial.peerConnection,
      },
      connectionTimeouts: {
        ...this.config.connectionTimeouts,
        ...partial.connectionTimeouts,
      },
    };
  }
}

/**
 * Create a configuration manager with optional file path
 * If no file path provided, uses defaults + environment variables
 * Requirement 13.6 - Use sensible default values where custom configuration not provided
 */
export function createConfigurationManager(configFilePath?: string): ConfigurationManager {
  return new ConfigurationManager(configFilePath);
}
