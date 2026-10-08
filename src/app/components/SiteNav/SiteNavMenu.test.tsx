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

// The history modal loads dynamically (outside the navbar chunk): stub
// the module so these tests pin the panel wiring (button → open,
// dropdown closes first, focus returns) without loading the real modal.
jest.mock('@/app/components/WatchHistory', () => ({
  __esModule: true,
  default: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog">
      <p tabIndex={-1} data-testid="history-title-stub">
        watchHistoryTitle
      </p>
      <button type="button" onClick={onClose}>
        close-history-stub
      </button>
    </div>
  ),
}));

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
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

  it('falls back to the letter initial when the avatar image fails to load', () => {
    // CDN hiccup (or a future Steam avatar-host migration): a broken image
    // in the navbar degrades to the initial, never to a broken <img>.
    render(
      <SiteNavMenu
        steamId={STEAM}
        nickname="AvatarUser"
        avatarUrl="https://cdn.test/a.jpg"
        avatarAlt="Profile picture of AvatarUser"
      />,
    );
    expect(screen.getByAltText('')).toBeInTheDocument();

    fireEvent.error(screen.getByAltText(''));

    expect(screen.queryByAltText('')).not.toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('labels the button with the translated avatar alt', () => {
    render(
      <SiteNavMenu
        steamId={STEAM}
        nickname="AvatarUser"
        avatarUrl={null}
        avatarAlt="Profile picture of AvatarUser"
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Profile picture of AvatarUser' }),
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

  it('opens the history modal outside the dropdown and refocuses on close', async () => {
    // Lifecycle pin: the modal must survive the dropdown closing (a
    // portaled click counts as "outside"), so opening it closes the
    // dropdown first and closing it returns focus to the avatar button.
    // The button lives on the PANEL (not in WatchManager): no status
    // poll to wait for, and it shows in every manager state.
    render(
      <SiteNavMenu
        steamId={STEAM}
        nickname="AvatarUser"
        avatarUrl={null}
        avatarAlt="Profile picture of AvatarUser"
      />,
    );

    const bell = screen.getByRole('button', {
      name: 'Profile picture of AvatarUser',
    });
    fireEvent.click(bell);
    await act(async () => {});
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByText('watchHistoryButton'));
    await act(async () => {});

    // Dropdown gone (single dialog now: the modal), modal title present.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('watchHistoryTitle')).toBeInTheDocument();

    fireEvent.click(screen.getByText('close-history-stub'));
    await act(async () => {});

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bell).toHaveFocus();
  });
});
