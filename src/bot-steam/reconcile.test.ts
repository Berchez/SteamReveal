import { reconcileFriendsList, type ReconcileDal } from './reconcile';

// Steam EFriendRelationship.Friend. Deliberately a literal (not imported
// from steam-user): reconcile takes the value as a parameter precisely so
// this module — and its tests — never touch the Steam library.
const FRIEND = 3;
const STRANGER = 0;

const silentLogger = { info: jest.fn(), error: jest.fn() };

const makeDal = (
  watches: Array<{ steamId: string; status: string; locale?: string | null }>,
): ReconcileDal & {
  activated: string[];
  deactivated: string[];
  failOn: Set<string>;
} => {
  const state = {
    activated: [] as string[],
    deactivated: [] as string[],
    failOn: new Set<string>(),
  };
  return {
    ...state,
    listWatchedProfiles: jest.fn(async () =>
      watches.map((w) => ({ locale: null, ...w })),
    ),
    activateWatch: jest.fn(async (steamId: string) => {
      if (state.failOn.has(`activate:${steamId}`)) {
        throw new Error(`activate boom for ${steamId}`);
      }
      state.activated.push(steamId);
      return true;
    }),
    deactivateWatch: jest.fn(async (steamId: string) => {
      if (state.failOn.has(`deactivate:${steamId}`)) {
        throw new Error(`deactivate boom for ${steamId}`);
      }
      state.deactivated.push(steamId);
      return true;
    }),
  };
};

