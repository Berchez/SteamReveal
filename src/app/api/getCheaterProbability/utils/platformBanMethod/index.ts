import { PlatformBanDetails } from '@/@types/cheaterDataType';
import withTimeout, { SteamCallTimeoutError } from '@/lib/withTimeout';
import { BanClassification } from './utils/classifyBanReason';
import getFaceitBanStatus, {
  faceitNotBannedStatus,
  FACEIT_TIMEOUT_MS,
} from './utils/faceitBans';
import getGamersClubBanStatus, {
  gamersClubNotBannedStatus,
} from './utils/gamersClubBan';
import activityTier from './utils/activityTier';

export type PlatformBanResult = {
  /**
   * Net signal used for the probability adjustment:
   * cheatCount - smurfCount (other bans are neutral).
   */
  score: number;
  cheatCount: number;
  smurfCount: number;
  otherCount: number;
  details: PlatformBanDetails;
  /**
   * Sum of the activity discounts for players demonstrably active on
   * FACEIT/GamersClub (each capped at ACTIVITY_REDUCTION_MAX, and cancelled
   * if that platform also holds a cheating ban). Subtract this from the
   * model probability — it is a post-model signal, never part of `features`.
   *
   * Deliberately optional: the route consumes this result defensively (a
   * partial result still yields a safe 0 discount), which is asserted by
   * `route.test.ts` ("exposes activity fields even when the platform result
   * omits them").
   */
  activityDiscount?: number;
  faceitActive?: boolean;
  gcActive?: boolean;
};

// Wall-clock budget that the wrapper grants each platform's entire lookup
// (not per http call). FACEIT's `getFaceitBanStatus` is SEQUENTIAL in two
// stages — resolve the player (up to FACEIT_TIMEOUT_MS) and then, in
// parallel, hits /bans + stats/cs2 + stats/csgo — so its true worst case is
// roughly 2 × FACEIT_TIMEOUT_MS. The wrapper must grant at least that, or a
// merely-slow-but-successful lookup gets discarded by the outer timeout even
// though none of its individual calls timed out. Derived from
// FACEIT_TIMEOUT_MS so the two stay coupled if one is retuned. The route runs
// this method in parallel with the other (historically slower) branches, so
// the extra budget doesn't push overall TTFB.
const BAN_TIMEOUT_MS = FACEIT_TIMEOUT_MS * 2 + 2000;

// The individual ban lookups never reject (they swallow their own errors and
// resolve to "not banned"), so the only way `withTimeout` rejects is a real
// wall-clock timeout. Treat that (and, as defense in depth, any unexpected
// rejection) as "not banned" too — external-platform bans are a weak,
// complementary signal and must never block or break the whole report.
//
// The fallback is passed in explicitly (instead of casting a partial object and
// hiding it with `as T`) so the compiler verifies it actually satisfies the
// ban-status type — including fields like `matches`/`playerId`/`name`. The
// fallbacks come from each module's own shared "not banned" value (single
// source of truth, no duplicated shape).
const withinBanTimeout = async <T>(
  label: string,
  p: Promise<T>,
  fallback: T,
): Promise<T> => {
  try {
    return await withTimeout(p, label, BAN_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof SteamCallTimeoutError) {
      console.error(
        `platformBan - ${label} timed out after ${BAN_TIMEOUT_MS}ms, treating as not banned`,
      );
    } else {
      console.error(
        `platformBan - ${label} failed unexpectedly, treating as not banned:`,
        error,
      );
    }
    return fallback;
  }
};

const getPlatformBanScore = async (
  targetSteamId: string,
): Promise<PlatformBanResult> => {
  const [faceit, gamersClub] = await Promise.all([
    withinBanTimeout(
      'faceit',
      getFaceitBanStatus(targetSteamId),
      faceitNotBannedStatus,
    ),
    withinBanTimeout(
      'gamersClub',
      getGamersClubBanStatus(targetSteamId),
      gamersClubNotBannedStatus,
    ),
  ]);

  const details: PlatformBanDetails = {
    faceit: {
      banned: faceit.banned,
      reason: faceit.reason,
      classification: faceit.classification,
      matches: faceit.matches,
    },
    gamersClub: {
      banned: gamersClub.banned,
      reason: gamersClub.reason,
      classification: gamersClub.classification,
      matches: gamersClub.matches,
    },
  };

  const classifications = [
    faceit.classification,
    gamersClub.classification,
  ].filter((c): c is BanClassification => c !== null);

  const cheatCount = classifications.filter((c) => c === 'cheat').length;
  const smurfCount = classifications.filter((c) => c === 'smurf').length;
  const otherCount = classifications.filter((c) => c === 'other').length;

  // Activity is only a discount while the player is NOT banned for cheating on
  // that same platform — an active cheat ban is a far stronger signal and must
  // not be partially cancelled by "they play a lot" ("ban wins").
  const faceitDiscount = activityTier(
    faceit.matches,
    faceit.classification === 'cheat',
  );

  const gcDiscount = activityTier(
    gamersClub.matches,
    gamersClub.classification === 'cheat',
  );

  return {
    score: cheatCount - smurfCount,
    cheatCount,
    smurfCount,
    otherCount,
    details,
    activityDiscount: faceitDiscount + gcDiscount,
    faceitActive: faceitDiscount > 0,
    gcActive: gcDiscount > 0,
  };
};

export default getPlatformBanScore;
