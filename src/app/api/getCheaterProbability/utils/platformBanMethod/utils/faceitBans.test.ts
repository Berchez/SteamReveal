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
    expect(res).toEqual({ banned: false, reason: null, playerId: null, classification: null });
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('returns not-banned for an invalid Steam ID without calling the API', async () => {
    const res = await getFaceitBanStatus('not-a-steam-id');
    expect(res).toEqual({ banned: false, reason: null, playerId: null, classification: null });
    expect(mockedAxiosGet).not.toHaveBeenCalled();
  });

  it('returns not-banned when there is no FACEIT account for the Steam ID (404)', async () => {
    mockedAxiosGet.mockResolvedValueOnce({ status: 404, data: {} } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({ banned: false, reason: null, playerId: null, classification: null });
  });

  it('returns not-banned when the player has no bans', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({ status: 200, data: { items: [] } } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: false,
      reason: null,
      playerId: 'player-123',
      classification: null,
    });
  });

  it('returns banned with a reason when the bans list is not empty', async () => {
    mockedAxiosGet
      .mockResolvedValueOnce({
        status: 200,
        data: { player_id: 'player-123' },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { items: [{ reason: 'Cheating', type: 'game' }] },
      } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: true,
      reason: 'Cheating',
      playerId: 'player-123',
      classification: 'cheat',
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
      } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: true,
      reason: 'game',
      playerId: 'player-123',
      classification: 'other',
    });
  });

  it('is best-effort on API errors', async () => {
    mockedAxiosGet.mockRejectedValueOnce(new Error('network down'));
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({ banned: false, reason: null, playerId: null, classification: null });
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
      } as never);
    const res = await getFaceitBanStatus('76561198000000000');
    expect(res).toEqual({
      banned: true,
      reason: 'Cheating',
      playerId: 'player-123',
      classification: 'cheat',
    });
  });
});
