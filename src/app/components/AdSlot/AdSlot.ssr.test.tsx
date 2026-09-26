/**
 * @jest-environment node
 *
 * Server-renderability of AdSlot (P1 CLS guard): the Home call site must
 * NOT use ssr:false, so the min-height wrapper has to exist in SSR HTML —
 * otherwise its client-side mount shifts page content. This file runs in
 * the node environment (repo convention for non-jsdom needs) because
 * react-dom/server requires Node globals jsdom lacks. It renders the
 * server path directly: any window/headers() access during render fails
 * loudly here instead of as CLS in production.
 */
import { renderToString } from 'react-dom/server';
import AdSlot from './AdSlot';

const ENV_KEY = 'NEXT_PUBLIC_ADSLOT_HOME_TOP';

describe('AdSlot SSR', () => {
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
  });

  it('server-renders the reserved wrapper with no browser globals', () => {
    process.env[ENV_KEY] = '1234567890';

    let html = '';
    expect(() => {
      html = renderToString(<AdSlot placement="homeTop" enabled />);
    }).not.toThrow();

    expect(html).toContain('ad-slot-homeTop');
    expect(html).toContain('min-h-[100px]');
    expect(html).toContain('data-ad-slot="1234567890"');
  });

  it('server-renders nothing when the gate is off or the slot is unset', () => {
    process.env[ENV_KEY] = '1234567890';
    const gatedOff = renderToString(
      <AdSlot placement="homeTop" enabled={false} />,
    );
    expect(gatedOff).not.toContain('ad-slot-homeTop');

    delete process.env[ENV_KEY];
    const unset = renderToString(<AdSlot placement="homeTop" enabled />);
    expect(unset).not.toContain('ad-slot-homeTop');
  });
});
