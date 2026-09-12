import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import SiteNavMenu from './SiteNavMenu';

jest.mock('@/app/components/WatchManager', () => ({
  __esModule: true,
  default: ({ steamId }: { steamId: string }) => (
    <div data-testid="watch-manager-stub">{steamId}</div>
  ),
}));

const STEAM = '76561198000000001';

describe('SiteNavMenu', () => {
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
