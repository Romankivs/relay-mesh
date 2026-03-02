// Authentication module for participant verification
// Task 14.7, Requirement 12.4

/**
 * Authentication credentials for a participant
 */
export interface AuthCredentials {
  participantId: string;
  token: string; // Authentication token (e.g., JWT, API key, session token)
  timestamp: number; // When credentials were issued
}

/**
 * Authentication result
 */
export interface AuthResult {
  authenticated: boolean;
  participantId?: string;
  error?: string;
}

/**
 * Authentication provider interface
 * Allows different authentication strategies to be implemented
 */
export interface AuthProvider {
  /**
   * Verify authentication credentials
   * 
   * @param credentials - The credentials to verify
   * @returns Promise resolving to authentication result
   */
  verify(credentials: AuthCredentials): Promise<AuthResult>;

  /**
   * Generate authentication token for a participant
   * 
   * @param participantId - ID of the participant
   * @returns Promise resolving to authentication token
   */
  generateToken(participantId: string): Promise<string>;
}

/**
 * Simple token-based authentication provider
 * In production, this should be replaced with a more secure implementation
 * (e.g., JWT with proper signing, OAuth, etc.)
 */
export class SimpleAuthProvider implements AuthProvider {
  private validTokens: Map<string, { participantId: string; expiresAt: number }> = new Map();
  private tokenExpirationMs: number;

  constructor(tokenExpirationMs: number = 3600000) {
    // Default: 1 hour
    this.tokenExpirationMs = tokenExpirationMs;
  }

  /**
   * Verify authentication credentials
   * 
   * @param credentials - The credentials to verify
   * @returns Promise resolving to authentication result
   */
  async verify(credentials: AuthCredentials): Promise<AuthResult> {
    const tokenInfo = this.validTokens.get(credentials.token);

    if (!tokenInfo) {
      return {
        authenticated: false,
        error: 'Invalid token',
      };
    }

    // Check if token is expired
    if (Date.now() > tokenInfo.expiresAt) {
      this.validTokens.delete(credentials.token);
      return {
        authenticated: false,
        error: 'Token expired',
      };
    }

    // Verify participant ID matches
    if (tokenInfo.participantId !== credentials.participantId) {
      return {
        authenticated: false,
        error: 'Participant ID mismatch',
      };
    }

    return {
      authenticated: true,
      participantId: credentials.participantId,
    };
  }

  /**
   * Generate authentication token for a participant
   * 
   * @param participantId - ID of the participant
   * @returns Promise resolving to authentication token
   */
  async generateToken(participantId: string): Promise<string> {
    // Generate a simple token (in production, use proper JWT or similar)
    const token = `${participantId}-${Date.now()}-${Math.random().toString(36).substring(2)}`;
    const expiresAt = Date.now() + this.tokenExpirationMs;

    this.validTokens.set(token, {
      participantId,
      expiresAt,
    });

    return token;
  }

  /**
   * Revoke a token
   * 
   * @param token - The token to revoke
   */
  revokeToken(token: string): void {
    this.validTokens.delete(token);
  }

  /**
   * Clean up expired tokens
   */
  cleanupExpiredTokens(): void {
    const now = Date.now();
    for (const [token, info] of this.validTokens.entries()) {
      if (now > info.expiresAt) {
        this.validTokens.delete(token);
      }
    }
  }

  /**
   * Get number of active tokens
   */
  getActiveTokenCount(): number {
    this.cleanupExpiredTokens();
    return this.validTokens.size;
  }
}
