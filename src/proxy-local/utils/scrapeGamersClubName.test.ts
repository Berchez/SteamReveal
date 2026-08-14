/**
 * @jest-environment node
 *
 * Forced to the 'node' environment (instead of the project-wide 'jsdom'
 * default used for React component tests) because jest-environment-jsdom
 * sets customExportConditions to ['browser'] by default. That makes Jest
 * resolve cheerio's ESM "browser" build (which Jest can't parse without
 * an ESM transform) instead of its CommonJS "node" build, the moment
 * anything in this file's import chain pulls in cheerio (scrapeGamersClubName.ts
 * does, via cheerio itself). This file doesn't touch the DOM, so 'node' is
 * also the more accurate environment for it regardless.
 */
import axios from 'axios';
import scrapeGamersClubName from './scrapeGamersClubName';
import { resetRateLimiter, setMinDelay, setMaxDelay } from './rateLimit';
import { getCachedGcName, setCachedGcName } from './gcNameCache';

jest.mock('axios');
jest.mock('./getErrorMessage', () => ({
  __esModule: true,
  default: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// gcNameCache is mocked here so this file tests scrapeGamersClubName's own
// decision logic (when it reads/writes the cache, and with what) in
// isolation. Without this mock, tests would share the real in-memory Map
// across `it` blocks (it's module-level state) and one test's cache write
// would silently short-circuit a later test's axios expectations. The
// real cache behavior (TTL, malformed-entry handling, persistence) is
// covered in gcNameCache.test.ts.
jest.mock('./gcNameCache', () => ({
  __esModule: true,
  getCachedGcName: jest.fn(),
  setCachedGcName: jest.fn(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedGetCachedGcName = getCachedGcName as jest.MockedFunction<
  typeof getCachedGcName
>;
const mockedSetCachedGcName = setCachedGcName as jest.MockedFunction<
  typeof setCachedGcName
>;

jest.setTimeout(10000);

const STEAM_ID = '76561198000000000';
const ORIGINAL_COOKIE_ENV = process.env.GAMERSCLUB_SESSION_COOKIE;

const makeAxiosError = (
  status: number,
  headers: Record<string, string> = {},
) => ({
  isAxiosError: true,
  response: { status, headers },
});

describe('scrapeGamersClubName', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Keep the real rate limiter, but fast, so these tests exercise the
    // actual integration (applyRateLimit/reportThrottled/reportSuccess
    // really being called through withRetry) without slowing the suite
    // down. The adaptive-delay math itself is covered in rateLimit.test.ts.
    resetRateLimiter();
    setMinDelay(5);
    setMaxDelay(50);

    process.env.GAMERSCLUB_SESSION_COOKIE = 'fake-session-value';

    // Default every test to a cache miss unless it explicitly says
    // otherwise — otherwise a stray `undefined` return would be treated
    // as falsy/miss anyway, but being explicit keeps intent clear.
    mockedGetCachedGcName.mockReturnValue(null);

    // jest.mock('axios') replaces axios.isAxiosError with a plain jest.fn()
    // (it's normally a type guard provided by the real library), so it
    // needs a real implementation for our mocked "axios errors" to be
    // recognized as such by isRetryableAxiosError / isRateLimitError.
    (mockedAxios.isAxiosError as unknown as jest.Mock).mockImplementation(
      (err: unknown) => !!(err as { isAxiosError?: boolean })?.isAxiosError,
    );
  });

  afterAll(() => {
    process.env.GAMERSCLUB_SESSION_COOKIE = ORIGINAL_COOKIE_ENV;
  });

  describe('cache hits', () => {
    it('returns a cached name without calling axios at all', async () => {
      mockedGetCachedGcName.mockReturnValue({
        name: 'Cached Player',
        cachedAt: Date.now(),
      });

      const name = await scrapeGamersClubName(STEAM_ID);

      expect(name).toBe('Cached Player');
      expect(mockedAxios.get).not.toHaveBeenCalled();
      expect(mockedSetCachedGcName).not.toHaveBeenCalled();
    });

    it('returns a cached confirmed "not found" (null) without calling axios', async () => {
      mockedGetCachedGcName.mockReturnValue({
        name: null,
        cachedAt: Date.now(),
      });

      const name = await scrapeGamersClubName(STEAM_ID);

      expect(name).toBeNull();
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });

  it('returns null without calling axios when the session cookie env var is missing', async () => {
    delete process.env.GAMERSCLUB_SESSION_COOKIE;

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockedSetCachedGcName).not.toHaveBeenCalled();
  });

  it('returns null and caches a confirmed miss when the search responds 2xx (no redirect = player not found)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: '',
    });

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBeNull();
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedSetCachedGcName).toHaveBeenCalledWith(STEAM_ID, null);
  });

  it('does NOT cache when the search returns an unexpected/ambiguous status', async () => {
    // Bypasses the real validateStatus (axios itself is mocked here), so
    // this exercises resolvePlayerUrl's 'unknown' branch directly — a
    // status that isn't 2xx or 307 slipping through.
    mockedAxios.get.mockResolvedValueOnce({
      status: 418,
      headers: {},
      data: '',
    });

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBeNull();
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedSetCachedGcName).not.toHaveBeenCalled();
  });

  it('follows the 307 redirect, fetches the profile, extracts and caches the name', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        status: 307,
        headers: { location: '/player/123' },
        data: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: `
          <div class="gc-list-item">
            <h6 class="gc-list-title">Nome</h6>
            <p class="gc-list-text">João Teste</p>
          </div>
        `,
      });

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBe('João Teste');
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      2,
      'https://gamersclub.com.br/player/123',
      expect.anything(),
    );
    expect(mockedSetCachedGcName).toHaveBeenCalledWith(STEAM_ID, 'João Teste');
  });

  it('does NOT treat the 307 redirect as a retry-worthy error (regression check for the old try/catch flow)', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        status: 307,
        headers: { location: '/player/123' },
        data: '',
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: '<div></div>' });

    await scrapeGamersClubName(STEAM_ID);

    // Exactly 2 calls (search + profile) — if the 307 were still being
    // thrown as an AxiosError and caught by withRetry, this would either
    // retry the search needlessly or throw depending on shouldRetry.
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 on the search step and eventually succeeds', async () => {
    mockedAxios.get
      .mockRejectedValueOnce(makeAxiosError(429))
      .mockResolvedValueOnce({
        status: 307,
        headers: { location: '/player/123' },
        data: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: `
          <div class="gc-list-item">
            <h6 class="gc-list-title">Nome</h6>
            <p class="gc-list-text">Maria Teste</p>
          </div>
        `,
      });

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBe('Maria Teste');
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  it('gives up without retrying on a definitive 4xx error (e.g. bad/expired cookie), and does not cache', async () => {
    mockedAxios.get.mockRejectedValue(makeAxiosError(403));

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBeNull();
    // 403 is not 429/5xx -> isRetryableAxiosError says "don't retry"
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedSetCachedGcName).not.toHaveBeenCalled();
  });

  it('returns null and does NOT cache when the profile page has no matching name field', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        status: 307,
        headers: { location: '/player/123' },
        data: '',
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: '<div></div>' });

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBeNull();
    // Ambiguous outcome (page loaded fine, but the expected field wasn't
    // there) — could mean GamersClub changed their HTML, so this must
    // never get baked into a 90-day cached miss.
    expect(mockedSetCachedGcName).not.toHaveBeenCalled();
  });
});
