import { handleFriendRemoved } from './friendRemoved';

const STEAM_ID = '76561198000000001';

const silentLogger = { info: jest.fn(), error: jest.fn() };

const makeDal = (removed = { watchDeleted: true, accountDeleted: true }) => ({
  removeWatchAndAccount: jest.fn(async () => removed),
});

describe('handleFriendRemoved', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes watch + account atomically and logs structurally', async () => {
    const dal = makeDal();
    const logger = { info: jest.fn(), error: jest.fn() };

    const result = await handleFriendRemoved(STEAM_ID, dal, logger);

    // Opt-out leaves no user record: the next signup starts unconfirmed
    // and gets a fresh confirm link (never skips on stale state).
    expect(result).toEqual({
      steamId: STEAM_ID,
      deactivated: true,
      accountDeleted: true,
    });
    expect(dal.removeWatchAndAccount).toHaveBeenCalledWith(STEAM_ID);
    expect(dal.removeWatchAndAccount).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = String(logger.info.mock.calls[0][0]);
    expect(line).toContain(`steamId=${STEAM_ID}`);
    expect(line).toContain('event=friend-remove');
    expect(line).toContain('result=deactivated');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('treats an already-inactive watch as a settled no-op (idempotent)', async () => {
    const dal = makeDal({ watchDeleted: false, accountDeleted: false });
    const logger = { info: jest.fn(), error: jest.fn() };

    const first = await handleFriendRemoved(STEAM_ID, dal, logger);
    const second = await handleFriendRemoved(STEAM_ID, dal, logger);

    expect(first).toEqual({
      steamId: STEAM_ID,
      deactivated: false,
      accountDeleted: false,
    });
    expect(second).toEqual({
      steamId: STEAM_ID,
      deactivated: false,
      accountDeleted: false,
    });
    expect(dal.removeWatchAndAccount).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
    expect(
      logger.info.mock.calls.some((call) =>
        String(call[0]).includes('result=already-inactive'),
      ),
    ).toBe(true);
  });

  it('skips malformed steamIds without touching the DAL', async () => {
    const dal = makeDal();
    const logger = { info: jest.fn(), error: jest.fn() };

    const result = await handleFriendRemoved('not-an-id', dal, logger);

    expect(result).toEqual({
      steamId: 'not-an-id',
      deactivated: false,
      accountDeleted: false,
    });
    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('reports a composite failure truthfully (atomic: neither row went)', async () => {
    // The batch is one transaction — a throw means the rollback held, so
    // {false, false} is the truth, not a mask.
    const dal = {
      removeWatchAndAccount: jest.fn(async () => {
        throw new Error('db down');
      }),
    };
    const logger = { info: jest.fn(), error: jest.fn() };

    const result = await handleFriendRemoved(STEAM_ID, dal, logger);

    expect(result).toEqual({
      steamId: STEAM_ID,
      deactivated: false,
      accountDeleted: false,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = String(logger.error.mock.calls[0][0]);
    expect(line).toContain(`steamId=${STEAM_ID}`);
    expect(line).toContain('operation=removeWatch');
    expect(line).toContain('db down');
  });

  it('logs exactly the documented line shapes (no room for extra content)', async () => {
    const dal = makeDal();
    const logger = { info: jest.fn(), error: jest.fn() };

    await handleFriendRemoved(STEAM_ID, dal, logger);
    expect(logger.info.mock.calls).toEqual([
      [
        `[WatchBot] friend-remove: watch deactivated steamId=${STEAM_ID} event=friend-remove result=deactivated accountDeleted=true`,
      ],
    ]);

    await handleFriendRemoved('not-an-id', dal, logger);
    expect(logger.error.mock.calls).toEqual([
      [
        '[WatchBot] friend-remove ignored: malformed steamId "not-an-id"',
      ],
    ]);
  });
});
