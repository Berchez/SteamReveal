import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NextIntlClientProvider } from 'next-intl';

import WatchInbox from './WatchInbox';

// Real next-intl (not the key-echo mock in WatchInbox.test.tsx): the
// inbox sentences carry a <flag>preposition</flag> rich-text slot, and
// only a real provider proves the tag parses and the preposition lands
// next to the flag glyph. Locale files start with a UTF-8 BOM.
const loadWatchMessages = (locale: string): Record<string, string> => {
  const raw = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'messages',
      `${locale}.json`,
    ),
    'utf8',
  );
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return (JSON.parse(clean) as { Watch: Record<string, string> }).Watch;
};

// Same interception precedent as WatchManager tests: mock the
// underlying next-intl/navigation factory (not the @/navigation alias).
jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    Link: ({ href, children }: any) => <a href={href}>{children}</a>,
    redirect: jest.fn(),
    usePathname: () => '/player/player-x',
    useRouter: jest.fn(() => ({ push: jest.fn(), replace: jest.fn() })),
    getPathname: jest.fn(),
  }),
}));

const STEAM_A = '76561198000000001';

const responseWith = (rows: Array<Record<string, unknown>>) =>
  ({
    ok: true,
    json: async () => ({
      steamId: STEAM_A,
      notifications: rows,
      unreadCount: rows.length,
      monthlyCount: rows.length,
    }),
  }) as Response;

const renderInbox = async (locale: string) => {
  render(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Watch: loadWatchMessages(locale) }}
    >
      <WatchInbox steamId={STEAM_A} />
    </NextIntlClientProvider>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole('button'));
  await act(async () => {});
};

describe('WatchInbox with real next-intl messages', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  it.each(['en', 'pt', 'es', 'de', 'ru'])(
    'renders the searcher flag inside the sentence (%s)',
    async (locale) => {
      fetchMock.mockResolvedValue(
        responseWith([
          {
            searchId: 'search-1',
            searchedAt: '2026-06-01T00:00:00.000Z',
            cheaterChecked: false,
            requesterCountry: 'BR',
          },
        ]),
      );

      await renderInbox(locale);

      // One flag image per row, in every locale — the tag placement in
      // each translation is exercised for real here, not mocked away.
      expect(screen.getAllByRole('img')).toHaveLength(1);
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
    },
  );

  it('places the English preposition next to the flag (en)', async () => {
    fetchMock.mockResolvedValue(
      responseWith([
        {
          searchId: 'search-1',
          searchedAt: '2026-06-01T00:00:00.000Z',
          cheaterChecked: false,
          requesterCountry: 'BR',
        },
      ]),
    );

    await renderInbox('en');

    const item = screen.getByRole('listitem');
    // "Someone from [flag] viewed…" — preposition from the message tag,
    // glyph from data, name from Intl, all adjacent.
    expect(item.textContent).toMatch(/Someone from\s/);
    const flag = within(item).getByRole('img', { name: 'Brazil' });
    expect(flag).toHaveAttribute(
      'src',
      'https://flagcdn.com/w20/br.png',
    );
  });

  it('renders a clean sentence with no dangling preposition when countryless (en)', async () => {
    fetchMock.mockResolvedValue(
      responseWith([
        {
          searchId: 'search-1',
          searchedAt: '2026-06-01T00:00:00.000Z',
          cheaterChecked: false,
          requesterCountry: null,
        },
      ]),
    );

    await renderInbox('en');

    const item = screen.getByRole('listitem');
    // Empty slot leaves a double space (collapses in HTML rendering);
    // what matters: no dangling preposition, no flag, sentence intact.
    expect(item.textContent).toMatch(/Someone\s+viewed your profile/);
    expect(item.textContent).not.toMatch(/from/);
    expect(within(item).queryByRole('img')).toBeNull();
  });

  it('uses the viewer locale for the tooltip name (pt)', async () => {
    fetchMock.mockResolvedValue(
      responseWith([
        {
          searchId: 'search-1',
          searchedAt: '2026-06-01T00:00:00.000Z',
          cheaterChecked: false,
          requesterCountry: 'BR',
        },
      ]),
    );

    await renderInbox('pt');

    const item = screen.getByRole('listitem');
    expect(item.textContent).toMatch(/Alguém de\s/);
    within(item).getByRole('img', { name: 'Brasil' });
  });
});