describe('reconcileFriendsList', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('activates pending watches found in friends, deactivates active watches gone from friends', async () => {
    const dal = makeDal([
      { steamId: '76561198000000001', status: 'pending' },
      { steamId: '76561198000000002', status: 'active' },
      { steamId: '76561198000000003', status: 'pending' },
      { steamId: '76561198000000004', status: 'active' },
    ]);

    const report = await reconcileFriendsList(
      {
        '76561198000000001': FRIEND,
        '76561198000000003': STRANGER,
        '76561198000000004': FRIEND,
      },
      FRIEND,
      dal,
      silentLogger,
    );

    expect(dal.activated).toEqual(['76561198000000001']);
    expect(dal.deactivated).toEqual(['76561198000000002']);
    expect(report).toMatchObject({
      friends: 2,
      watches: 4,
      skippedInvalidIds: 0,
      errors: [],
    });
    expect(report.activated).toEqual(['76561198000000001']);
    expect(report.deactivated).toEqual(['76561198000000002']);
  });

  it('is a verified no-op rerun when nothing changed (idempotent)', async () => {
    const dal = makeDal([{ steamId: '76561198000000001', status: 'active' }]);

    const friends = { '76561198000000001': FRIEND };
    await reconcileFriendsList(friends, FRIEND, dal, silentLogger);
    const second = await reconcileFriendsList(
      friends,
      FRIEND,
      dal,
      silentLogger,
    );

    expect(dal.activated).toHaveLength(0);
    expect(dal.deactivated).toHaveLength(0);
    expect(second.errors).toEqual([]);
  });

  it('recovers friendships accepted while the bot was offline (appear in snapshot)', async () => {
    // First pass: user has not accepted yet — nothing happens.
    const dal = makeDal([{ steamId: '76561198000000001', status: 'pending' }]);
    const first = await reconcileFriendsList({}, FRIEND, dal, silentLogger);
    expect(first.activated).toEqual([]);

    // Second pass (e.g. after reconnect): the snapshot now includes them.
    const second = await reconcileFriendsList(
      { '76561198000000001': FRIEND },
      FRIEND,
      dal,
      silentLogger,
    );
    expect(second.activated).toEqual(['76561198000000001']);
  });

  it('recovers removals that happened while the bot was offline', async () => {
    const dal = makeDal([{ steamId: '76561198000000001', status: 'active' }]);

    const report = await reconcileFriendsList({}, FRIEND, dal, silentLogger);

    expect(report.deactivated).toEqual(['76561198000000001']);
  });

  it('skips non-SteamID keys without calling the DAL for them', async () => {
    const dal = makeDal([{ steamId: '76561198000000001', status: 'active' }]);

    const report = await reconcileFriendsList(
      { 'not-an-id': FRIEND, '76561198000000001': FRIEND },
      FRIEND,
      dal,
      silentLogger,
    );

    expect(report.skippedInvalidIds).toBe(1);
    expect(report.deactivated).toEqual([]);
  });

  it('isolates per-row errors and keeps converging the rest', async () => {
    const dal = makeDal([
      { steamId: '76561198000000001', status: 'pending' },
      { steamId: '76561198000000002', status: 'pending' },
    ]);
    dal.failOn.add('activate:76561198000000001');

    const report = await reconcileFriendsList(
      {
        '76561198000000001': FRIEND,
        '76561198000000002': FRIEND,
      },
      FRIEND,
      dal,
      silentLogger,
    );

    expect(report.activated).toEqual(['76561198000000002']);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({
      steamId: '76561198000000001',
      operation: 'activateWatch',
    });
  });

  it('logs a structured summary line with counts', async () => {
    const logger = { info: jest.fn(), error: jest.fn() };
    const dal = makeDal([{ steamId: '76561198000000001', status: 'active' }]);

    await reconcileFriendsList({}, FRIEND, dal, logger);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = String(logger.info.mock.calls[0][0]);
    expect(line).toContain('friends=0');
    expect(line).toContain('watches=1');
    expect(line).toContain('deactivated=1');
    expect(line).toContain('durationMs=');
  });

  it('calls onActivated with steamId+locale for every fresh activation', async () => {
    const dal = makeDal([
      { steamId: '76561198000000001', status: 'pending', locale: 'pt' },
      { steamId: '76561198000000002', status: 'pending', locale: null },
      { steamId: '76561198000000003', status: 'active' },
    ]);
    const onActivated = jest.fn();

    const report = await reconcileFriendsList(
      {
        '76561198000000001': FRIEND,
        '76561198000000002': FRIEND,
        '76561198000000003': FRIEND,
      },
      FRIEND,
      dal,
      silentLogger,
      onActivated,
    );

    expect(report.activated).toEqual([
      '76561198000000001',
      '76561198000000002',
    ]);
    expect(onActivated).toHaveBeenCalledTimes(2);
    expect(onActivated).toHaveBeenCalledWith({
      steamId: '76561198000000001',
      locale: 'pt',
    });
    expect(onActivated).toHaveBeenCalledWith({
      steamId: '76561198000000002',
      locale: null,
    });
  });

  it('a failing welcome keeps the activation and records a welcomeMessage error', async () => {
    const dal = makeDal([{ steamId: '76561198000000001', status: 'pending' }]);
    const onActivated = jest.fn(async () => {
      throw new Error('steam down');
    });

    const report = await reconcileFriendsList(
      { '76561198000000001': FRIEND },
      FRIEND,
      dal,
      silentLogger,
      onActivated,
    );

    // Activation committed before the callback ran: still reported.
    expect(report.activated).toEqual(['76561198000000001']);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({
      steamId: '76561198000000001',
      operation: 'welcomeMessage',
    });
  });

  it('never calls onActivated without an activation', async () => {
    const dal = makeDal([{ steamId: '76561198000000001', status: 'active' }]);
    const onActivated = jest.fn();

    await reconcileFriendsList(
      { '76561198000000001': FRIEND },
      FRIEND,
      dal,
      silentLogger,
      onActivated,
    );
    await reconcileFriendsList({}, FRIEND, dal, silentLogger, onActivated);

    expect(onActivated).not.toHaveBeenCalled();
  });

  it('serializes overlapping passes: one welcome for concurrent accepts', async () => {
    // Stateful fake with REAL DAL semantics: the status map is live (a
    // pass that commits is visible to the next reader) and activateWatch
    // is idempotent-true (returns true even when the row is already
    // active) — exactly the combination that double-welcomes without
    // serialization, since the DB update alone cannot dedupe.
    const statuses = new Map([['76561198000000001', 'pending']]);
    const dal: ReconcileDal = {
      listWatchedProfiles: async () =>
        Array.from(statuses.entries()).map(([steamId, status]) => ({
          steamId,
          status,
          locale: null,
        })),
      activateWatch: async (steamId: string) => {
        statuses.set(steamId, 'active');
        return true;
      },
      deactivateWatch: async () => true,
    };
    const onActivated = jest.fn();

    // Full sync + accept landing at the same instant: both passes overlap
    // in time. The second must read post-commit state and skip the welcome.
    const friends = { '76561198000000001': FRIEND };
    const [first, second] = await Promise.all([
      reconcileFriendsList(friends, FRIEND, dal, silentLogger, onActivated),
      reconcileFriendsList(friends, FRIEND, dal, silentLogger, onActivated),
    ]);

    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(onActivated).toHaveBeenCalledWith({
      steamId: '76561198000000001',
      locale: null,
    });
    expect(first.activated).toEqual(['76561198000000001']);
    expect(second.activated).toEqual([]);
  });
});
