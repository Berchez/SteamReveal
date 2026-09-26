import fs from 'fs';
import path from 'path';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AdSlot from './AdSlot';

const ENV_KEY = 'NEXT_PUBLIC_ADSLOT_HOME_TOP';

type WindowWithAds = Window & { adsbygoogle?: Record<string, unknown>[] };

const readQueue = (): Record<string, unknown>[] | undefined =>
  (window as unknown as WindowWithAds).adsbygoogle;

const writeQueue = (value: unknown): void => {
  (window as unknown as Record<string, unknown>).adsbygoogle = value;
};

describe('AdSlot', () => {
  const originalEnv = process.env[ENV_KEY];
  const originalQueue = readQueue();

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
    writeQueue(originalQueue);
    jest.restoreAllMocks();
  });

  it('renders nothing when the slot ID is not configured', () => {
    delete process.env[ENV_KEY];

    const { container } = render(<AdSlot placement="homeTop" enabled />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on blank slot IDs (whitespace env footgun)', () => {
    process.env[ENV_KEY] = '   ';

    const { container } = render(<AdSlot placement="homeTop" enabled />);

    expect(container).toBeEmptyDOMElement();
  });

  it('trims padded slot IDs instead of emitting them verbatim', () => {
    process.env[ENV_KEY] = '  1234567890  ';

    render(<AdSlot placement="homeTop" enabled />);

    expect(document.querySelector('ins.adsbygoogle')).toHaveAttribute(
      'data-ad-slot',
      '1234567890',
    );
  });

  it('renders nothing when the server gate is off, even with a slot ID', () => {
    process.env[ENV_KEY] = '1234567890';
    writeQueue([]);

    const { container } = render(
      <AdSlot placement="homeTop" enabled={false} />,
    );

    // No reserved box on previews/dev — and no fill queued either.
    expect(container).toBeEmptyDOMElement();
    expect(readQueue()).toHaveLength(0);
  });

  it('renders the ins unit with publisher + slot attrs when configured', () => {
    process.env[ENV_KEY] = '1234567890';

    render(<AdSlot placement="homeTop" enabled />);
    expect(screen.getByTestId('ad-slot-homeTop')).toBeInTheDocument();

    const unit = document.querySelector('ins.adsbygoogle');
    expect(unit).not.toBeNull();
    expect(unit).toHaveAttribute('data-ad-client', 'ca-pub-3301991262958911');
    expect(unit).toHaveAttribute('data-ad-slot', '1234567890');
    expect(unit).toHaveAttribute('data-ad-format', 'auto');
    expect(unit).toHaveAttribute('data-full-width-responsive', 'true');
    expect(unit).not.toHaveAttribute('data-ad-layout');
  });

  it('renders the in-article wire format for playerInline (fluid + layout, no full-width-responsive)', () => {
    process.env.NEXT_PUBLIC_ADSLOT_PLAYER_INLINE = '8955396759';

    try {
      render(<AdSlot placement="playerInline" enabled />);

      const unit = document.querySelector(
        '[data-testid="ad-slot-playerInline"] ins.adsbygoogle',
      );
      expect(unit).not.toBeNull();
      expect(unit).toHaveAttribute('data-ad-format', 'fluid');
      expect(unit).toHaveAttribute('data-ad-layout', 'in-article');
      expect(unit).not.toHaveAttribute('data-full-width-responsive');
      expect(unit).toHaveAttribute('data-ad-slot', '8955396759');
    } finally {
      delete process.env.NEXT_PUBLIC_ADSLOT_PLAYER_INLINE;
    }
  });

  it('appends an optional className to the wrapper only', () => {
    process.env[ENV_KEY] = '1234567890';

    const { rerender } = render(
      <AdSlot placement="footer" enabled className="mt-12" />,
    );
    const wrapper = screen.getByTestId('ad-slot-footer');
    expect(wrapper).toHaveClass('mt-12');
    expect(wrapper).toHaveClass('min-h-[100px]');

    rerender(<AdSlot placement="footer" enabled />);
    expect(screen.getByTestId('ad-slot-footer')).not.toHaveClass('mt-12');
  });

  it('queues the fill exactly once on mount', () => {
    process.env[ENV_KEY] = '1234567890';
    writeQueue([]);

    render(<AdSlot placement="homeTop" enabled />);

    expect(readQueue()).toHaveLength(1);
  });

  it('never throws when an adblocker neuters the queue', () => {
    process.env[ENV_KEY] = '1234567890';
    Object.defineProperty(window, 'adsbygoogle', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });

    expect(() => render(<AdSlot placement="homeTop" enabled />)).not.toThrow();

    Object.defineProperty(window, 'adsbygoogle', {
      configurable: true,
      writable: true,
      value: originalQueue,
    });
  });

  it('reads slot IDs via static process.env references (Next inlining contract)', () => {
    // Next inlines NEXT_PUBLIC_* into the client bundle by STATIC
    // replacement only: `process.env.NEXT_PUBLIC_ADSLOT_X` written
    // literally. A dynamic lookup `process.env[someVar]` compiles to a
    // runtime read of the browser-side stub (undefined) and silently
    // disables every slot — while still passing every behavioral test,
    // because jest's process.env is the real Node object. This test pins
    // the source pattern so the bug cannot be reintroduced unnoticed.
    const source = fs.readFileSync(path.join(__dirname, 'AdSlot.tsx'), 'utf8');
    // Strip comments: doc prose legitimately names the forbidden pattern.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');

    for (const name of [
      'NEXT_PUBLIC_ADSLOT_HOME_TOP',
      'NEXT_PUBLIC_ADSLOT_PLAYER_INLINE',
      'NEXT_PUBLIC_ADSLOT_FOOTER',
    ]) {
      expect(code).toContain(`process.env.${name}`);
    }
    expect(code).not.toMatch(/process\.env\[/);
  });
});
