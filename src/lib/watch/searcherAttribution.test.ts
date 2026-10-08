/**
 * @jest-environment node
 */

import {
  hasAccountFootprint,
  readSearcherSteamId,
  resetSearcherSessionWarnForTests,
} from './searcherAttribution';

jest.mock('./session', () => ({
  getSessionSteamId: jest.fn(),
}));

jest.mock('../analytics/db', () => ({
  getAccount: jest.fn(),
}));

jest.mock('../logRouteError', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const { getSessionSteamId } = jest.requireMock('./session') as {
  getSessionSteamId: jest.Mock;
};

const { getAccount } = jest.requireMock('../analytics/db') as {
  getAccount: jest.Mock;
};

const logRouteError = jest.requireMock('../logRouteError').default as jest.Mock;

const STEAM_ID = '76561198000000001';
const store = {} as never;

describe('readSearcherSteamId (history attribution gate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSearcherSessionWarnForTests();
    getSessionSteamId.mockResolvedValue(null);
  });

  it('returns null for guests without touching the DB (zero cost)', async () => {
    await expect(readSearcherSteamId(store)).resolves.toBeNull();
    expect(getAccount).not.toHaveBeenCalled();
    expect(logRouteError).not.toHaveBeenCalled();
  });

  it('passes the session id through (footprint enforced atomically at INSERT)', async () => {
    // Deliberately NO footprint check here: recordSearch attributes via
    // a subquery inside the write transaction (no TOCTOU, no extra
    // round-trip). This gate only proves "logged in".
    getSessionSteamId.mockResolvedValue(STEAM_ID);

    await expect(readSearcherSteamId(store)).resolves.toBe(STEAM_ID);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('returns null on session failure and warns once per process', async () => {
    getSessionSteamId.mockRejectedValue(new Error('seal blown'));

    await expect(readSearcherSteamId(store)).resolves.toBeNull();
    await expect(readSearcherSteamId(store)).resolves.toBeNull();
    expect(logRouteError).toHaveBeenCalledTimes(1);
    expect(String(logRouteError.mock.calls[0][1])).toContain(
      'searcher attribution skipped',
    );

    resetSearcherSessionWarnForTests();
    await expect(readSearcherSteamId(store)).resolves.toBeNull();
    expect(logRouteError).toHaveBeenCalledTimes(2);
  });
});

describe('hasAccountFootprint (shared opt-out predicate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is true for any existing account row, false for none', async () => {
    getAccount.mockResolvedValue({ steamId: STEAM_ID });
    await expect(hasAccountFootprint(STEAM_ID)).resolves.toBe(true);

    getAccount.mockResolvedValue(null);
    await expect(hasAccountFootprint(STEAM_ID)).resolves.toBe(false);

    expect(getAccount).toHaveBeenCalledTimes(2);
    expect(getAccount).toHaveBeenCalledWith(STEAM_ID);
  });

  it('throws on DB failure (callers own the error policy)', async () => {
    getAccount.mockRejectedValue(new Error('turso blip'));

    await expect(hasAccountFootprint(STEAM_ID)).rejects.toThrow(
      'turso blip',
    );
  });
});
