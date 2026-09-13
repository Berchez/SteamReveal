/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('@/lib/analytics/db', () => ({
  consumeConfirmToken: jest.fn(),
  getAccount: jest.fn(),
  hashConfirmToken: jest.fn((token: string) => `hash:${token}`),
}));

jest.mock('@/lib/rateLimit', () => {
  const isRateLimited = jest.fn(() => false);
  return {
    createRateLimiter: jest.fn().mockReturnValue({ isRateLimited }),
    getRequestIp: jest.fn(() => 'test-ip'),
    __testIsRateLimited: isRateLimited,
  };
});

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/watch/session', () => ({
  saveWatchSession: jest.fn(),
}));

const mockedDb = jest.requireMock('@/lib/analytics/db') as {
  consumeConfirmToken: jest.Mock;
  getAccount: jest.Mock;
  hashConfirmToken: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const { saveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  saveWatchSession: jest.Mock;
};

const STEAM_ID = '76561198000000001';
const BASE = 'http://localhost:3000/api/watch/confirm';
const TOKEN = 'ab'.repeat(32);

describe('GET /api/watch/confirm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    mockedDb.consumeConfirmToken.mockResolvedValue(STEAM_ID);
    mockedDb.getAccount.mockResolvedValue({ locale: null });
    saveWatchSession.mockResolvedValue(undefined);
  });

  it('consumes a valid token, seals the session, and lands on the signup locale', async () => {
    mockedDb.getAccount.mockResolvedValue({ locale: 'pt' });

    const res = await GET(new Request(`${BASE}?token=${TOKEN}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
    // Only the hash travels to the DAL — plaintext never touches storage.
    expect(mockedDb.hashConfirmToken).toHaveBeenCalledWith(TOKEN);
    expect(mockedDb.consumeConfirmToken).toHaveBeenCalledWith(`hash:${TOKEN}`);
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('falls back to the bare home when the account has no locale', async () => {
    mockedDb.getAccount.mockResolvedValue({ locale: null });

    const res = await GET(new Request(`${BASE}?token=${TOKEN}`));

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=ok',
    );
  });

  it('never lands a hostile stored locale under a garbage path', async () => {
    mockedDb.getAccount.mockResolvedValue({ locale: 'xx' });

    const hostile = await GET(new Request(`${BASE}?token=${TOKEN}`));
    expect(hostile.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=ok',
    );

    mockedDb.getAccount.mockResolvedValue({ locale: 'pt-BR' });
    const variant = await GET(new Request(`${BASE}?token=${TOKEN}`));
    expect(variant.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
  });

  it('consumes a linkifier-mangled token (trailing punctuation stripped)', async () => {
    // Steam chat glues the sentence period into the clickable link —
    // the 65-char arrival must still consume the exact valid prefix.
    mockedDb.getAccount.mockResolvedValue({ locale: 'en' });

    const res = await GET(new Request(`${BASE}?token=${TOKEN}.`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/en/?confirmed=ok',
    );
    expect(mockedDb.consumeConfirmToken).toHaveBeenCalledWith(`hash:${TOKEN}`);
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('answers every failure identically (no oracle for probers)', async () => {
    // Malformed token: rejected before any DAL call.
    const malformed = await GET(new Request(`${BASE}?token=nope`));
    expect(malformed.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );

    // Unknown/expired/consumed: same redirect, no session.
    mockedDb.consumeConfirmToken.mockResolvedValue(null);
    const unknown = await GET(new Request(`${BASE}?token=${TOKEN}`));
    expect(unknown.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );

    // Missing token entirely.
    const missing = await GET(new Request(BASE));
    expect(missing.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );

    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('redirects to error (never 500s the browser flow) when the DAL throws', async () => {
    mockedDb.consumeConfirmToken.mockRejectedValue(new Error('db down'));

    const res = await GET(new Request(`${BASE}?token=${TOKEN}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('still lands ok when the session seal fails after consumption (dead-link guard)', async () => {
    saveWatchSession.mockRejectedValue(new Error('cookie store down'));
    mockedDb.getAccount.mockResolvedValue({ locale: 'pt' });

    const res = await GET(new Request(`${BASE}?token=${TOKEN}`));

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
  });

  it('still lands ok (bare home) when the locale read fails after consumption', async () => {
    // getAccount is display-only: a transient read blip must not convert
    // an already-consumed token into an "invalid link" error for a user
    // who is already confirmed (and whose session above already sealed).
    mockedDb.getAccount.mockRejectedValue(new Error('turso blip'));

    const res = await GET(new Request(`${BASE}?token=${TOKEN}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=ok',
    );
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('rejects non-GET methods and rate-limited callers', async () => {
    const wrongMethod = await GET(new Request(BASE, { method: 'POST' }));
    expect(wrongMethod.status).toBe(405);

    __testIsRateLimited.mockReturnValue(true);
    const limited = await GET(new Request(`${BASE}?token=${TOKEN}`));
    expect(limited.status).toBe(429);
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();
  });
});
