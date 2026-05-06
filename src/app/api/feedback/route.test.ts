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
    // Since rateLimitMap is internal and not exported, 
    // we might need to wait for time to pass or just accept it's hard to reset.
    // However, we can use fake timers to bypass the window.
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns 400 if message is missing', async () => {
    const req = {
      json: jest.fn().mockResolvedValue({ type: 'bug' }),
      headers: new Headers(),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(NextResponse.json).toHaveBeenCalledWith(
      { message: 'Invalid message.' },
      { status: 400 },
    );
  });

  it('returns 400 if type is invalid', async () => {
    const req = {
      json: jest.fn().mockResolvedValue({ message: 'test', type: 'invalid' }),
      headers: new Headers(),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(NextResponse.json).toHaveBeenCalledWith(
      { message: 'Invalid feedback type.' },
      { status: 400 },
    );
  });

  it('returns 413 if message is too long', async () => {
    const req = {
      json: jest.fn().mockResolvedValue({ message: 'a'.repeat(2001), type: 'bug' }),
      headers: new Headers(),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it('returns 429 if rate limited', async () => {
    const req = {
      json: jest.fn().mockResolvedValue({ message: 'test', type: 'bug' }),
      headers: new Headers({ 'x-real-ip': '1.2.3.4' }),
    } as any;

    // First 3 requests (max is 3)
    await POST(req);
    await POST(req);
    await POST(req);
    
    // 4th request
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(NextResponse.json).toHaveBeenCalledWith(
      { message: 'Too many requests. Try again later.' },
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
    const req = {
      json: jest.fn().mockResolvedValue(body),
      headers: new Headers({ 'x-real-ip': '5.6.7.8' }),
    } as any;

    (sendFeedbackEmail as jest.Mock).mockResolvedValueOnce(undefined);

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(sendFeedbackEmail).toHaveBeenCalledWith(expect.objectContaining({
      message: 'test message',
      type: 'suggestion',
    }));
  });

  it('returns 502 if sendFeedbackEmail fails', async () => {
    const req = {
      json: jest.fn().mockResolvedValue({ message: 'test', type: 'bug' }),
      headers: new Headers({ 'x-real-ip': '9.9.9.9' }),
    } as any;

    (sendFeedbackEmail as jest.Mock).mockRejectedValueOnce(new Error('Email failed'));

    const res = await POST(req);
    expect(res.status).toBe(502);
  });
});
