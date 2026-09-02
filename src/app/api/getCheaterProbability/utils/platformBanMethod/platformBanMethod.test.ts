import getPlatformBanScore from './index';
import getFaceitBanStatus from './utils/faceitBans';
import getGamersClubBanStatus from './utils/gamersClubBan';
import { SteamCallTimeoutError } from '@/lib/withTimeout';

jest.mock('./utils/faceitBans');
jest.mock('./utils/gamersClubBan');

const mockedFaceit = getFaceitBanStatus as jest.Mock;
const mockedGamersClub = getGamersClubBanStatus as jest.Mock;

const faceitOk = (over: Record<string, unknown> = {}) => ({
  banned: false,
  reason: null,
  playerId: null,
  classification: null,
  ...over,
});

const gcOk = (over: Record<string, unknown> = {}) => ({
  banned: false,
  reason: null,
  name: null,
  classification: null,
  ...over,
});

describe('getPlatformBanScore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns all-zero counts when neither platform reports a ban', async () => {
    mockedFaceit.mockResolvedValueOnce(faceitOk());
    mockedGamersClub.mockResolvedValueOnce(gcOk());

    const res = await getPlatformBanScore('76561198000000000');

    expect(res.score).toBe(0);
    expect(res.cheatCount).toBe(0);
    expect(res.smurfCount).toBe(0);
    expect(res.otherCount).toBe(0);
    expect(res.details.faceit.banned).toBe(false);
    expect(res.details.gamersClub.banned).toBe(false);
  });

  it('counts a Faceit cheating ban as +1 cheat', async () => {
    mockedFaceit.mockResolvedValueOnce(
      faceitOk({ banned: true, reason: 'Cheating', playerId: 'p1', classification: 'cheat' }),
    );
    mockedGamersClub.mockResolvedValueOnce(gcOk());

    const res = await getPlatformBanScore('76561198000000000');

    expect(res.cheatCount).toBe(1);
    expect(res.smurfCount).toBe(0);
    expect(res.otherCount).toBe(0);
    expect(res.score).toBe(1);
    expect(res.details.faceit).toEqual({
      banned: true,
      reason: 'Cheating',
      classification: 'cheat',
    });
  });

  it('counts a GamersClub smurf ban as -1 smurf', async () => {
    mockedFaceit.mockResolvedValueOnce(faceitOk());
    mockedGamersClub.mockResolvedValueOnce(
      gcOk({
        banned: true,
        reason: 'Usuário suspenso por uso de conta secundária ou smurf na Gamers Club',
        name: 'X',
        classification: 'smurf',
      }),
    );

    const res = await getPlatformBanScore('76561198000000000');

    expect(res.smurfCount).toBe(1);
    expect(res.cheatCount).toBe(0);
    expect(res.otherCount).toBe(0);
    expect(res.score).toBe(-1);
  });

  it('counts an unknown / other ban as neutral', async () => {
    mockedFaceit.mockResolvedValueOnce(faceitOk());
    mockedGamersClub.mockResolvedValueOnce(
      gcOk({ banned: true, reason: 'Punishment', name: 'X', classification: 'other' }),
    );

    const res = await getPlatformBanScore('76561198000000000');

    expect(res.otherCount).toBe(1);
    expect(res.cheatCount).toBe(0);
    expect(res.smurfCount).toBe(0);
    expect(res.score).toBe(0);
  });

  it('combines cheat and smurf bans into a net score', async () => {
    mockedFaceit.mockResolvedValueOnce(
      faceitOk({ banned: true, reason: 'Cheating', playerId: 'p1', classification: 'cheat' }),
    );
    mockedGamersClub.mockResolvedValueOnce(
      gcOk({ banned: true, reason: 'smurfing', name: 'X', classification: 'smurf' }),
    );

    const res = await getPlatformBanScore('76561198000000000');

    expect(res.cheatCount).toBe(1);
    expect(res.smurfCount).toBe(1);
    expect(res.otherCount).toBe(0);
    expect(res.score).toBe(0);
  });

  it('queries both platforms in parallel', async () => {
    mockedFaceit.mockResolvedValue(faceitOk());
    mockedGamersClub.mockResolvedValue(gcOk());

    await getPlatformBanScore('76561198000000000');

    expect(mockedFaceit).toHaveBeenCalledWith('76561198000000000');
    expect(mockedGamersClub).toHaveBeenCalledWith('76561198000000000');
  });

  it('treats a wall-clock timed-out lookup as "not banned"', async () => {
    mockedFaceit.mockResolvedValueOnce(faceitOk());
    mockedGamersClub.mockRejectedValueOnce(
      new SteamCallTimeoutError('gamersClub', 8000),
    );

    const res = await getPlatformBanScore('76561198000000000');

    expect(res.cheatCount).toBe(0);
    expect(res.smurfCount).toBe(0);
    expect(res.otherCount).toBe(0);
    expect(res.score).toBe(0);
    expect(res.details.gamersClub.banned).toBe(false);
    expect(res.details.gamersClub.classification).toBeNull();
  });
});
