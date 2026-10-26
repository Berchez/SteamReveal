/**
 * @jest-environment node
 */

import { NextRequest, NextResponse } from 'next/server';

import middleware from './middleware';
import {
  WATCH_SESSION_COOKIE,
  WATCH_SESSION_HINT_COOKIE,
} from './lib/watch/sessionCookie';

jest.mock('next-intl/middleware', () => ({
  __esModule: true,
  default: () => () => NextResponse.next(),
}));

const makeRequest = (cookies: Record<string, string> = {}) => {
  const request = new NextRequest('http://localhost/en');
  Object.entries(cookies).forEach(([name, value]) => {
    request.cookies.set(name, value);
  });
  return request;
};

describe('middleware session hint sync', () => {
  it('seeds the hint for a session sealed before the hint existed', () => {
    const response = middleware(
      makeRequest({
        [WATCH_SESSION_COOKIE]: 'sealed',
      }),
    );

    expect(response.cookies.get(WATCH_SESSION_HINT_COOKIE)?.value).toBe('1');
  });

  it('clears a stale hint when the session is gone', () => {
    const response = middleware(
      makeRequest({
        [WATCH_SESSION_HINT_COOKIE]: '1',
      }),
    );

    const cookie = response.cookies.get(WATCH_SESSION_HINT_COOKIE);
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });

  it('leaves anonymous responses free of Set-Cookie headers', () => {
    const response = middleware(makeRequest());

    expect(response.cookies.get(WATCH_SESSION_HINT_COOKIE)).toBeUndefined();
  });

  it('does not rewrite an already-correct hint', () => {
    const response = middleware(
      makeRequest({
        [WATCH_SESSION_COOKIE]: 'sealed',
        [WATCH_SESSION_HINT_COOKIE]: '1',
      }),
    );

    expect(response.cookies.get(WATCH_SESSION_HINT_COOKIE)).toBeUndefined();
  });
});
