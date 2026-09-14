/**
 * @jest-environment node
 */

import { CONFIRM_PAGE_TEXT, GET, POST } from './route';
import { WATCH_LOCALES } from '@/lib/watch/notificationText';

jest.mock('@/lib/analytics/db', () => ({
  activateWatch: jest.fn(),
  consumeConfirmToken: jest.fn(),
  enqueueEvent: jest.fn(),
  getAccount: jest.fn(),
  getAccountByConfirmTokenHash: jest.fn(),
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
  activateWatch: jest.Mock;
  consumeConfirmToken: jest.Mock;
  enqueueEvent: jest.Mock;
  getAccount: jest.Mock;
  getAccountByConfirmTokenHash: jest.Mock;
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
const ORIGIN = 'http://localhost:3000';
const TOKEN = 'ab'.repeat(32);
const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

const postRequest = (token: string | null, origin: string | null = ORIGIN) => {
  const url = token === null ? BASE : `${BASE}?token=${token}`;
  const headers: Record<string, string> = {};
  if (origin !== null) headers.origin = origin;
  return new Request(url, { method: 'POST', headers });
};

describe('GET /api/watch/confirm (intermediate page, never mutates)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    mockedDb.getAccountByConfirmTokenHash.mockResolvedValue({
      locale: 'en',
      confirmExpiresAt: FUTURE,
    });
  });

  it('renders the confirm page without consuming, activating, or sealing', async () => {
    mockedDb.getAccountByConfirmTokenHash.mockResolvedValue({
      locale: 'pt',
      confirmExpiresAt: FUTURE,
    });

    const res = await GET(new Request(`${BASE}?token=${TOKEN}`));

    // A prefetched GET is just a page: prefetch can never spend the token
    // (and, now that activation gates on the click, never activate).
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain(
      `<form method="post" action="/api/watch/confirm?token=${TOKEN}">`,
    );
    expect(html).toContain('Confirmar e ativar');
    expect(mockedDb.getAccountByConfirmTokenHash).toHaveBeenCalledWith(
      `hash:${TOKEN}`,
    );
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();
    expect(mockedDb.activateWatch).not.toHaveBeenCalled();
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('strips linkifier punctuation on GET too (form carries the clean token)', async () => {
    const res = await GET(new Request(`${BASE}?token=${TOKEN}.`));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      `<form method="post" action="/api/watch/confirm?token=${TOKEN}">`,
    );
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();
  });

  it('renders the expired variant (no form) for spent-window tokens', async () => {
    mockedDb.getAccountByConfirmTokenHash.mockResolvedValue({
      locale: 'pt',
      confirmExpiresAt: PAST,
    });

    const res = await GET(new Request(`${BASE}?token=${TOKEN}`));

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Este link expirou');
    expect(html).not.toContain('<form');
    expect(html).toContain('href="/pt/"');
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();
  });

  it('renders the same form for unknown hashes (no oracle for probers)', async () => {
    mockedDb.getAccountByConfirmTokenHash.mockResolvedValue(null);

    const res = await GET(new Request(`${BASE}?token=${TOKEN}`));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<form');
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();
  });

  it('redirects malformed/missing tokens to error without any DAL read', async () => {
    const malformed = await GET(new Request(`${BASE}?token=nope`));
    expect(malformed.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );

    const missing = await GET(new Request(BASE));
    expect(missing.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );

    expect(
      mockedDb.getAccountByConfirmTokenHash,
    ).not.toHaveBeenCalled();
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();
  });

  it('fails closed to error when the account read throws', async () => {
    mockedDb.getAccountByConfirmTokenHash.mockRejectedValue(
      new Error('db down'),
    );

    const res = await GET(new Request(`${BASE}?token=${TOKEN}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();
  });

  it('rejects non-GET methods and rate-limited callers', async () => {
    const wrongMethod = await GET(new Request(BASE, { method: 'POST' }));
    expect(wrongMethod.status).toBe(405);

    __testIsRateLimited.mockReturnValue(true);
    const limited = await GET(new Request(`${BASE}?token=${TOKEN}`));
    expect(limited.status).toBe(429);
    expect(
      mockedDb.getAccountByConfirmTokenHash,
    ).not.toHaveBeenCalled();
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();
  });
});

describe('POST /api/watch/confirm (the click: consume + activate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    mockedDb.consumeConfirmToken.mockResolvedValue(STEAM_ID);
    mockedDb.activateWatch.mockResolvedValue(true);
    mockedDb.enqueueEvent.mockResolvedValue({ eventId: 9, duplicate: false });
    mockedDb.getAccount.mockResolvedValue({ locale: null });
    saveWatchSession.mockResolvedValue(undefined);
  });

  it('consumes, activates, enqueues welcome, seals, lands on signup locale', async () => {
    mockedDb.getAccount.mockResolvedValue({ locale: 'pt' });

    const res = await POST(postRequest(TOKEN));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
    // Only the hash travels to the DAL — plaintext never touches storage.
    expect(mockedDb.hashConfirmToken).toHaveBeenCalledWith(TOKEN);
    expect(mockedDb.consumeConfirmToken).toHaveBeenCalledWith(`hash:${TOKEN}`);
    // Click-to-activate: friendship alone no longer flips the status.
    expect(mockedDb.activateWatch).toHaveBeenCalledWith(STEAM_ID);
    // Bot welcome goes through the outbox (the site cannot reach chat).
    expect(mockedDb.enqueueEvent).toHaveBeenCalledWith(STEAM_ID, 'welcome');
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('consumes a linkifier-mangled token (trailing punctuation stripped)', async () => {
    mockedDb.getAccount.mockResolvedValue({ locale: 'en' });

    const res = await POST(postRequest(`${TOKEN}.`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/en/?confirmed=ok',
    );
    expect(mockedDb.consumeConfirmToken).toHaveBeenCalledWith(`hash:${TOKEN}`);
    expect(mockedDb.activateWatch).toHaveBeenCalledWith(STEAM_ID);
  });

  it('falls back to the bare home when the account has no locale', async () => {
    mockedDb.getAccount.mockResolvedValue({ locale: null });

    const res = await POST(postRequest(TOKEN));

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=ok',
    );
  });

  it('never lands a hostile stored locale under a garbage path', async () => {
    mockedDb.getAccount.mockResolvedValue({ locale: 'xx' });

    const hostile = await POST(postRequest(TOKEN));
    expect(hostile.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=ok',
    );

    mockedDb.getAccount.mockResolvedValue({ locale: 'pt-BR' });
    const variant = await POST(postRequest(TOKEN));
    expect(variant.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
  });

  it('answers every failure identically (no oracle for probers)', async () => {
    const malformed = await POST(postRequest('nope'));
    expect(malformed.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );

    // Unknown/expired/consumed: same redirect, nothing activated.
    mockedDb.consumeConfirmToken.mockResolvedValue(null);
    const unknown = await POST(postRequest(TOKEN));
    expect(unknown.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );

    const missing = await POST(postRequest(null));
    expect(missing.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );

    expect(mockedDb.activateWatch).not.toHaveBeenCalled();
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('rejects cross-origin POSTs, wrong methods, and rate-limited callers', async () => {
    const evil = await POST(postRequest(TOKEN, 'https://evil.example'));
    expect(evil.status).toBe(403);
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();

    const noOrigin = await POST(postRequest(TOKEN, null));
    expect(noOrigin.status).toBe(403);

    const wrongMethod = await POST(
      new Request(BASE, { method: 'DELETE', headers: { origin: ORIGIN } }),
    );
    expect(wrongMethod.status).toBe(405);

    __testIsRateLimited.mockReturnValue(true);
    const limited = await POST(postRequest(TOKEN));
    expect(limited.status).toBe(429);
    expect(mockedDb.consumeConfirmToken).not.toHaveBeenCalled();
  });

  it('redirects to error (never 500s the browser flow) when consume throws', async () => {
    mockedDb.consumeConfirmToken.mockRejectedValue(new Error('db down'));

    const res = await POST(postRequest(TOKEN));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=error',
    );
    expect(mockedDb.activateWatch).not.toHaveBeenCalled();
    expect(saveWatchSession).not.toHaveBeenCalled();
  });

  it('still lands ok when the watch row vanished mid-click (opt-out race)', async () => {
    // Confirmed + session sealed, but nothing to activate: punish nothing,
    // the user can Start a fresh request. The loud log is the audit trail.
    // No welcome enqueued either (nothing to welcome; backstop-owned flips
    // welcome via onActivated instead).
    mockedDb.activateWatch.mockResolvedValue(false);
    mockedDb.getAccount.mockResolvedValue({ locale: 'pt' });

    const res = await POST(postRequest(TOKEN));

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('still lands ok when activation throws (reconcile backstop heals it)', async () => {
    // Pending + friend + confirmed converges on the bot's next pass, so a
    // transient DAL blip here must not strand a confirmed user on a spent
    // token with an "invalid link" error.
    mockedDb.activateWatch.mockRejectedValue(new Error('turso blip'));
    mockedDb.getAccount.mockResolvedValue({ locale: 'pt' });

    const res = await POST(postRequest(TOKEN));

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('still lands ok when the welcome enqueue fails (garnish, not gate)', async () => {
    mockedDb.enqueueEvent.mockRejectedValue(new Error('outbox down'));
    mockedDb.getAccount.mockResolvedValue({ locale: 'pt' });

    const res = await POST(postRequest(TOKEN));

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
    // Retried to the cap before giving up loudly (a single blip must not
    // eat the only welcome — nothing will ever re-emit it).
    expect(mockedDb.enqueueEvent).toHaveBeenCalledTimes(3);
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('absorbs a transient welcome-enqueue blip within the retries', async () => {
    mockedDb.enqueueEvent
      .mockRejectedValueOnce(new Error('blip one'))
      .mockRejectedValueOnce(new Error('blip two'))
      .mockResolvedValueOnce({ eventId: 9, duplicate: false });
    mockedDb.getAccount.mockResolvedValue({ locale: 'pt' });

    const res = await POST(postRequest(TOKEN));

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
    expect(mockedDb.enqueueEvent).toHaveBeenCalledTimes(3);
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });

  it('still lands ok when the session seal fails after consumption (dead-link guard)', async () => {
    saveWatchSession.mockRejectedValue(new Error('cookie store down'));
    mockedDb.getAccount.mockResolvedValue({ locale: 'pt' });

    const res = await POST(postRequest(TOKEN));

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/pt/?confirmed=ok',
    );
  });

  it('still lands ok (bare home) when the locale read fails after consumption', async () => {
    // getAccount is display-only: a transient read blip must not convert
    // an already-consumed token into an 'error' landing that tells
    // a confirmed, logged-in user their link was invalid.
    mockedDb.getAccount.mockRejectedValue(new Error('turso blip'));

    const res = await POST(postRequest(TOKEN));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/?confirmed=ok',
    );
    expect(saveWatchSession).toHaveBeenCalledTimes(1);
  });
});

describe('CONFIRM_PAGE_TEXT locale parity', () => {
  it('covers exactly the 5 supported locales', () => {
    expect(Object.keys(CONFIRM_PAGE_TEXT).sort()).toEqual(
      [...WATCH_LOCALES].sort(),
    );
  });

  it.each([...WATCH_LOCALES])(
    'carries every field, non-empty, in %s (lang matches key)',
    (locale) => {
      const text = CONFIRM_PAGE_TEXT[locale];
      expect(text.lang).toBe(locale);
      for (const field of [
        'title',
        'body',
        'button',
        'expiredTitle',
        'expiredBody',
        'homeLink',
      ] as const) {
        expect(typeof text[field]).toBe('string');
        expect(text[field].length).toBeGreaterThan(0);
      }
    },
  );
});

describe('confirm rate limiter budgets', () => {
  it('uses separate instances (and budgets) for the page (GET) and the click (POST)', async () => {
    // A burst of third-party GETs (prefetchers behind shared NAT/VPN
    // egress) must never eat a legitimate click's POST budget: the legs
    // consult independent instances.
    jest.resetModules();
    const freshRateLimit = jest.requireMock('@/lib/rateLimit') as {
      createRateLimiter: jest.Mock;
    };
    await import('./route');
    expect(freshRateLimit.createRateLimiter.mock.calls).toEqual([
      [60000, 30],
      [60000, 10],
    ]);
  });
});
