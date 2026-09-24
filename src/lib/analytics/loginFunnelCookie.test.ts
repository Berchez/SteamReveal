import {
  LOGIN_FUNNEL_CTX_COOKIE,
  LOGIN_FUNNEL_CTX_MAX_AGE_SECONDS,
  parseLoginCtx,
  readLoginCtxFromStore,
} from './loginFunnelCookie';

const VALID_CTX = encodeURIComponent(
  JSON.stringify({ sid: 'session-1', searchId: 'search-1' }),
);

describe('loginFunnelCookie (shared CTA-cookie contract)', () => {
  it('pins the cookie lifetime above the pending-login window', () => {
    // 30min pending TTL + OAuth margin: a shorter cookie would expire
    // mid-waiting-room and convert real completions to NULL sessions,
    // biasing the rate against the slowest (highest-friction) users.
    expect(LOGIN_FUNNEL_CTX_MAX_AGE_SECONDS).toBeGreaterThan(30 * 60);
  });

  describe('parseLoginCtx', () => {
    it('parses a well-formed ctx cookie', () => {
      expect(parseLoginCtx(VALID_CTX)).toEqual({
        sessionId: 'session-1',
        searchId: 'search-1',
      });
    });

    it.each([undefined, null, 42, '', 'not-json{{{', '%zz'])(
      'degrades garbage (%p) to NULLs instead of throwing',
      (value) => {
        expect(parseLoginCtx(value)).toEqual({
          sessionId: null,
          searchId: null,
        });
      },
    );

    it('drops wrong-typed or overlong fields individually', () => {
      expect(
        parseLoginCtx(
          encodeURIComponent(JSON.stringify({ sid: 42, searchId: 'ok' })),
        ),
      ).toEqual({ sessionId: null, searchId: 'ok' });
      expect(
        parseLoginCtx(
          encodeURIComponent(
            JSON.stringify({ sid: 's', searchId: 'x'.repeat(65) }),
          ),
        ),
      ).toEqual({ sessionId: 's', searchId: null });
    });
  });

  describe('readLoginCtxFromStore', () => {
    it('reads the { value } cookie shape (next/headers cookies())', () => {
      const store = { get: jest.fn(() => ({ value: VALID_CTX })) };
      expect(readLoginCtxFromStore(store)).toEqual({
        sessionId: 'session-1',
        searchId: 'search-1',
      });
      expect(store.get).toHaveBeenCalledWith(LOGIN_FUNNEL_CTX_COOKIE);
    });

    it('reads a raw-string cookie shape', () => {
      expect(readLoginCtxFromStore({ get: () => VALID_CTX })).toEqual({
        sessionId: 'session-1',
        searchId: 'search-1',
      });
    });

    it.each([undefined, null, {}, { get: 'nope' }, { get: () => { throw new Error('boom'); } }])(
      'degrades missing/throwing stores (%p) to NULLs',
      (store) => {
        expect(readLoginCtxFromStore(store)).toEqual({
          sessionId: null,
          searchId: null,
        });
      },
    );
  });
});
