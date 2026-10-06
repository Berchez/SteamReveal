import getSteamApiKey from '@/lib/getSteamApiKey';
import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';
import isValidTargetParam from '@/lib/isValidTargetParam';
import { errorResponse } from '@/lib/apiError';
import withTimeout, { SteamCallTimeoutError } from '@/lib/withTimeout';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import logRouteError from '@/lib/logRouteError';
import isSteamResolveFormatError from '@/lib/isSteamResolveFormatError';
import isSteamProfileNotFoundError from '@/lib/isSteamProfileNotFoundError';
import isSteamUnauthorizedError from '@/lib/isSteamUnauthorizedError';

export const revalidate = 0;

const steamApiKey = getSteamApiKey();
if (!steamApiKey) {
  console.error(
    'getCloseFriends - STEAM_API_KEY is missing at module init. Every request to this route will fail until it is set.',
  );
}
const steam = new SteamAPI(steamApiKey ?? '');

const STEAM_CALL_TIMEOUT_MS = 8000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

type UserFriend = {
  steamID: string;
  friendedTimestamp: number;
  relationship: string;
};

/**
 * Typed failures from getCloseFriends so POST answers with the right status
 * WITHOUT textual message matching (which once risked misblaming input for
 * another profile's upstream failure): the origin classifies, POST renders.
 * - 'target-not-found' (400): Steam has no record for the target id itself
 *   (typo, stale link, deleted account). Thrown ONLY by the target's own
 *   getUserFriends wrapper — per-friend lookups swallow their errors with
 *   a warn inside getFriendsOfFriends and can never produce this.
 * - 'summaries-unavailable' (503): Steam answered with zero resolvable
 *   friend summaries (deleted accounts, a Steam data gap). 503 (not 200 [])
 *   keeps the client's abort contract (visibility UNSET → NULL analytics,
 *   no cheater score on an empty network, retryable) — a 200 [] would be
 *   misread as "public but friendless". Conscious trade-off: a
 *   deterministically all-deleted network 503s persistently instead of
 *   ever recording a false 'empty'.
 */
class CloseFriendsLookupError extends Error {
  readonly status: 400 | 503;

  readonly code: 'INVALID_REQUEST' | 'FRIENDS_DATA_UNAVAILABLE';

  readonly publicMessage: string;

  constructor(
    kind: 'target-not-found' | 'summaries-unavailable',
    detail: string,
    options?: ErrorOptions,
  ) {
    super(detail, options);
    this.name = 'CloseFriendsLookupError';
    if (kind === 'target-not-found') {
      this.status = 400;
      this.code = 'INVALID_REQUEST';
      this.publicMessage = 'Invalid target.';
    } else {
      this.status = 503;
      this.code = 'FRIENDS_DATA_UNAVAILABLE';
      this.publicMessage =
        'Friends data temporarily unavailable. Please try again.';
    }
  }
}

const getFriendsOfFriends = async (friendList: Array<UserFriend>) => {
  const friendsOfFriends: Array<UserFriend> = [];
  await Promise.all(
    friendList.map(async (friend: UserFriend) => {
      try {
        const list = await withTimeout(
          steam.getUserFriends(friend.steamID),
          `getCloseFriends: steam.getUserFriends(${friend.steamID})`,
          STEAM_CALL_TIMEOUT_MS,
        );
        friendsOfFriends.push(...list);
      } catch (error) {
        console.warn(
          `getCloseFriends - failed to get friends of friend ${friend.steamID}:`,
          error,
        );
      }
    }),
  );

  return friendsOfFriends;
};

