import { POST } from './route';
import { NextResponse } from 'next/server';
import axios from 'axios';

jest.mock('axios');
jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body, init) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

describe('POST /api/recordAnalyticsCheater', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, ANALYTICS_SKIP_PASSWORD: 'test-password' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('skips analytics recording if the skip header matches the password', async () => {
    const req = {
      method: 'POST',
      headers: {
        get: jest.fn((name) => {
          if (name === 'x-analytics-skip-password') {
            return 'test-password';
          }
          return null;
        }),
      },
      json: jest.fn(),
    } as any;

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('proceeds with analytics recording if the skip header does not match', async () => {
    process.env.LOCAL_PROXY_URL = 'http://localhost:3001';
    (axios.post as jest.Mock).mockResolvedValueOnce({ data: { ok: true } });

    const req = {
      method: 'POST',
      headers: {
        get: jest.fn((name) => {
          if (name === 'x-analytics-skip-password') {
            return 'wrong-password';
          }
          return null;
        }),
      },
      json: jest.fn().mockResolvedValue({
        searchId: '123',
        score: 0.5,
      }),
    } as any;

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(axios.post).toHaveBeenCalled();
  });

  it('returns 400 if searchId or score is missing', async () => {
    const req = {
      method: 'POST',
      headers: {
        get: jest.fn(() => null),
      },
      json: jest.fn().mockResolvedValue({ searchId: '123' }),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
