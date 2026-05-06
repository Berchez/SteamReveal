import { POST } from './route';
import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';

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

describe('POST /api/getUserInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 500 if target is missing', async () => {
    const req = {
      method: 'POST',
      json: jest.fn().mockResolvedValue({}),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(500);
    expect(NextResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Invalid target. ' }),
      { status: 500 },
    );
  });

  it('returns targetInfo on success', async () => {
    const req = {
      method: 'POST',
      json: jest.fn().mockResolvedValue({ target: 'test-user' }),
    } as any;

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
    const req = {
      method: 'POST',
      json: jest.fn().mockResolvedValue({ target: 'test-user' }),
    } as any;

    mockResolve.mockRejectedValue(new Error('Steam Error'));

    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
