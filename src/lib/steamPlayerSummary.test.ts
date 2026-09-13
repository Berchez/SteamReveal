/**
 * @jest-environment node
 */
import { fetchPlayerSummary } from './steamPlayerSummary';

const STEAM = '76561198000000001';

const summaryResponse = (player: unknown) => ({
  ok: true,
  json: async () => ({ response: { players: [player] } }),
});

const fetchMock = () => {
  const mock = jest.fn(async () => summaryResponse({}));
  global.fetch = mock as unknown as typeof fetch;
  return mock as jest.Mock;
};

describe('fetchPlayerSummary', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('returns players[0] for a good response', async () => {
    const mock = fetchMock();
    mock.mockResolvedValue(
      summaryResponse({ personaname: 'A', avatarmedium: 'https://cdn.test/a.jpg' }),
    );

    await expect(
      fetchPlayerSummary(STEAM, 'fake-key'),
    ).resolves.toEqual({ personaname: 'A', avatarmedium: 'https://cdn.test/a.jpg' });
    const [url] = mock.mock.calls[0] as unknown as [string];
    expect(url).toContain('GetPlayerSummaries');
    expect(url).toContain(`steamids=${STEAM}`);
    expect(url).toContain(`key=fake-key`);
  });

  it('returns null for bad ids, missing keys, and non-ok responses', async () => {
    const mock = fetchMock();

    await expect(fetchPlayerSummary('short', 'fake-key')).resolves.toBeNull();
    await expect(fetchPlayerSummary(STEAM, '')).resolves.toBeNull();
    expect(mock).not.toHaveBeenCalled();

    mock.mockResolvedValue({ ok: false, status: 403 });
    await expect(fetchPlayerSummary(STEAM, 'fake-key')).resolves.toBeNull();

    mock.mockResolvedValue(summaryResponse(undefined));
    await expect(fetchPlayerSummary(STEAM, 'fake-key')).resolves.toBeNull();
  });

  it('returns null when fetch throws (never rejects)', async () => {
    const mock = jest.fn(async () => {
      throw new Error('Steam down');
    });
    global.fetch = mock as unknown as typeof fetch;

    await expect(fetchPlayerSummary(STEAM, 'fake-key')).resolves.toBeNull();
  });
});
