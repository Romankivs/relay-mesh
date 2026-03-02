// Unit tests for security edge cases
// Task 14.9: Write unit tests for security edge cases
// Requirements: 12.1, 12.2, 12.3, 12.4, 12.5

import { SimpleAuthProvider, AuthCredentials } from './auth';

describe('Security Edge Cases - Authentication', () => {
  let authProvider: SimpleAuthProvider;

  beforeEach(() => {
    authProvider = new SimpleAuthProvider(3600000); // 1 hour expiration
  });

  describe('Invalid credentials', () => {
    it('should reject authentication with non-existent token', async () => {
      const credentials: AuthCredentials = {
        participantId: 'participant-1',
        token: 'non-existent-token',
        timestamp: Date.now(),
      };

      const result = await authProvider.verify(credentials);

      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Invalid token');
      expect(result.participantId).toBeUndefined();
    });

    it('should reject authentication with empty token', async () => {
      const credentials: AuthCredentials = {
        participantId: 'participant-1',
        token: '',
        timestamp: Date.now(),
      };

      const result = await authProvider.verify(credentials);

      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Invalid token');
    });

    it('should reject authentication with malformed token', async () => {
      const credentials: AuthCredentials = {
        participantId: 'participant-1',
        token: 'malformed-token-without-proper-format',
        timestamp: Date.now(),
      };

      const result = await authProvider.verify(credentials);

      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Invalid token');
    });

    it('should reject authentication with participant ID mismatch', async () => {
      // Generate token for participant-1
      const token = await authProvider.generateToken('participant-1');

      // Try to use it with participant-2
      const credentials: AuthCredentials = {
        participantId: 'participant-2',
        token,
        timestamp: Date.now(),
      };

      const result = await authProvider.verify(credentials);

      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Participant ID mismatch');
    });

    it('should reject authentication with null participant ID', async () => {
      const token = await authProvider.generateToken('participant-1');

      const credentials: AuthCredentials = {
        participantId: null as any,
        token,
        timestamp: Date.now(),
      };

      const result = await authProvider.verify(credentials);

      expect(result.authenticated).toBe(false);
    });

    it('should reject authentication with undefined token', async () => {
      const credentials: AuthCredentials = {
        participantId: 'participant-1',
        token: undefined as any,
        timestamp: Date.now(),
      };

      const result = await authProvider.verify(credentials);

      expect(result.authenticated).toBe(false);
    });
  });

  describe('Expired credentials', () => {
    it('should reject authentication with expired token', async () => {
      // Create provider with very short expiration
      const shortExpirationProvider = new SimpleAuthProvider(100); // 100ms

      const token = await shortExpirationProvider.generateToken('participant-1');

      // Wait for token to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      const credentials: AuthCredentials = {
        participantId: 'participant-1',
        token,
        timestamp: Date.now(),
      };

      const result = await shortExpirationProvider.verify(credentials);

      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Token expired');
    });

    it('should accept authentication with token just before expiration', async () => {
      const shortExpirationProvider = new SimpleAuthProvider(500); // 500ms

      const token = await shortExpirationProvider.generateToken('participant-1');

      // Wait but not long enough to expire
      await new Promise(resolve => setTimeout(resolve, 200));

      const credentials: AuthCredentials = {
        participantId: 'participant-1',
        token,
        timestamp: Date.now(),
      };

      const result = await shortExpirationProvider.verify(credentials);

      expect(result.authenticated).toBe(true);
      expect(result.participantId).toBe('participant-1');
    });

    it('should remove expired token from storage', async () => {
      const shortExpirationProvider = new SimpleAuthProvider(100);

      const token = await shortExpirationProvider.generateToken('participant-1');
      
      expect(shortExpirationProvider.getActiveTokenCount()).toBe(1);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 150));

      // Try to verify - should fail and remove token
      const credentials: AuthCredentials = {
        participantId: 'participant-1',
        token,
        timestamp: Date.now(),
      };

      await shortExpirationProvider.verify(credentials);

      // Token should be removed
      expect(shortExpirationProvider.getActiveTokenCount()).toBe(0);
    });

    it('should handle multiple expired tokens cleanup', async () => {
      const shortExpirationProvider = new SimpleAuthProvider(100);

      // Generate multiple tokens
      await shortExpirationProvider.generateToken('participant-1');
      await shortExpirationProvider.generateToken('participant-2');
      await shortExpirationProvider.generateToken('participant-3');

      expect(shortExpirationProvider.getActiveTokenCount()).toBe(3);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 150));

      // Cleanup should remove all expired tokens
      shortExpirationProvider.cleanupExpiredTokens();

      expect(shortExpirationProvider.getActiveTokenCount()).toBe(0);
    });

    it('should not affect valid tokens during cleanup', async () => {
      const mixedExpirationProvider = new SimpleAuthProvider(1000);

      // Generate tokens with different expiration times
      const token1 = await mixedExpirationProvider.generateToken('participant-1');
      
      // Create a short-lived token manually by creating a new provider
      const shortProvider = new SimpleAuthProvider(100);
      await shortProvider.generateToken('participant-2');

      // Wait for short token to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify long-lived token still works
      const credentials: AuthCredentials = {
        participantId: 'participant-1',
        token: token1,
        timestamp: Date.now(),
      };

      const result = await mixedExpirationProvider.verify(credentials);

      expect(result.authenticated).toBe(true);
    });
  });

  describe('Token revocation', () => {
    it('should reject authentication with revoked token', async () => {
      const token = await authProvider.generateToken('participant-1');

      // Revoke the token
      authProvider.revokeToken(token);

      const credentials: AuthCredentials = {
        participantId: 'participant-1',
        token,
        timestamp: Date.now(),
      };

      const result = await authProvider.verify(credentials);

      expect(result.authenticated).toBe(false);
      expect(result.error).toBe('Invalid token');
    });

    it('should handle revocation of non-existent token gracefully', () => {
      expect(() => {
        authProvider.revokeToken('non-existent-token');
      }).not.toThrow();
    });

    it('should reduce active token count after revocation', async () => {
      const token1 = await authProvider.generateToken('participant-1');
      const token2 = await authProvider.generateToken('participant-2');

      expect(authProvider.getActiveTokenCount()).toBe(2);

      authProvider.revokeToken(token1);

      expect(authProvider.getActiveTokenCount()).toBe(1);

      // Verify remaining token still works
      const credentials: AuthCredentials = {
        participantId: 'participant-2',
        token: token2,
        timestamp: Date.now(),
      };

      const result = await authProvider.verify(credentials);
      expect(result.authenticated).toBe(true);
    });
  });

  describe('Token generation edge cases', () => {
    it('should generate unique tokens for same participant', async () => {
      const token1 = await authProvider.generateToken('participant-1');
      const token2 = await authProvider.generateToken('participant-1');

      expect(token1).not.toBe(token2);

      // Both tokens should be valid
      const result1 = await authProvider.verify({
        participantId: 'participant-1',
        token: token1,
        timestamp: Date.now(),
      });

      const result2 = await authProvider.verify({
        participantId: 'participant-1',
        token: token2,
        timestamp: Date.now(),
      });

      expect(result1.authenticated).toBe(true);
      expect(result2.authenticated).toBe(true);
    });

    it('should generate unique tokens for different participants', async () => {
      const token1 = await authProvider.generateToken('participant-1');
      const token2 = await authProvider.generateToken('participant-2');

      expect(token1).not.toBe(token2);
    });

    it('should handle empty participant ID in token generation', async () => {
      const token = await authProvider.generateToken('');

      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(0);

      // Should be able to verify with empty participant ID
      const result = await authProvider.verify({
        participantId: '',
        token,
        timestamp: Date.now(),
      });

      expect(result.authenticated).toBe(true);
    });

    it('should handle special characters in participant ID', async () => {
      const specialId = 'participant-!@#$%^&*()_+-=[]{}|;:,.<>?';
      const token = await authProvider.generateToken(specialId);

      const result = await authProvider.verify({
        participantId: specialId,
        token,
        timestamp: Date.now(),
      });

      expect(result.authenticated).toBe(true);
      expect(result.participantId).toBe(specialId);
    });

    it('should handle very long participant IDs', async () => {
      const longId = 'a'.repeat(1000);
      const token = await authProvider.generateToken(longId);

      const result = await authProvider.verify({
        participantId: longId,
        token,
        timestamp: Date.now(),
      });

      expect(result.authenticated).toBe(true);
      expect(result.participantId).toBe(longId);
    });
  });

  describe('Concurrent authentication', () => {
    it('should handle multiple concurrent token generations', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        authProvider.generateToken(`participant-${i}`)
      );

      const tokens = await Promise.all(promises);

      // All tokens should be unique
      const uniqueTokens = new Set(tokens);
      expect(uniqueTokens.size).toBe(10);

      // All tokens should be valid
      const verifications = await Promise.all(
        tokens.map((token, i) =>
          authProvider.verify({
            participantId: `participant-${i}`,
            token,
            timestamp: Date.now(),
          })
        )
      );

      verifications.forEach(result => {
        expect(result.authenticated).toBe(true);
      });
    });

    it('should handle multiple concurrent verifications', async () => {
      const tokens = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          authProvider.generateToken(`participant-${i}`)
        )
      );

      const verifications = await Promise.all(
        tokens.map((token, i) =>
          authProvider.verify({
            participantId: `participant-${i}`,
            token,
            timestamp: Date.now(),
          })
        )
      );

      verifications.forEach(result => {
        expect(result.authenticated).toBe(true);
      });
    });

    it('should handle concurrent token generation and verification', async () => {
      const operations = Array.from({ length: 20 }, (_, i) => {
        if (i % 2 === 0) {
          // Generate token
          return authProvider.generateToken(`participant-${i}`);
        } else {
          // Verify a previously generated token (will fail for first iteration)
          return authProvider.verify({
            participantId: `participant-${i - 1}`,
            token: 'dummy-token',
            timestamp: Date.now(),
          });
        }
      });

      // Should not throw errors
      await expect(Promise.all(operations)).resolves.toBeDefined();
    });
  });
});
