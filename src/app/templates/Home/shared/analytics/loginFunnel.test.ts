import {
  LOGIN_FUNNEL_CTX_COOKIE,
  getActiveLoginSearchId,
  getOrCreateAnonSessionId,
  recordLoginCta,
  setActiveLoginSearchId,
  writeLoginCtxCookie,
} from './loginFunnel';
import { parseLoginFunnelBody } from '@/app/api/analytics/input';

// jsdom keeps cookies until they expire — clear the funnel ctx between
// tests so a `toContain(cookie)` assertion can't pass on residue from a
// previous test's write.
const clearCtxCookie = () => {
  document.cookie
    .split(';')
    .map((part) => part.split('=')[0].trim())
    .forEach((name) => {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    });
};

describe('loginFunnel (Steam-login funnel instrumentation)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearCtxCookie();
    setActiveLoginSearchId(null);
    jest.restoreAllMocks();
  });

  describe('getOrCreateAnonSessionId', () => {
    it('creates a stable id reused across calls (funnel join key)', () => {
      const first = getOrCreateAnonSessionId();
      const second = getOrCreateAnonSessionId();

      expect(typeof first).toBe('string');
      expect(first!.length).toBeGreaterThan(0);
      expect(second).toBe(first);
      expect(window.localStorage.getItem('sr_anon_sid')).toBe(first);
    });

    it('falls back to a stable EPHEMERAL id when storage is blocked (not null)', () => {
      // A NULL sid would 400 at the parser, silently dropping the click —
      // the ephemeral id keeps the beacon AND pairs with the completion
      // via the ctx cookie for that login (page-reload scoped).
      jest.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });

      const first = getOrCreateAnonSessionId();
      const second = getOrCreateAnonSessionId();

      expect(typeof first).toBe('string');
      expect(first!.length).toBeGreaterThan(0);
      expect(second).toBe(first);
    });
  });

  describe('client → parser contract', () => {
    it('the exact beacon payload passes the server-side parser', async () => {
      // Links the client's payload shape to the route's validation: if
      // one side drifts (renamed field, loosened bound), this fails here
      // instead of as silently-dropped clicks in production.
      const fetchMock = jest.fn().mockResolvedValue({ ok: true });
      (global as Record<string, unknown>).fetch = fetchMock;
      try {
        setActiveLoginSearchId('search-7');

        await recordLoginCta();

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(parseLoginFunnelBody(JSON.parse(init.body as string))).toEqual({
          event: 'login_cta_clicked',
          sessionId: expect.any(String),
          searchId: 'search-7',
        });
      } finally {
        delete (global as Record<string, unknown>).fetch;
      }
    });
  });

  describe('active search store', () => {
    it('round-trips the published searchId (navbar reads what the search wrote)', () => {
      expect(getActiveLoginSearchId()).toBeNull();
      setActiveLoginSearchId('search-9');
      expect(getActiveLoginSearchId()).toBe('search-9');
      setActiveLoginSearchId(null);
      expect(getActiveLoginSearchId()).toBeNull();
    });
  });

  describe('writeLoginCtxCookie', () => {
    it('plants a short-lived readable cookie (server reads it back)', () => {
      writeLoginCtxCookie({ sessionId: 'session-1', searchId: 'search-1' });

      expect(document.cookie).toContain(`${LOGIN_FUNNEL_CTX_COOKIE}=`);
      expect(decodeURIComponent(document.cookie)).toContain('session-1');
    });
  });

  describe('recordLoginCta', () => {
    it('beacons CTA with session + active search and plants the cookie (fire-and-forget)', async () => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: true });
      (global as Record<string, unknown>).fetch = fetchMock;
      try {
        setActiveLoginSearchId('search-7');

        await recordLoginCta();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/recordAnalyticsLogin');
        expect(init.method).toBe('POST');
        expect(init.keepalive).toBe(true);
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body.event).toBe('login_cta_clicked');
        expect(typeof body.sessionId).toBe('string');
        expect(body.searchId).toBe('search-7');
        expect(document.cookie).toContain(`${LOGIN_FUNNEL_CTX_COOKIE}=`);
      } finally {
        delete (global as Record<string, unknown>).fetch;
      }
    });

    it('never throws when the beacon fails (login must proceed)', async () => {
      (global as Record<string, unknown>).fetch = jest
        .fn()
        .mockRejectedValue(new Error('offline'));

      try {
        await expect(recordLoginCta()).resolves.toBeUndefined();
      } finally {
        delete (global as Record<string, unknown>).fetch;
      }
    });
  });
});
