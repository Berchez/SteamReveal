/**
 * Redacts an analytics write payload before it reaches an error log.
 *
 * The write routes log `{ body }` on 500s so a failure stays debuggable, but
 * a raw body is third-party PII (the searched profile's steamId/nickname plus
 * the whole friend network with gamertags). Error logs on Vercel/Docker must
 * not become a second pile of searchable PII, so this reduces the payload to a
 * rough diagnostic shape: the steamId's last 4 digits, array lengths, and the
 * few non-identifying scalars (searchId is server-generated, not a user id).
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const maskSteamId = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length < 4) return undefined;
  return `…${value.slice(-4)}`;
};

const arrayLength = (value: unknown): number | undefined =>
  Array.isArray(value) ? value.length : undefined;

export default function redactBodyForLog(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    return { bodyType: body === null ? 'null' : typeof body };
  }

  const profile = isRecord(body.profile) ? body.profile : undefined;

  return {
    searchId: typeof body.searchId === 'string' ? body.searchId : undefined,
    steamId: profile ? maskSteamId(profile.steamId) : undefined,
    friendCount: arrayLength(body.friends),
    gamesCount: arrayLength(body.gamesSnapshot),
    locationGuessCount: arrayLength(body.locationGuess),
    score: typeof body.score === 'number' ? body.score : undefined,
  };
}