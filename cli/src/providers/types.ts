import type { ParsedSession } from '../types.js';

/**
 * SessionProvider interface - each tool (Claude Code, Cursor, Codex, etc.) implements this
 */
export interface SessionProvider {
  /** Unique provider identifier (e.g., 'claude-code', 'cursor') */
  getProviderName(): string;

  /** Discover session files/databases on this machine */
  discover(options?: { projectFilter?: string }): Promise<string[]>;

  /**
   * Fingerprint provider-owned inputs that are not covered by the discovered
   * source file itself. Multi-session providers can use this to invalidate one
   * virtual session without invalidating every sibling.
   */
  getSourceFingerprint?(filePath: string): string | null;

  /** Parse a single session source into normalized form. */
  parse(filePath: string): Promise<ParsedSession | null>;
}
