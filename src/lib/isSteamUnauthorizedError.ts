/**
 * The `steamapi` lib throws "Unauthorized" when a call needs data the
 * target's privacy settings don't expose (most commonly: friends list
 * set to private). This is an expected, user-triggerable condition —
 * not a server failure — so it should map to 400, not 500, and log at
 * warn level instead of error.
 */
export default function isSteamUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && /unauthorized/i.test(error.message);
}
