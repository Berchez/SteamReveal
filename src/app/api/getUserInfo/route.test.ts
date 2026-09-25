import { POST } from './route';
import { NextResponse } from 'next/server';

// Mock SteamAPI
const mockResolve = jest.fn();
const mockGetUserSummary = jest.fn();
const mockGetUserOwnedGames = jest.fn();

jest.mock('steamapi', () => {
  return jest.fn().mockImplementation(() => ({
    resolve: (target: string) => mockResolve(target),
    getUserSummary: (steamId: string) => mockGetUserSummary(steamId),
    getUserOwnedGames: (steamId: string) => mockGetUserOwnedGames(steamId),
  }));
});

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body, init) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

// The route now calls getRequestIp(req) before doing anything else (item
// 10 of the ticket), so every req mock needs a real Headers instance —
// without it, req.headers.get(...) throws before validation even runs.
const makeReq = (body: unknown, ip = '1.2.3.4') =>
  ({
    method: 'POST',
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers({ 'x-real-ip': ip }),
  }) as any;

describe('POST /api/getUserInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 if target is missing', async () => {
    // Was asserting 500 here — that was Bug #1 from the ticket (invalid
    // client input incorrectly reported as a server error). The route now
    // correctly returns 400 with the standardized error shape.
    const req = makeReq({});

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: { message: 'Invalid target.', code: 'INVALID_REQUEST' } },
      { status: 400 },
    );
  });

  it('returns targetInfo on success', async () => {
    const req = makeReq({ target: 'test-user' });

    mockResolve.mockResolvedValue('12345');
    mockGetUserSummary.mockResolvedValue({ nickname: 'TestUser' });
    mockGetUserOwnedGames.mockResolvedValue([
      { game: { name: 'Counter-Strike 2' }, minutes: 50000 },
      { game: { name: 'Dota 2' }, minutes: 1200 },
    ]);

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith('test-user');
    expect(mockGetUserSummary).toHaveBeenCalledWith('12345');
    expect(mockGetUserOwnedGames).toHaveBeenCalledWith('12345');
    expect(NextResponse.json).toHaveBeenCalledWith(
      {
        targetInfo: expect.objectContaining({
          nickname: 'TestUser',
          gamesSnapshot: expect.arrayContaining([
            expect.objectContaining({
              name: 'Counter-Strike 2',
              playtimeHours: 833.3,
            }),
          ]),
          isCSActive: true,
        }),
      },
      { status: 200 },
    );
  });

  it('returns 500 if SteamAPI fails', async () => {
    const req = makeReq({ target: 'test-user' });

    mockResolve.mockRejectedValue(new Error('Steam Error'));

    const res = await POST(req);
    expect(res.status).toBe(500);
    expect(NextResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INTERNAL_ERROR' }),
      }),
      { status: 500 },
    );
  });
});

describe('POST /api/getUserInfo — error classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 INVALID_REQUEST when steam.resolve throws "Invalid format"', async () => {
    const req = makeReq({ target: 'lixo_invalido' });
    mockResolve.mockRejectedValue(new TypeError('Invalid format'));

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(NextResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'INVALID_REQUEST' }),
      }),
      { status: 400 },
    );
  });

  it('returns 400 INVALID_REQUEST when targetInfo comes back falsy', async () => {
    const req = makeReq({ target: 'test-user' });
    mockResolve.mockResolvedValue('12345');
    mockGetUserSummary.mockResolvedValue(null);

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range 17-digit target with 400 before ANY Steam call', async () => {
    // The production garbage (2026-09 ops log): 17 digits but outside the
    // SteamID64 span — it used to ride resolve()'s pass-through into a
    // 500 "No players found" + "Bad Request" error logs.
    const req = makeReq({ target: '44846128515546448' });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockGetUserSummary).not.toHaveBeenCalled();
  });

  it('returns 400 (not 500) when Steam says the profile does not exist', async () => {
    // In-range ID, no profile: "No players found" is client input, not a
    // server incident — same invalidPlayer outcome on the client, but an
    // honest status and no INTERNAL_ERROR line in the ops log.
    const req = makeReq({ target: '76561199999999999' });
    mockResolve.mockResolvedValue('76561199999999999');
    mockGetUserSummary.mockRejectedValue(new Error('No players found'));

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: { message: 'Invalid target.', code: 'INVALID_REQUEST' } },
      { status: 400 },
    );
  });

  it('warns (never error-logs) when the owned-games failure is data-unavailability', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    const req = makeReq({ target: 'test-user' });
    mockResolve.mockResolvedValue('12345');
    mockGetUserSummary.mockResolvedValue({ nickname: 'TestUser' });
    mockGetUserOwnedGames.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'map')"),
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
    // Benign (private library): warn, and the fetch still succeeds.
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // Same for the other benign shape (bogus/gone profile): no error-log.
    mockGetUserOwnedGames.mockRejectedValueOnce(new Error('Bad Request'));
    const res2 = await POST(req);
    expect(res2.status).toBe(200);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});
