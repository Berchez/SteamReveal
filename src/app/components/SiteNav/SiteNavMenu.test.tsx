import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import SiteNavMenu from './SiteNavMenu';
import { clearWatchStatusPrefetch } from '@/app/templates/Home/hooks/watch/watchStatusPrefetch';

jest.mock('@/app/components/WatchManager', () => ({
  __esModule: true,
  default: ({ steamId }: { steamId: string }) => (
    <div data-testid="watch-manager-stub">{steamId}</div>
  ),
}));

const STEAM = '76561198000000001';

describe('SiteNavMenu', () => {
  const originalFetch = global.fetch;

  // The avatar hover/focus prefetch writes a module-scoped cache (and the
  // close-path .focus() fires it too): reset around every test so no test
  // can observe — or pollute — another's intent. fetch is mocked at file
  // level (not just in the prefetch test) because ANY focus event — including
  // the close-path buttonRef.current?.focus() in older tests — now triggers
  // a prefetch attempt; relying on jsdom lacking a global fetch would couple
  // the suite to the test environment instead of to the component contract.
  beforeEach(() => {
    clearWatchStatusPrefetch();
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    clearWatchStatusPrefetch();
    global.fetch = originalFetch;
  });

  it('shows the avatar image when available, letter fallback otherwise', () => {
    const { unmount } = render(
      <SiteNavMenu
        steamId={STEAM}
        nickname="AvatarUser"
        avatarUrl="https://cdn.test/a.jpg"
        avatarAlt="Profile picture of AvatarUser"
      />,
    );
    // Decorative image (the button carries the translated label instead —
    // no double announcement), so query by empty alt, not by img role.
    expect(screen.getByAltText('')).toHaveAttribute(
      'src',
      expect.stringContaining('cdn.test'),
    );
    unmount();

    render(
      <SiteNavMenu
        steamId={STEAM}
        nickname="AvatarUser"
        avatarUrl={null}
        avatarAlt="Profile picture of AvatarUser"
      />,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('labels the button with the translated avatar alt', () => {
    render(
      <SiteNavMenu
        steamId={STEAM}
        nickname="AvatarUser"
        avatarUrl={null}
        avatarAlt="Foto de perfil de AvatarUser"
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Foto de perfil de AvatarUser' }),
    ).toBeInTheDocument();
  });

  it('opens the panel with identity header + watch flow, closes on Escape', async () => {
    render(
      <SiteNavMenu
        steamId={STEAM}
        nickname="AvatarUser"
        avatarUrl={null}
        avatarAlt="Profile picture of AvatarUser"
      />,
    );

    expect(screen.queryByTestId('watch-manager-stub')).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Profile picture of AvatarUser' }),
    );
    await act(async () => {});

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('AvatarUser')).toBeInTheDocument();
    const stub = screen.getByTestId('watch-manager-stub');
    expect(stub).toHaveTextContent(STEAM);

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the panel on open (keyboard contract)', async () => {
    render(
      <SiteNavMenu
        steamId={STEAM}
        nickname="AvatarUser"
        avatarUrl={null}
        avatarAlt="Profile picture of AvatarUser"
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Profile picture of AvatarUser' }),
    );
    await act(async () => {});

    // The panel title (tabIndex -1), not document.body — WCAG 2.4.3.
    expect(screen.getByText('AvatarUser')).toHaveFocus();
  });

  it('prefetches watch status on hover/focus, once per freshness window', async () => {
    // Laziness is structural: the request fires only on post-paint user
    // intent, never on mount — so it cannot cost FCP/LCP. (fetch itself
    // comes from the file-level beforeEach mock; this test only swaps in
    // a payload-carrying one.)
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'pending' }),
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    render(
      <SiteNavMenu
        steamId={STEAM}
        nickname="AvatarUser"
        avatarUrl={null}
        avatarAlt="Profile picture of AvatarUser"
      />,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const button = screen.getByRole('button', {
      name: 'Profile picture of AvatarUser',
    });
    fireEvent.mouseEnter(button);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/watch/status');

    // Second intent while fresh costs nothing (single-flight + TTL).
    fireEvent.focus(button);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('closes on outside click and refocuses the button', async () => {
    render(
      <div>
        <button type="button">outside</button>
        <SiteNavMenu
          steamId={STEAM}
          nickname="AvatarUser"
          avatarUrl={null}
          avatarAlt="Profile picture of AvatarUser"
        />
      </div>,
    );

    const bell = screen.getByRole('button', {
      name: 'Profile picture of AvatarUser',
    });
    fireEvent.click(bell);
    await act(async () => {});
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText('outside'));
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bell).toHaveFocus();
  });
});
