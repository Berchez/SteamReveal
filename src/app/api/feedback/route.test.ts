import { POST } from './route';
import { NextResponse } from 'next/server';
import sendFeedbackEmail from './utils';

jest.mock('./utils');
jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body, init) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

describe('POST /api/feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Since the rate limiter's store is internal and not exported, we
    // can't reset it between tests. We use fake timers so time-based
    // window resets are under our control instead of depending on wall
    // clock time between test runs.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // The route now has an explicit `if (req.method !== 'POST')` check (it
  // didn't before — Next.js used to route only POST here implicitly), so
  // every req mock needs `method: 'POST'` or it 405s before reaching
  // validation.
  const makeReq = (body: unknown, headers: HeadersInit = {}) =>
    ({
      method: 'POST',
      json: jest.fn().mockResolvedValue(body),
      headers: new Headers(headers),
    }) as any;

  it('returns 400 if message is missing', async () => {
    const req = makeReq({ type: 'bug' });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(NextResponse.json).toHaveBeenCalledWith(
      { error: { message: 'Invalid message.', code: 'INVALID_REQUEST' } },
      { status: 400 },
    );
  });

  it('returns 400 if type is invalid', async () => {
    const req = makeReq({ message: 'test', type: 'invalid' });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(NextResponse.json).toHaveBeenCalledWith(
      {
        error: { message: 'Invalid feedback type.', code: 'INVALID_REQUEST' },
      },
      { status: 400 },
    );
  });

  it('returns 413 if message is too long', async () => {
    const req = makeReq({ message: 'a'.repeat(2001), type: 'bug' });

    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it('returns 429 if rate limited', async () => {
    const req = makeReq(
      { message: 'test', type: 'bug' },
      { 'x-real-ip': '1.2.3.4' },
    );

    // First 3 requests (max is 3)
    await POST(req);
    await POST(req);
    await POST(req);

    // 4th request
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(NextResponse.json).toHaveBeenCalledWith(
      {
        error: {
          message: 'Too many requests. Try again later.',
          code: 'RATE_LIMITED',
        },
      },
      { status: 429 },
    );
  });

  it('returns 200 and calls sendFeedbackEmail on success', async () => {
    const body = {
      message: 'test message',
      type: 'suggestion',
      page: '/test',
      language: 'en',
      userAgent: 'agent',
    };
    const req = makeReq(body, { 'x-real-ip': '5.6.7.8' });

    (sendFeedbackEmail as jest.Mock).mockResolvedValueOnce(undefined);

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(sendFeedbackEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'test message',
        type: 'suggestion',
      }),
    );
  });

  it('returns 502 if sendFeedbackEmail fails', async () => {
    const req = makeReq(
      { message: 'test', type: 'bug' },
      { 'x-real-ip': '9.9.9.9' },
    );

    (sendFeedbackEmail as jest.Mock).mockRejectedValueOnce(
      new Error('Email failed'),
    );

    const res = await POST(req);
    expect(res.status).toBe(502);
  });
});
