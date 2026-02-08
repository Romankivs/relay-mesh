// Configuration interfaces and defaults

import { SelectionConfig, PeerConnectionConfig } from './types';

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
};
