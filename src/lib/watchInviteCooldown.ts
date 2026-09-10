/**
 * Re-request cooldown for Watch Bot invites (Epic 3, WB-6).
 *
 * A pending invite that was never accepted can only be re-queued after
 * this long. Prevents invite spam against both Steam (throttling/ban risk
 * for the bot account) and the target user, while still letting a
 * genuinely missed invite be retried after a week.
 *
 * Lives in its own module (like closeFriendsLimits.ts) because Next.js
 * route files may only export route handlers and route config — an
 * exported constant in route.ts fails the production build
 * ("not a valid Route export field").
 */
const INVITE_REREQUEST_AFTER_MS = 7 * 24 * 3600 * 1000;

export default INVITE_REREQUEST_AFTER_MS;
