import { POST } from './route';
import { NextResponse } from 'next/server';

// Mock SteamAPI
const mockResolve = jest.fn();
const mockGetUserSummary = jest.fn();

jest.mock('steamapi', () => {
  return jest.fn().mockImplementation(() => ({
    resolve: (target: string) => mockResolve(target),
    getUserSummary: (steamId: string) => mockGetUserSummary(steamId),
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

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith('test-user');
    expect(mockGetUserSummary).toHaveBeenCalledWith('12345');
    expect(NextResponse.json).toHaveBeenCalledWith(
      { targetInfo: { nickname: 'TestUser' } },
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
});
