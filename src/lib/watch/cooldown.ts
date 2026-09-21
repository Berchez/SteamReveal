/**
 * Shared Watch cooldown predicate (WB-12/WB-13) — single source of truth
 * for "was this profile notified within the last N hours", used by both
 * the enqueue gate (`watchNotify.ts`, via the DAL) and the send-time
 * recheck (`notifyPoller.ts`).
 *
 * Pure timestamp math, no I/O: callers supply the persisted
 * last_notified_at they already read. Fail-open like everything else on
 * this path — a missing/corrupt clock returns false (notify allowed) so a
 * bad timestamp can never suppress notifications forever.
 *
 * Default export (single-export module, repo convention — see
 * watchInviteCooldown, sqlStatements, parsePositiveInt).
 */

const isWithinCooldownWindow = (
  lastNotifiedAt: string | null | undefined,
  windowHours: number,
  nowMs: number = Date.now(),
): boolean => {
  if (typeof lastNotifiedAt !== 'string') return false;
  const lastMs = Date.parse(lastNotifiedAt);
  if (!Number.isFinite(lastMs)) return false;
  return nowMs - lastMs < windowHours * 3600000;
};

export default isWithinCooldownWindow;
