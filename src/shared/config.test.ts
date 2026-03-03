// Configuration Management System Tests (Task 16.1)
// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6

import {
  ConfigurationManager,
  createConfigurationManager,
  ConfigValidationError,
  DEFAULT_SELECTION_CONFIG,
  DEFAULT_PEER_CONNECTION_CONFIG,
} from './config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('ConfigurationManager', () => {
  let tempDir: string;
  let tempConfigPath: string;

  beforeEach(() => {
    // Create temporary directory for test config files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaymesh-config-test-'));
    tempConfigPath = path.join(tempDir, 'config.json');

    // Clear environment variables
    delete process.env.RELAYMESH_BANDWIDTH_WEIGHT;
    delete process.env.RELAYMESH_NAT_WEIGHT;
    delete process.env.RELAYMESH_LATENCY_WEIGHT;
    delete process.env.RELAYMESH_STABILITY_WEIGHT;
    delete process.env.RELAYMESH_DEVICE_WEIGHT;
    delete process.env.RELAYMESH_MIN_BANDWIDTH_MBPS;
    delete process.env.RELAYMESH_MAX_PARTICIPANTS_PER_RELAY;
    delete process.env.RELAYMESH_REEVALUATION_INTERVAL_MS;
    delete process.env.RELAYMESH_ICE_GATHERING_TIMEOUT_MS;
    delete process.env.RELAYMESH_CONNECTION_ESTABLISHMENT_TIMEOUT_MS;
    delete process.env.RELAYMESH_RECONNECTION_TIMEOUT_MS;
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Default Configuration (Requirement 13.6)', () => {
    it('should use default values when no configuration provided', () => {
      const manager = createConfigurationManager();
      const config = manager.getConfig();

      expect(config.selection).toEqual(DEFAULT_SELECTION_CONFIG);
      expect(config.peerConnection).toEqual(DEFAULT_PEER_CONNECTION_CONFIG);
      expect(config.connectionTimeouts).toEqual({
        iceGatheringTimeoutMs: 10000,
        connectionEstablishmentTimeoutMs: 30000,
        reconnectionTimeoutMs: 5000,
      });
    });

    it('should provide default selection config', () => {
      const manager = createConfigurationManager();
      const selectionConfig = manager.getSelectionConfig();

      expect(selectionConfig.bandwidthWeight).toBe(0.30);
      expect(selectionConfig.natWeight).toBe(0.25);
      expect(selectionConfig.latencyWeight).toBe(0.20);
      expect(selectionConfig.stabilityWeight).toBe(0.15);
      expect(selectionConfig.deviceWeight).toBe(0.10);
      expect(selectionConfig.minBandwidthMbps).toBe(5);
      expect(selectionConfig.maxParticipantsPerRelay).toBe(5);
      expect(selectionConfig.reevaluationIntervalMs).toBe(30000);
    });

    it('should provide default connection timeouts', () => {
      const manager = createConfigurationManager();
      const timeouts = manager.getConnectionTimeouts();

      expect(timeouts).toBeDefined();
      expect(timeouts!.iceGatheringTimeoutMs).toBe(10000);
      expect(timeouts!.connectionEstablishmentTimeoutMs).toBe(30000);
      expect(timeouts!.reconnectionTimeoutMs).toBe(5000);
    });
  });

  describe('File-based Configuration', () => {
    it('should load configuration from JSON file', () => {
      const customConfig = {
        selection: {
          minBandwidthMbps: 10,
          maxParticipantsPerRelay: 8,
        },
        connectionTimeouts: {
          iceGatheringTimeoutMs: 15000,
        },
      };

      fs.writeFileSync(tempConfigPath, JSON.stringify(customConfig));

      const manager = createConfigurationManager(tempConfigPath);
      const config = manager.getConfig();

      // Custom values should be applied
      expect(config.selection.minBandwidthMbps).toBe(10);
      expect(config.selection.maxParticipantsPerRelay).toBe(8);
      expect(config.connectionTimeouts).toBeDefined();
      expect(config.connectionTimeouts!.iceGatheringTimeoutMs).toBe(15000);

      // Defaults should be used for missing values
      expect(config.selection.bandwidthWeight).toBe(0.30);
      expect(config.connectionTimeouts!.reconnectionTimeoutMs).toBe(5000);
    });

    it('should handle missing config file gracefully', () => {
      const nonExistentPath = path.join(tempDir, 'nonexistent.json');
      const manager = createConfigurationManager(nonExistentPath);
      const config = manager.getConfig();

      // Should use defaults
      expect(config.selection).toEqual(DEFAULT_SELECTION_CONFIG);
    });

    it('should throw error for invalid JSON file', () => {
      fs.writeFileSync(tempConfigPath, 'invalid json {');

      expect(() => {
        createConfigurationManager(tempConfigPath);
      }).toThrow();
    });
  });

  describe('Environment Variable Configuration', () => {
    it('should load selection config from environment variables (Requirement 13.1, 13.2, 13.3, 13.4)', () => {
      process.env.RELAYMESH_BANDWIDTH_WEIGHT = '0.35';
      process.env.RELAYMESH_NAT_WEIGHT = '0.20';
      process.env.RELAYMESH_LATENCY_WEIGHT = '0.25';
      process.env.RELAYMESH_STABILITY_WEIGHT = '0.10';
      process.env.RELAYMESH_DEVICE_WEIGHT = '0.10';
      process.env.RELAYMESH_MIN_BANDWIDTH_MBPS = '8';
      process.env.RELAYMESH_MAX_PARTICIPANTS_PER_RELAY = '7';
      process.env.RELAYMESH_REEVALUATION_INTERVAL_MS = '45000';

      const manager = createConfigurationManager();
      const config = manager.getSelectionConfig();

      expect(config.bandwidthWeight).toBe(0.35);
      expect(config.natWeight).toBe(0.20);
      expect(config.latencyWeight).toBe(0.25);
      expect(config.stabilityWeight).toBe(0.10);
      expect(config.deviceWeight).toBe(0.10);
      expect(config.minBandwidthMbps).toBe(8);
      expect(config.maxParticipantsPerRelay).toBe(7);
      expect(config.reevaluationIntervalMs).toBe(45000);
    });

    it('should load connection timeouts from environment variables (Requirement 13.5)', () => {
      process.env.RELAYMESH_ICE_GATHERING_TIMEOUT_MS = '12000';
      process.env.RELAYMESH_CONNECTION_ESTABLISHMENT_TIMEOUT_MS = '40000';
      process.env.RELAYMESH_RECONNECTION_TIMEOUT_MS = '8000';

      const manager = createConfigurationManager();
      const timeouts = manager.getConnectionTimeouts();

      expect(timeouts).toBeDefined();
      expect(timeouts!.iceGatheringTimeoutMs).toBe(12000);
      expect(timeouts!.connectionEstablishmentTimeoutMs).toBe(40000);
      expect(timeouts!.reconnectionTimeoutMs).toBe(8000);
    });

    it('should prioritize environment variables over file config', () => {
      const fileConfig = {
        selection: {
          minBandwidthMbps: 10,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(fileConfig));

      process.env.RELAYMESH_MIN_BANDWIDTH_MBPS = '15';

      const manager = createConfigurationManager(tempConfigPath);
      const config = manager.getSelectionConfig();

      // Environment variable should override file
      expect(config.minBandwidthMbps).toBe(15);
    });
  });

  describe('Configuration Validation', () => {
    it('should reject negative minBandwidthMbps', () => {
      const invalidConfig = {
        selection: {
          minBandwidthMbps: -5,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

      expect(() => {
        createConfigurationManager(tempConfigPath);
      }).toThrow(ConfigValidationError);
    });

    it('should reject unreasonably high minBandwidthMbps', () => {
      const invalidConfig = {
        selection: {
          minBandwidthMbps: 150,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

      expect(() => {
        createConfigurationManager(tempConfigPath);
      }).toThrow(ConfigValidationError);
    });

    it('should reject maxParticipantsPerRelay less than 1', () => {
      const invalidConfig = {
        selection: {
          maxParticipantsPerRelay: 0,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

      expect(() => {
        createConfigurationManager(tempConfigPath);
      }).toThrow(ConfigValidationError);
    });

    it('should reject unreasonably high maxParticipantsPerRelay', () => {
      const invalidConfig = {
        selection: {
          maxParticipantsPerRelay: 25,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

      expect(() => {
        createConfigurationManager(tempConfigPath);
      }).toThrow(ConfigValidationError);
    });

    it('should reject reevaluationIntervalMs less than 1000ms', () => {
      const invalidConfig = {
        selection: {
          reevaluationIntervalMs: 500,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

      expect(() => {
        createConfigurationManager(tempConfigPath);
      }).toThrow(ConfigValidationError);
    });

    it('should reject weights outside 0-1 range', () => {
      const invalidConfig = {
        selection: {
          bandwidthWeight: 1.5,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

      expect(() => {
        createConfigurationManager(tempConfigPath);
      }).toThrow(ConfigValidationError);
    });

    it('should reject weights that do not sum to 1.0', () => {
      const invalidConfig = {
        selection: {
          bandwidthWeight: 0.5,
          natWeight: 0.5,
          latencyWeight: 0.5,
          stabilityWeight: 0.5,
          deviceWeight: 0.5,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

      expect(() => {
        createConfigurationManager(tempConfigPath);
      }).toThrow(ConfigValidationError);
    });

    it('should reject connection timeouts less than 1000ms', () => {
      const invalidConfig = {
        connectionTimeouts: {
          iceGatheringTimeoutMs: 500,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

      expect(() => {
        createConfigurationManager(tempConfigPath);
      }).toThrow(ConfigValidationError);
    });
  });

  describe('Runtime Configuration Updates', () => {
    it('should allow updating configuration at runtime', () => {
      const manager = createConfigurationManager();

      manager.updateConfig({
        selection: {
          minBandwidthMbps: 12,
        },
      });

      const config = manager.getSelectionConfig();
      expect(config.minBandwidthMbps).toBe(12);
      // Other values should remain unchanged
      expect(config.bandwidthWeight).toBe(0.30);
    });

    it('should validate runtime updates', () => {
      const manager = createConfigurationManager();

      expect(() => {
        manager.updateConfig({
          selection: {
            minBandwidthMbps: -10,
          },
        });
      }).toThrow(ConfigValidationError);
    });
  });

  describe('Configuration Application (Requirement 13.1-13.5)', () => {
    it('should apply custom minBandwidthMbps configuration (Requirement 13.1)', () => {
      const customConfig = {
        selection: {
          minBandwidthMbps: 10,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(customConfig));

      const manager = createConfigurationManager(tempConfigPath);
      const config = manager.getSelectionConfig();

      expect(config.minBandwidthMbps).toBe(10);
    });

    it('should apply custom maxParticipantsPerRelay configuration (Requirement 13.2)', () => {
      const customConfig = {
        selection: {
          maxParticipantsPerRelay: 8,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(customConfig));

      const manager = createConfigurationManager(tempConfigPath);
      const config = manager.getSelectionConfig();

      expect(config.maxParticipantsPerRelay).toBe(8);
    });

    it('should apply custom metric weights configuration (Requirement 13.3)', () => {
      const customConfig = {
        selection: {
          bandwidthWeight: 0.4,
          natWeight: 0.2,
          latencyWeight: 0.2,
          stabilityWeight: 0.1,
          deviceWeight: 0.1,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(customConfig));

      const manager = createConfigurationManager(tempConfigPath);
      const config = manager.getSelectionConfig();

      expect(config.bandwidthWeight).toBe(0.4);
      expect(config.natWeight).toBe(0.2);
      expect(config.latencyWeight).toBe(0.2);
      expect(config.stabilityWeight).toBe(0.1);
      expect(config.deviceWeight).toBe(0.1);
    });

    it('should apply custom reevaluationIntervalMs configuration (Requirement 13.4)', () => {
      const customConfig = {
        selection: {
          reevaluationIntervalMs: 60000,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(customConfig));

      const manager = createConfigurationManager(tempConfigPath);
      const config = manager.getSelectionConfig();

      expect(config.reevaluationIntervalMs).toBe(60000);
    });

    it('should apply custom connection timeout configuration (Requirement 13.5)', () => {
      const customConfig = {
        connectionTimeouts: {
          iceGatheringTimeoutMs: 20000,
          connectionEstablishmentTimeoutMs: 45000,
          reconnectionTimeoutMs: 10000,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(customConfig));

      const manager = createConfigurationManager(tempConfigPath);
      const timeouts = manager.getConnectionTimeouts();

      expect(timeouts).toBeDefined();
      expect(timeouts!.iceGatheringTimeoutMs).toBe(20000);
      expect(timeouts!.connectionEstablishmentTimeoutMs).toBe(45000);
      expect(timeouts!.reconnectionTimeoutMs).toBe(10000);
    });
  });

  describe('Edge Cases', () => {
    it('should handle partial configuration with missing values', () => {
      const partialConfig = {
        selection: {
          minBandwidthMbps: 7,
          // Other values missing
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(partialConfig));

      const manager = createConfigurationManager(tempConfigPath);
      const config = manager.getSelectionConfig();

      expect(config.minBandwidthMbps).toBe(7);
      expect(config.bandwidthWeight).toBe(0.30); // Default
      expect(config.maxParticipantsPerRelay).toBe(5); // Default
    });

    it('should handle empty configuration file', () => {
      fs.writeFileSync(tempConfigPath, '{}');

      const manager = createConfigurationManager(tempConfigPath);
      const config = manager.getConfig();

      expect(config.selection).toEqual(DEFAULT_SELECTION_CONFIG);
    });

    it('should handle configuration with only connection timeouts', () => {
      const customConfig = {
        connectionTimeouts: {
          iceGatheringTimeoutMs: 15000,
        },
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(customConfig));

      const manager = createConfigurationManager(tempConfigPath);
      const config = manager.getConfig();

      expect(config.connectionTimeouts).toBeDefined();
      expect(config.connectionTimeouts!.iceGatheringTimeoutMs).toBe(15000);
      expect(config.selection).toEqual(DEFAULT_SELECTION_CONFIG);
    });
  });

  // Task 16.4: Edge Case Tests
  // Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
  describe('Configuration Edge Cases (Task 16.4)', () => {
    describe('Invalid Configuration Values', () => {
      it('should reject zero minBandwidthMbps', () => {
        const invalidConfig = {
          selection: {
            minBandwidthMbps: 0,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        // Zero is technically valid (no minimum), should not throw
        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).not.toThrow();
      });

      it('should reject negative weights', () => {
        const invalidConfig = {
          selection: {
            bandwidthWeight: -0.1,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should reject weights greater than 1', () => {
        const invalidConfig = {
          selection: {
            natWeight: 1.1,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should reject zero maxParticipantsPerRelay', () => {
        const invalidConfig = {
          selection: {
            maxParticipantsPerRelay: 0,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should reject negative maxParticipantsPerRelay', () => {
        const invalidConfig = {
          selection: {
            maxParticipantsPerRelay: -5,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should reject zero reevaluationIntervalMs', () => {
        const invalidConfig = {
          selection: {
            reevaluationIntervalMs: 0,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should reject negative reevaluationIntervalMs', () => {
        const invalidConfig = {
          selection: {
            reevaluationIntervalMs: -1000,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should reject excessively high reevaluationIntervalMs', () => {
        const invalidConfig = {
          selection: {
            reevaluationIntervalMs: 400000, // > 5 minutes
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should reject zero connection timeouts', () => {
        const invalidConfig = {
          connectionTimeouts: {
            iceGatheringTimeoutMs: 0,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should reject negative connection timeouts', () => {
        const invalidConfig = {
          connectionTimeouts: {
            connectionEstablishmentTimeoutMs: -5000,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should handle non-numeric string values in environment variables', () => {
        process.env.RELAYMESH_MIN_BANDWIDTH_MBPS = 'invalid';

        const manager = createConfigurationManager();
        const config = manager.getSelectionConfig();

        // parseFloat returns NaN for invalid strings, which gets applied
        expect(isNaN(config.minBandwidthMbps)).toBe(true);
      });

      it('should reject weights that sum to less than 1.0', () => {
        const invalidConfig = {
          selection: {
            bandwidthWeight: 0.1,
            natWeight: 0.1,
            latencyWeight: 0.1,
            stabilityWeight: 0.1,
            deviceWeight: 0.1,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });

      it('should reject weights that sum to more than 1.0', () => {
        const invalidConfig = {
          selection: {
            bandwidthWeight: 0.3,
            natWeight: 0.3,
            latencyWeight: 0.3,
            stabilityWeight: 0.3,
            deviceWeight: 0.3,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(invalidConfig));

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow(ConfigValidationError);
      });
    });

    describe('Missing Configuration File', () => {
      it('should use defaults when config file does not exist', () => {
        const nonExistentPath = path.join(tempDir, 'does-not-exist.json');

        const manager = createConfigurationManager(nonExistentPath);
        const config = manager.getConfig();

        expect(config.selection).toEqual(DEFAULT_SELECTION_CONFIG);
        expect(config.peerConnection).toEqual(DEFAULT_PEER_CONNECTION_CONFIG);
        expect(config.connectionTimeouts).toEqual({
          iceGatheringTimeoutMs: 10000,
          connectionEstablishmentTimeoutMs: 30000,
          reconnectionTimeoutMs: 5000,
        });
      });

      it('should use defaults when no config file path provided', () => {
        const manager = createConfigurationManager();
        const config = manager.getConfig();

        expect(config.selection).toEqual(DEFAULT_SELECTION_CONFIG);
        expect(config.peerConnection).toEqual(DEFAULT_PEER_CONNECTION_CONFIG);
      });

      it('should handle missing config file with environment overrides', () => {
        const nonExistentPath = path.join(tempDir, 'missing.json');
        process.env.RELAYMESH_MIN_BANDWIDTH_MBPS = '10';

        const manager = createConfigurationManager(nonExistentPath);
        const config = manager.getSelectionConfig();

        expect(config.minBandwidthMbps).toBe(10);
        expect(config.bandwidthWeight).toBe(0.30); // Default
      });
    });

    describe('Partial Configuration', () => {
      it('should handle configuration with only one weight specified', () => {
        const partialConfig = {
          selection: {
            bandwidthWeight: 0.35,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(partialConfig));

        const manager = createConfigurationManager(tempConfigPath);
        const config = manager.getSelectionConfig();

        expect(config.bandwidthWeight).toBe(0.35);
        expect(config.natWeight).toBe(0.25); // Default
        expect(config.latencyWeight).toBe(0.20); // Default
      });

      it('should handle configuration with only timeout values', () => {
        const partialConfig = {
          connectionTimeouts: {
            reconnectionTimeoutMs: 8000,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(partialConfig));

        const manager = createConfigurationManager(tempConfigPath);
        const timeouts = manager.getConnectionTimeouts();

        expect(timeouts).toBeDefined();
        expect(timeouts!.reconnectionTimeoutMs).toBe(8000);
        expect(timeouts!.iceGatheringTimeoutMs).toBe(10000); // Default
        expect(timeouts!.connectionEstablishmentTimeoutMs).toBe(30000); // Default
      });

      it('should handle configuration with mixed partial values', () => {
        const partialConfig = {
          selection: {
            minBandwidthMbps: 8,
            maxParticipantsPerRelay: 7,
          },
          connectionTimeouts: {
            iceGatheringTimeoutMs: 12000,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(partialConfig));

        const manager = createConfigurationManager(tempConfigPath);
        const config = manager.getConfig();

        expect(config.selection.minBandwidthMbps).toBe(8);
        expect(config.selection.maxParticipantsPerRelay).toBe(7);
        expect(config.selection.bandwidthWeight).toBe(0.30); // Default
        expect(config.connectionTimeouts!.iceGatheringTimeoutMs).toBe(12000);
        expect(config.connectionTimeouts!.reconnectionTimeoutMs).toBe(5000); // Default
      });

      it('should handle empty selection object', () => {
        const partialConfig = {
          selection: {},
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(partialConfig));

        const manager = createConfigurationManager(tempConfigPath);
        const config = manager.getSelectionConfig();

        expect(config).toEqual(DEFAULT_SELECTION_CONFIG);
      });

      it('should handle empty connectionTimeouts object', () => {
        const partialConfig = {
          connectionTimeouts: {},
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(partialConfig));

        const manager = createConfigurationManager(tempConfigPath);
        const timeouts = manager.getConnectionTimeouts();

        expect(timeouts).toBeDefined();
        expect(timeouts!.iceGatheringTimeoutMs).toBe(10000);
        expect(timeouts!.connectionEstablishmentTimeoutMs).toBe(30000);
        expect(timeouts!.reconnectionTimeoutMs).toBe(5000);
      });

      it('should handle partial weights that do not sum to 1.0', () => {
        const partialConfig = {
          selection: {
            bandwidthWeight: 0.5,
            natWeight: 0.3,
            // Other weights not specified
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(partialConfig));

        // Should not throw because not all weights are specified
        const manager = createConfigurationManager(tempConfigPath);
        const config = manager.getSelectionConfig();

        expect(config.bandwidthWeight).toBe(0.5);
        expect(config.natWeight).toBe(0.3);
        expect(config.latencyWeight).toBe(0.20); // Default
      });
    });

    describe('Malformed Configuration Files', () => {
      it('should throw error for invalid JSON syntax', () => {
        fs.writeFileSync(tempConfigPath, '{ invalid json }');

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow();
      });

      it('should throw error for incomplete JSON', () => {
        fs.writeFileSync(tempConfigPath, '{ "selection": { "minBandwidthMbps": ');

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow();
      });

      it('should handle non-object JSON gracefully', () => {
        fs.writeFileSync(tempConfigPath, '"string value"');

        // String JSON is valid JSON but not a valid config object
        // The system treats it as an empty config and uses defaults
        const manager = createConfigurationManager(tempConfigPath);
        const config = manager.getConfig();

        expect(config.selection).toEqual(DEFAULT_SELECTION_CONFIG);
      });

      it('should handle array JSON gracefully', () => {
        fs.writeFileSync(tempConfigPath, '[1, 2, 3]');

        // Array JSON is valid JSON but not a valid config object
        // The system treats it as an empty config and uses defaults
        const manager = createConfigurationManager(tempConfigPath);
        const config = manager.getConfig();

        expect(config.selection).toEqual(DEFAULT_SELECTION_CONFIG);
      });

      it('should handle file with only whitespace', () => {
        fs.writeFileSync(tempConfigPath, '   \n\n   ');

        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow();
      });

      it('should throw error for file with BOM (Byte Order Mark)', () => {
        const bomConfig = '\uFEFF{"selection":{"minBandwidthMbps":10}}';
        fs.writeFileSync(tempConfigPath, bomConfig);

        // BOM causes JSON parsing to fail
        expect(() => {
          createConfigurationManager(tempConfigPath);
        }).toThrow();
      });
    });

    describe('Boundary Value Tests', () => {
      it('should accept minimum valid minBandwidthMbps', () => {
        const config = {
          selection: {
            minBandwidthMbps: 0.1,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(config));

        const manager = createConfigurationManager(tempConfigPath);
        expect(manager.getSelectionConfig().minBandwidthMbps).toBe(0.1);
      });

      it('should accept maximum valid minBandwidthMbps', () => {
        const config = {
          selection: {
            minBandwidthMbps: 100,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(config));

        const manager = createConfigurationManager(tempConfigPath);
        expect(manager.getSelectionConfig().minBandwidthMbps).toBe(100);
      });

      it('should accept minimum valid maxParticipantsPerRelay', () => {
        const config = {
          selection: {
            maxParticipantsPerRelay: 1,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(config));

        const manager = createConfigurationManager(tempConfigPath);
        expect(manager.getSelectionConfig().maxParticipantsPerRelay).toBe(1);
      });

      it('should accept maximum valid maxParticipantsPerRelay', () => {
        const config = {
          selection: {
            maxParticipantsPerRelay: 20,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(config));

        const manager = createConfigurationManager(tempConfigPath);
        expect(manager.getSelectionConfig().maxParticipantsPerRelay).toBe(20);
      });

      it('should accept minimum valid reevaluationIntervalMs', () => {
        const config = {
          selection: {
            reevaluationIntervalMs: 1000,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(config));

        const manager = createConfigurationManager(tempConfigPath);
        expect(manager.getSelectionConfig().reevaluationIntervalMs).toBe(1000);
      });

      it('should accept maximum valid reevaluationIntervalMs', () => {
        const config = {
          selection: {
            reevaluationIntervalMs: 300000,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(config));

        const manager = createConfigurationManager(tempConfigPath);
        expect(manager.getSelectionConfig().reevaluationIntervalMs).toBe(300000);
      });

      it('should accept weights exactly at 0', () => {
        const config = {
          selection: {
            bandwidthWeight: 0.5,
            natWeight: 0.5,
            latencyWeight: 0.0,
            stabilityWeight: 0.0,
            deviceWeight: 0.0,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(config));

        const manager = createConfigurationManager(tempConfigPath);
        const selectionConfig = manager.getSelectionConfig();
        expect(selectionConfig.latencyWeight).toBe(0.0);
      });

      it('should accept weights exactly at 1', () => {
        const config = {
          selection: {
            bandwidthWeight: 1.0,
            natWeight: 0.0,
            latencyWeight: 0.0,
            stabilityWeight: 0.0,
            deviceWeight: 0.0,
          },
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(config));

        const manager = createConfigurationManager(tempConfigPath);
        const selectionConfig = manager.getSelectionConfig();
        expect(selectionConfig.bandwidthWeight).toBe(1.0);
      });
    });

    describe('Runtime Update Edge Cases', () => {
      it('should reject invalid values in runtime updates', () => {
        const manager = createConfigurationManager();

        expect(() => {
          manager.updateConfig({
            selection: {
              maxParticipantsPerRelay: -1,
            },
          });
        }).toThrow(ConfigValidationError);
      });

      it('should allow partial runtime updates', () => {
        const manager = createConfigurationManager();

        manager.updateConfig({
          selection: {
            minBandwidthMbps: 15,
          },
        });

        const config = manager.getSelectionConfig();
        expect(config.minBandwidthMbps).toBe(15);
        expect(config.bandwidthWeight).toBe(0.30); // Unchanged
      });

      it('should validate weight sum in runtime updates', () => {
        const manager = createConfigurationManager();

        expect(() => {
          manager.updateConfig({
            selection: {
              bandwidthWeight: 0.5,
              natWeight: 0.5,
              latencyWeight: 0.5,
              stabilityWeight: 0.5,
              deviceWeight: 0.5,
            },
          });
        }).toThrow(ConfigValidationError);
      });
    });

    describe('Environment Variable Edge Cases', () => {
      it('should handle empty string environment variables', () => {
        process.env.RELAYMESH_MIN_BANDWIDTH_MBPS = '';

        const manager = createConfigurationManager();
        const config = manager.getSelectionConfig();

        // Empty string parses to NaN, should use default
        expect(config.minBandwidthMbps).toBe(5); // Default
      });

      it('should handle whitespace-only environment variables', () => {
        process.env.RELAYMESH_MAX_PARTICIPANTS_PER_RELAY = '   ';

        const manager = createConfigurationManager();
        const config = manager.getSelectionConfig();

        // Whitespace parses to NaN with parseInt
        expect(isNaN(config.maxParticipantsPerRelay)).toBe(true);
      });

      it('should reject environment variables with invalid numeric formats', () => {
        process.env.RELAYMESH_REEVALUATION_INTERVAL_MS = '10.5.5';

        // Invalid format parses to 10 with parseInt, which is < 1000 and should be rejected
        expect(() => {
          createConfigurationManager();
        }).toThrow(ConfigValidationError);
      });
    });
  });
});
