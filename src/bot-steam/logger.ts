/**
 * Shared structural logger for the Watch Bot service.
 *
 * Every bot module (bot, reconcile, invitePoller, staleSweep,
 * friendRemoved) logs through this shape — `console` satisfies it, tests
 * pass silent doubles. One definition (not five identical interfaces) so
 * the contract cannot drift between modules.
 */

export interface WatchBotLogger {
  info: (message: string) => void;
  error: (message: string) => void;
  // Optional so the dozens of existing `{ info, error }` test doubles keep
  // compiling: transient/infra noise (Turso blip, Steam flap) logs here,
  // staying in the day file but out of errors.log (writeOpsLog only
  // duplicates `error` level). `console` satisfies it; callers must fall
  // back to info when warn is absent.
  warn?: (message: string) => void;
}