const getCloseFriends = async (target: string) => {
  let friendsOfTheTarget: UserFriend[];
  try {
    friendsOfTheTarget = (
      await withTimeout(
        steam.getUserFriends(target),
        'getCloseFriends: steam.getUserFriends(target)',
        STEAM_CALL_TIMEOUT_MS,
      )
    ).slice(0, 100);
  } catch (err) {
    if (err instanceof SteamCallTimeoutError) {
      throw err;
    }
    // Classify at the origin: a "no players found" here means the TARGET
    // id has no Steam record (client input), so throw the typed error POST
    // matches with instanceof. `cause` preserves the original type/stack
    // for debuggability.
    if (isSteamProfileNotFoundError(err)) {
      throw new CloseFriendsLookupError(
        'target-not-found',
        'Target has no Steam record',
        { cause: err },
      );
    }
    throw new Error(
      `GettingFriends: Error getting friends of target: ${target}. ${err}`,
      { cause: err },
    );
  }

  if (!Array.isArray(friendsOfTheTarget)) {
    return [];
  }

  const friedsOfFriendsOfTheTarget =
    await getFriendsOfFriends(friendsOfTheTarget);

  const closeFriendsOfTheTarget = friendsOfTheTarget.map(
    (friend: UserFriend) => ({
      steamID: friend.steamID,
      count: friedsOfFriendsOfTheTarget.filter(
        (f: UserFriend) => f.steamID === friend.steamID,
      ).length,
    }),
  );

  closeFriendsOfTheTarget.sort((a, b) => b.count - a.count);

  // MAX_CLOSE_FRIENDS is shared with /api/getCheaterProbability's request
  // validation (see @/lib/closeFriendsLimits). This is the place that
  // actually decides how many close friends the product considers; that
  // other route just caps what it'll accept back from the client at the
  // same number. Change it in one place, both stay in sync.
  const closestFriends = closeFriendsOfTheTarget.slice(0, MAX_CLOSE_FRIENDS);

  const steamIDs = closestFriends.map((friend) => friend.steamID);

  // A public-but-empty friends list must settle as `[]` (client visibility
  // 'empty'), not blow up: steamapi's getUserSummary([]) calls the API with
  // an empty `steamids` param (assertID passes vacuously), gets `players:
  // []` back, and throws 'No players found' — which the POST catch-all
  // would turn into a 500, aborting a perfectly valid search. Skipping the
  // call also saves one rate-limited Steam request.
  if (steamIDs.length === 0) {
    return [];
  }

  let summaries;
  try {
    summaries = await withTimeout(
      steam.getUserSummary(steamIDs),
      'getCloseFriends: steam.getUserSummary(closestFriends)',
      STEAM_CALL_TIMEOUT_MS,
    );
  } catch (error) {
    if (isSteamProfileNotFoundError(error)) {
      // Steam answered with zero resolvable summaries for the whole batch
      // (empty `players` array for every id — deleted accounts, a Steam
      // data gap): the limit case of the tolerant-drop path below, which
      // already returns fewer entries when only SOME summaries resolve.
      // Abort with 503 (not 200 []) — see CloseFriendsLookupError, whose
      // POST branch carries the warn for sustained degradations.
      throw new CloseFriendsLookupError(
        'summaries-unavailable',
        `Steam returned no resolvable summaries for ${steamIDs.length} close friend(s) of ${target}.`,
        { cause: error },
      );
    }
    throw error;
  }
  const summariesArray = Array.isArray(summaries) ? summaries : [summaries];

  // Only keep entries whose Steam summary actually resolved. A friend can
  // fail to resolve (private profile, deleted account, a transient gap in
  // the Steam API's response) — this used to ship as `friend: null`,
  // which silently violated closeFriendsDataIWant's type
  // (`friend: UserSummary`, declared non-nullable) and left every
  // downstream consumer — e.g. getBannedFriendsScore's
  // `friendData.friend.nickname` — one bad Steam response away from a
  // null-dereference crash. Dropping unresolvable friends here keeps the
  // type honest end to end, at the cost of occasionally returning fewer
  // than MAX_CLOSE_FRIENDS entries — an accurate reflection of reality
  // (there's no usable data for that friend), not a bug.
  const closestFriendsWithSummary = closestFriends.reduce<
    Array<{ friend: (typeof summariesArray)[number]; count: number }>
  >((acc, friend) => {
    const summary = summariesArray.find(
      (sum) => sum.steamID === friend.steamID,
    );
    if (summary) {
      acc.push({ friend: summary, count: friend.count });
    }
    return acc;
  }, []);

  const droppedCount = closestFriends.length - closestFriendsWithSummary.length;
  if (droppedCount > 0) {
    console.warn(
      `getCloseFriends - ${droppedCount} close friend(s) of ${target} had no resolvable Steam summary and were dropped.`,
    );
  }

  return closestFriendsWithSummary;
};

