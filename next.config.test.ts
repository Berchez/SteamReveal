/**
 * Guards the next/image remote allowlist for Steam avatar CDN hosts.
 *
 * Why this exists: SiteNavMenu renders next/image with avatarUrl straight
 * from the Steam Web API (avatars.steamstatic.com). A domain missing from
 * images.domains fails at RUNTIME for every logged-in user with a real
 * avatar — and neither test layer can catch it: Jest/jsdom never runs
 * next/image optimization, and the e2e suite runs DEV_TEST_MODE, which
 * serves a data: URI mock avatar. This test pins the allowlist so
 * removing the host breaks the build instead of production logins.
 *
 * If the images config ever migrates to remotePatterns, update the
 * reader below (fail LOUD here, not silently).
 */
import fs from 'fs';
import path from 'path';

// Every Steam avatar CDN host the app can render today: the live API
// serves avatars.steamstatic.com (the only host ever observed — see the
// mock fixtures and the layout preconnect); mock mode serves data: URIs,
// which need no allowlist entry.
const STEAM_AVATAR_HOSTS = ['avatars.steamstatic.com'];

const readImageDomains = (): string[] => {
  const source = fs.readFileSync(
    path.join(__dirname, 'next.config.mjs'),
    'utf8',
  );
  // Scoped to the images: block (a bare /domains:/ would also match an
  // unrelated key like i18n.domains), and stopped at the first ] INSIDE
  // that block (no nested arrays live there).
  const match = /images\s*:\s*\{[^}]*?domains\s*:\s*\[([^\]]*)\]/.exec(
    source,
  );
  if (match === null) {
    throw new Error(
      'next.config.mjs has no images.domains array — did the config migrate to remotePatterns? Update this guard.',
    );
  }
  const quoted = match[1].match(/['"][^'"]+['"]/g) ?? [];
  return quoted.map((q) => q.slice(1, -1));
};

describe('next/image remote allowlist (Steam avatars)', () => {
  it('allows every Steam avatar CDN host the app can render', () => {
    expect(readImageDomains()).toEqual(
      expect.arrayContaining(STEAM_AVATAR_HOSTS),
    );
  });
});
