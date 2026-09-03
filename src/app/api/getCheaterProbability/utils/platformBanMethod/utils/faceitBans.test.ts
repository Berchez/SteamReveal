import axios from 'axios';
import getFaceitBanStatus from './faceitBans';

const originalFaceitKey = process.env.FACEIT_API_KEY;

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const mockedAxiosGet = jest.mocked(axios.get);

describe('getFaceitBanStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FACEIT_API_KEY = 'fake-key';
  });

  afterEach(() => {
    if (originalFaceitKey === undefined) {
      delete process.env.FACEIT_API_KEY;
    } else {
      process.env.FACEIT_API_KEY = originalFaceitKey;
    }
  });

  it('returns not-banned when the FACEIT_API_KEY is missing', async () => {
    delete process.env.FACEIT_API_KEY;
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: false,
      reason: null,
      playerId: null,
      classification: null,
      matches: null,
    });
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('returns not-banned for an invalid Steam ID without calling the API', async () => {
    const res = await getFaceitBanStatus('not-a-steam-id');
    expect(res).toEqual({
      banned: false,
      reason: null,
      playerId: null,
      classification: null,
      matches: null,
    });
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('returns not-banned when there is no FACEIT account for the Steam ID (404)', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ status: 404, data: {} } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: false,
      reason: null,
      playerId: null,
      classification: null,
      matches: null,
    });
  });

  it('returns not-banned with match count when the player has no bans', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({ status: 200, data: { items: [] } } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          segments: [
            { stats: { Matches: '80' } },
            { stats: { Matches: '40' } },
          ],
        },
      } as never)
      .mockResolvedValueOnce({ status: 200, data: { segments: [] } } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: false,
      reason: null,
      playerId: 'player-123',
      classification: null,
      matches: 120,
    });
  });

  it('returns banned with a reason and match count when the bans list is not empty', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { items: [{ reason: 'Cheating', type: 'game' }] },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [{ stats: { Matches: '45' } }] },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [{ stats: { Matches: '0' } }] },
      } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: true,
      reason: 'Cheating',
      playerId: 'player-123',
      classification: 'cheat',
      matches: 45,
    });
  });

  it('falls back to the ban type when reason is missing', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { items: [{ type: 'game' }] },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [] },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [] },
      } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: true,
      reason: 'game',
      playerId: 'player-123',
      classification: 'other',
      matches: null,
    });
  });

  it('is best-effort on API errors', async () => {
    mockedAxiosGet.mockRejectedValueOnce(new Error('network down'));
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: false,
      reason: null,
      playerId: null,
      classification: null,
      matches: null,
    });
  });

  it('prefers a later cheat ban over an earlier other ban', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          items: [
            { reason: 'Account discipline', type: 'other' },
            { reason: 'Cheating', type: 'game' },
          ],
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [{ stats: { Matches: '300' } }] },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [] },
      } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: true,
      reason: 'Cheating',
      playerId: 'player-123',
      classification: 'cheat',
      matches: 300,
    });
  });

  it('returns matches null when the stats endpoints 404 (no playable CS stats)', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({ status: 200, data: { items: [] } } as never)
      .mockResolvedValueOnce({ status: 404, data: {} } as never)
      .mockResolvedValueOnce({ status: 404, data: {} } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res.matches).toBeNull();
  });

  it('still resolves not-banned when the stats lookup fails', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({ status: 200, data: { items: [] } } as never)
      .mockRejectedValueOnce(new Error('stats down'))
      .mockResolvedValueOnce({ status: 200, data: { segments: [] } } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res.banned).toBe(false);
    expect(res.matches).toBeNull();
    expect(res.playerId).toBe('player-123');
  });

  it('keeps the goodwill matches signal when /bans rejects (allSettled), and logs the failure', async () => {
    // The player resolves and the stats endpoints succeed, but the /bans call
    // rejects (e.g. a 403/429 that makes axios throw). Regression for the
    // allSettled split: a /bans failure must NOT discard the match count that
    // resolved fine, AND must stay observable (console.error) so the route.ts
    // monitoring grep catches provider throttling.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockRejectedValueOnce(new Error('bans 429'))
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [{ stats: { Matches: '120' } }] },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [{ stats: { Matches: '30' } }] },
      } as never);

    const res = await getFaceitBanStatus('76561198000000000');

    // Matches (120 + 30 = 150) survived the /bans rejection.
    expect(res).toEqual({
      banned: false,
      reason: null,
      playerId: 'player-123',
      classification: null,
      matches: 150,
    });
    // The failure is logged, not silently swallowed.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('/bans failed for playerId player-123'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('parses string match counts from the segments payload', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({ status: 200, data: { items: [] } } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [{ stats: { Matches: '77' } }] },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [{ stats: { Matches: '10' } }] },
      } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res.matches).toBe(87);
  });

  it('regression: sums match counts across CS2 AND CS:GO segments (profile total)', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({ status: 200, data: { items: [] } } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: {
          segments: [
            { stats: { Matches: '250' } },
            { stats: { Matches: '28' } },
          ],
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { segments: [{ stats: { Matches: '454' } }] },
      } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    // 250 + 28 (CS2) + 454 (CSGO) = 732 — the number shown on the FACEIT profile.
    expect(res.matches).toBe(732);
  });
});