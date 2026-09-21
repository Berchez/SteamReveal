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
}
