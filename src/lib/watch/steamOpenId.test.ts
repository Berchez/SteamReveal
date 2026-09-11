/**
 * @jest-environment node
 */

import {
  buildSteamLoginUrl,
  extractSteamIdFromClaimedId,
  isFreshResponseNonce,
  isSafeNextPath,
  STEAM_OPENID_ENDPOINT,
  verifySteamAssertion,
} from './steamOpenId';

const STEAM = '76561198000000001';
const CLAIMED = `https://steamcommunity.com/openid/id/${STEAM}`;

describe('buildSteamLoginUrl', () => {
  it('builds a complete checkid_setup URL with encoded return_to/realm', () => {
    const url = new URL(
      buildSteamLoginUrl({
        returnTo:
          'https://reveal.example/api/auth/steam/callback?next=/pt/watch',
        realm: 'https://reveal.example',
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(STEAM_OPENID_ENDPOINT);
    expect(url.searchParams.get('openid.ns')).toBe(
      'http://specs.openid.net/auth/2.0',
    );
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(url.searchParams.get('openid.return_to')).toBe(
      'https://reveal.example/api/auth/steam/callback?next=/pt/watch',
    );
    expect(url.searchParams.get('openid.realm')).toBe('https://reveal.example');
    expect(url.searchParams.get('openid.identity')).toBe(
      'http://specs.openid.net/auth/2.0/identifier_select',
    );
    expect(url.searchParams.get('openid.claimed_id')).toBe(
      'http://specs.openid.net/auth/2.0/identifier_select',
    );
  });
});

describe('isSafeNextPath', () => {
  it.each([['/watch'], ['/pt/watch'], ['/'], ['/a/b?c=d']])(
    'accepts internal path %p',
    (value) => {
      expect(isSafeNextPath(value)).toBe(true);
    },
  );

  it.each([
    ['https://evil.example/'],
    ['//evil.example/'],
    ['/\\evil.example/'],
    ['/watch\nSet-Cookie: x=1'],
    ['/watch with space'],
    ['/watch\0null'],
    ['/watch#frag'],
    ['/watch@evil'],
    ['/watch:80'],
    [''],
    [null],
    [undefined],
    [42],
  ])('rejects %p', (value) => {
    expect(isSafeNextPath(value)).toBe(false);
  });
});

describe('isFreshResponseNonce', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');
  const fresh = (offsetMs: number): string =>
    `${new Date(now + offsetMs).toISOString()}suffix`;

  it('accepts recent nonces', () => {
    expect(isFreshResponseNonce(fresh(0), now)).toBe(true);
    expect(isFreshResponseNonce(fresh(-9 * 60 * 1000), now)).toBe(true);
  });

  it('rejects missing, malformed, stale, and far-future nonces', () => {
    expect(isFreshResponseNonce(undefined, now)).toBe(false);
    expect(isFreshResponseNonce(null, now)).toBe(false);
    expect(isFreshResponseNonce('', now)).toBe(false);
    expect(isFreshResponseNonce('short', now)).toBe(false);
    expect(isFreshResponseNonce('not-a-timestamp-123456', now)).toBe(false);
    // Stale by 11 minutes (window is 10).
    expect(isFreshResponseNonce(fresh(-11 * 60 * 1000), now)).toBe(false);
    // A day old: the replay class this gate exists for.
    expect(isFreshResponseNonce(fresh(-24 * 60 * 60 * 1000), now)).toBe(false);
    // Far-future forgery attempt (beyond clock-skew tolerance).
    expect(isFreshResponseNonce(fresh(60 * 60 * 1000), now)).toBe(false);
  });

  it('rejects stale assertions before contacting Steam (no network spent)', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      text: async () => 'is_valid:true',
    });
    try {
      await expect(
        verifySteamAssertion({
          'openid.ns': 'http://specs.openid.net/auth/2.0',
          'openid.mode': 'id_res',
          'openid.claimed_id': CLAIMED,
          'openid.response_nonce': `${new Date(
            Date.now() - 60 * 60 * 1000,
          ).toISOString()}old`,
          'openid.sig': 'sig-bytes',
        }),
      ).resolves.toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('extractSteamIdFromClaimedId', () => {
  it('extracts the id from a well-formed claimed_id', () => {
    expect(extractSteamIdFromClaimedId(CLAIMED)).toBe(STEAM);
  });

  it.each([
    [''],
    ['nope'],
    ['https://evil.example/openid/id/76561198000000001'],
    [`https://steamcommunity.com/openid/id/123`],
    [null],
    [undefined],
    [42],
  ])('rejects %p', (value) => {
    expect(extractSteamIdFromClaimedId(value)).toBeNull();
  });
});

describe('verifySteamAssertion', () => {
  const assertion = {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.claimed_id': CLAIMED,
    'openid.response_nonce': `${new Date().toISOString()}unique-nonce`,
    'openid.sig': 'sig-bytes',
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('replays with check_authentication and returns the id on is_valid:true', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      text: async () => 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n',
    });

    await expect(verifySteamAssertion(assertion)).resolves.toBe(STEAM);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(STEAM_OPENID_ENDPOINT);
    expect(init.method).toBe('POST');
    const sent = new URLSearchParams(init.body as string);
    // Forwards what Steam sent, switching ONLY the mode.
    expect(sent.get('openid.mode')).toBe('check_authentication');
    expect(sent.get('openid.claimed_id')).toBe(CLAIMED);
    expect(sent.get('openid.sig')).toBe('sig-bytes');
  });

  it('never forwards non-openid params to Steam (auth-only keys stay local)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      text: async () => 'is_valid:true',
    });

    await verifySteamAssertion({
      ...assertion,
      next: '/pt/watch',
      state: 'abc',
    });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const sent = new URLSearchParams(init.body as string);
    expect(sent.has('next')).toBe(false);
    expect(sent.has('state')).toBe(false);
  });

  it('returns null on is_valid:false (forged or stale assertion)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      text: async () => 'ns:http://specs.openid.net/auth/2.0\nis_valid:false\n',
    });

    await expect(verifySteamAssertion(assertion)).resolves.toBeNull();
  });

  it('returns null without contacting Steam when required fields are missing', async () => {
    await expect(
      verifySteamAssertion({ 'openid.mode': 'id_res' }),
    ).resolves.toBeNull();
    await expect(
      verifySteamAssertion({
        ...assertion,
        'openid.claimed_id': 'https://evil.example/x',
      }),
    ).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects loudly on transport failure (caller redirects to error)', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('socket hang up'));

    await expect(verifySteamAssertion(assertion)).rejects.toThrow(
      /verification unreachable/,
    );
  });
});
