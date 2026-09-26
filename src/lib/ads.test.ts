import fs from 'fs';
import path from 'path';
import { AD_ALLOWED_HOSTS, AD_PUBLISHER_ID, shouldLoadAds } from './ads';

describe('shouldLoadAds (AdSense gating)', () => {
  it('loads only on canonical production', () => {
    expect(
      shouldLoadAds({ nodeEnv: 'production', host: 'steam-reveal.vercel.app' }),
    ).toBe(true);
  });

  it('blocks every non-production environment, even on the canonical host', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      expect(
        shouldLoadAds({ nodeEnv, host: 'steam-reveal.vercel.app' }),
      ).toBe(false);
    }
  });

  it('blocks preview deploys and localhost in production mode', () => {
    expect(
      shouldLoadAds({
        nodeEnv: 'production',
        host: 'osint-steam-git-feat-x-berchez.vercel.app',
      }),
    ).toBe(false);
    expect(
      shouldLoadAds({ nodeEnv: 'production', host: 'localhost:3000' }),
    ).toBe(false);
    expect(shouldLoadAds({ nodeEnv: 'production', host: '127.0.0.1' })).toBe(
      false,
    );
  });

  it('is case-insensitive and strips ports, but never fuzzy-matches', () => {
    expect(
      shouldLoadAds({ nodeEnv: 'production', host: 'Steam-Reveal.Vercel.App' }),
    ).toBe(true);
    expect(
      shouldLoadAds({
        nodeEnv: 'production',
        host: 'steam-reveal.vercel.app:443',
      }),
    ).toBe(true);
    // Substring lookalikes must NOT pass.
    expect(
      shouldLoadAds({
        nodeEnv: 'production',
        host: 'evil-steam-reveal.vercel.app',
      }),
    ).toBe(false);
    expect(shouldLoadAds({ nodeEnv: 'production', host: null })).toBe(false);
    expect(shouldLoadAds({ nodeEnv: 'production', host: undefined })).toBe(
      false,
    );
  });

  it('rejects malformed hosts fail-closed (IPv6, non-numeric ports)', () => {
    // Bracketed IPv6 can never be canonical — and a naive split(':')[0]
    // would read 'allowlisted-host:<garbage>' as canonical, so a
    // non-numeric port must reject too.
    for (const host of [
      '[::1]:3000',
      '[::1]',
      '2001:db8::1',
      'steam-reveal.vercel.app:notaport',
      'steam-reveal.vercel.app:',
      '[::1',
    ]) {
      expect(shouldLoadAds({ nodeEnv: 'production', host })).toBe(false);
    }
    // Sanity: numeric ports still pass (covered above, pinned here too).
    expect(
      shouldLoadAds({
        nodeEnv: 'production',
        host: 'steam-reveal.vercel.app:443',
      }),
    ).toBe(true);
  });

  it('keeps the publisher ID in sync with public/ads.txt', () => {
    // Reads the real file: a hardcoded-to-hardcoded comparison could never
    // catch ads.txt and the layout drifting apart.
    const adsTxt = fs.readFileSync(
      path.join(__dirname, '..', '..', 'public', 'ads.txt'),
      'utf8',
    );
    const numericId = AD_PUBLISHER_ID.replace(/^ca-pub-/, '');
    expect(adsTxt).toContain(`google.com, pub-${numericId}, DIRECT,`);
    expect(AD_ALLOWED_HOSTS).toEqual(['steam-reveal.vercel.app']);
  });
});
