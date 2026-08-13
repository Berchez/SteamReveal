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

jest.mock('axios');
jest.mock('./getErrorMessage', () => ({
  __esModule: true,
  default: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

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

  it('returns null without calling axios when the session cookie env var is missing', async () => {
    delete process.env.GAMERSCLUB_SESSION_COOKIE;

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('returns null when the search responds 2xx (no redirect = player not found)', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: '',
    });

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBeNull();
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('follows the 307 redirect, fetches the profile, and extracts the name', async () => {
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

  it('gives up without retrying on a definitive 4xx error (e.g. bad/expired cookie)', async () => {
    mockedAxios.get.mockRejectedValue(makeAxiosError(403));

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBeNull();
    // 403 is not 429/5xx -> isRetryableAxiosError says "don't retry"
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('returns null when the profile page has no matching name field', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        status: 307,
        headers: { location: '/player/123' },
        data: '',
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: '<div></div>' });

    const name = await scrapeGamersClubName(STEAM_ID);

    expect(name).toBeNull();
  });
});