export async function POST(req: Request) {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  // Dev/test mode: only taken when isMockModeEnabled() also agrees (never
  // NODE_ENV=production, never on Vercel). If DEV_TEST_MODE is set but
  // the guard fails, fall through to the real implementation instead of
  // erroring — a stray env var must never be able to take production down.
  if (process.env.DEV_TEST_MODE === '1') {
    const { isMockModeEnabled, makeMockCloseFriends, isMockInvalidTarget } =
      await import('@/mocks/devFixtures');

    if (isMockModeEnabled()) {
      try {
        const body = await req.json();
        const { target } = body;
        if (!target || !isValidTargetParam(target)) {
          return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
        }
        if (isMockInvalidTarget(target)) {
          return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
        }
        const closeFriends = makeMockCloseFriends(target);
        return NextResponse.json({ closeFriends }, { status: 200 });
      } catch (e) {
        return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
      }
    }
    // Guard failed: fall through to the real implementation below.
  }

  const ip = getRequestIp(req);
  if (rateLimiter.isRateLimited(ip)) {
    return errorResponse(
      'Too many requests. Try again later.',
      429,
      'RATE_LIMITED',
    );
  }

  let body;
  try {
    body = await req.json();
    const { target } = body;

    if (!isValidTargetParam(target)) {
      return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
    }

    const targetSteamId = await withTimeout(
      steam.resolve(target),
      'getCloseFriends: steam.resolve',
      STEAM_CALL_TIMEOUT_MS,
    );
    const targetCloseFriends = await getCloseFriends(targetSteamId);

    return NextResponse.json(
      { closeFriends: targetCloseFriends },
      { status: 200 },
    );
  } catch (error) {
    // Typed first: our own error's detail interpolates the user-supplied
    // target, so a target containing e.g. 'unauthorized' would match a
    // text matcher below and misclassify (400-as-private instead of the
    // intended 400/503). instanceof never consults text — check it before
    // any message pattern.
    if (error instanceof CloseFriendsLookupError) {
      // Client input (400, target-not-found) vs upstream gap (503,
      // summaries-unavailable): both warn, neither pages. For
      // target-not-found the trace must identify the profile — the POST URL
      // carries no identity, so log the body target (JSON-quoted to
      // neutralize control chars, truncated). Reachable ONLY from the
      // target's own wrapper (see the class docblock), so input is never
      // misblamed for another profile's failure.
      if (error.code === 'INVALID_REQUEST') {
        const rawTarget =
          body !== null && typeof body === 'object'
            ? (body as { target?: unknown }).target
            : undefined;
        const targetForLog =
          typeof rawTarget === 'string'
            ? JSON.stringify(rawTarget.slice(0, 120))
            : req.url;
        console.warn(`getCloseFriends - ${error.message}: ${targetForLog}`);
      } else {
        console.warn(`getCloseFriends - ${error.message}`);
      }
      return errorResponse(error.publicMessage, error.status, error.code);
    }

    if (isSteamUnauthorizedError(error)) {
      console.warn(
        `getCloseFriends - target's data is private: ${req.url}`,
        error,
      );
      return errorResponse(
        "Target's friends list is private or inaccessible.",
        400,
        'FRIENDS_LIST_PRIVATE',
      );
    }

    if (error instanceof SyntaxError) {
      logRouteError('getCloseFriends', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    if (error instanceof SteamCallTimeoutError) {
      logRouteError('getCloseFriends', error, { body });
      return errorResponse(
        'Steam API request timed out. Please try again.',
        504,
        'TIMEOUT',
      );
    }

    if (isSteamResolveFormatError(error)) {
      logRouteError('getCloseFriends', error, { target: req.url });
      return errorResponse('Invalid target format.', 400, 'INVALID_REQUEST');
    }

    logRouteError('getCloseFriends', error, { body });
    return errorResponse('Internal server error.', 500, 'INTERNAL_ERROR');
  }
}
