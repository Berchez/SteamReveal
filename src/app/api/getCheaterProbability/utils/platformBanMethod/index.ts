import { PlatformBanDetails } from '@/@types/cheaterDataType';
import withTimeout, {
  SteamCallTimeoutError,
} from '@/lib/withTimeout';
import getFaceitBanStatus from './utils/faceitBans';
import getGamersClubBanStatus from './utils/gamersClubBan';
import { BanClassification } from './utils/classifyBanReason';

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
};

const BAN_TIMEOUT_MS = 8000;

// The individual ban lookups never reject (they swallow their own errors and
// resolve to "not banned"), so the only way `withTimeout` rejects is a real
// wall-clock timeout. Treat that (and, as defense in depth, any unexpected
// rejection) as "not banned" too — external-platform bans are a weak,
// complementary signal and must never block or break the whole report.
const withinBanTimeout = async <T>(label: string, p: Promise<T>): Promise<T> => {
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
    return { banned: false, reason: null, classification: null } as T;
  }
};

const getPlatformBanScore = async (
  targetSteamId: string,
): Promise<PlatformBanResult> => {
  const [faceit, gamersClub] = await Promise.all([
    withinBanTimeout('faceit', getFaceitBanStatus(targetSteamId)),
    withinBanTimeout('gamersClub', getGamersClubBanStatus(targetSteamId)),
  ]);

  const details: PlatformBanDetails = {
    faceit: {
      banned: faceit.banned,
      reason: faceit.reason,
      classification: faceit.classification,
    },
    gamersClub: {
      banned: gamersClub.banned,
      reason: gamersClub.reason,
      classification: gamersClub.classification,
    },
  };

  const classifications = [
    faceit.classification,
    gamersClub.classification,
  ].filter((c): c is BanClassification => c !== null);

  const cheatCount = classifications.filter((c) => c === 'cheat').length;
  const smurfCount = classifications.filter((c) => c === 'smurf').length;
  const otherCount = classifications.filter((c) => c === 'other').length;

  return {
    score: cheatCount - smurfCount,
    cheatCount,
    smurfCount,
    otherCount,
    details,
  };
};

export default getPlatformBanScore;
