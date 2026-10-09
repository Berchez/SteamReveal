import {
  evaluateMassRemovalGuard,
  isSwapWindowActive,
  normalizeMassRemoveMax,
  reconcileFriendsList,
  requestSwapExemption,
  shouldKeepSwapExemption,
  type ReconcileDal,
} from './reconcile';
import type { WatchAccount } from '../lib/analytics/types';

// Steam EFriendRelationship.Friend. Deliberately a literal (not imported
// from steam-user): reconcile takes the value as a parameter precisely so
// this module — and its tests — never touch the Steam library.
const FRIEND = 3;
const STRANGER = 0;

// A friend id with NO watch row: keeps snapshots non-empty (so the
// mass-removal breaker stays out of the way) without changing what the
// pass does to the listed watches.
const UNRELATED_FRIEND = { '76561198000000099': FRIEND };

const silentLogger = { info: jest.fn(), error: jest.fn() };

const makeDal = (
  watches: Array<{ steamId: string; status: string; locale?: string | null }>,
  // Confirmation state per profile. Absent (default) means NO accounts
  // row at all — the legacy lane — so pre-existing activation tests keep
  // exercising the activate path unchanged. Pass { confirmedAt: null }
  // for unconfirmed accounts, an ISO string for confirmed ones.
  accounts: Record<string, { confirmedAt: string | null } | null> = {},
  // Orphan accounts (accounts rows with no watch row) for the sweep
  // tests below. Empty by default: the sweep is a no-op for every
  // pre-existing test.
  orphans: string[] = [],
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
    getAccount: jest.fn(async (steamId: string) => {
      if (!(steamId in accounts)) return null;
      const entry = accounts[steamId];
      if (entry === null) return null;
      return { steamId, confirmedAt: entry.confirmedAt } as WatchAccount;
    }),
    activateWatch: jest.fn(async (steamId: string) => {
      if (state.failOn.has(`activate:${steamId}`)) {
        throw new Error(`activate boom for ${steamId}`);
      }
      state.activated.push(steamId);
      return true;
    }),
    // Offline opt-out goes through the shared atomic composite (same call
    // the live friend-remove path uses — the rule cannot drift).
    removeWatchAndAccount: jest.fn(async (steamId: string) => {
      state.deactivated.push(steamId);
      return { watchDeleted: true, accountDeleted: true };
    }),
    // Orphan sweep input (accounts with no watch row): empty by
    // default — orphan tests pass their own list.
    listOrphanAccounts: jest.fn(async (): Promise<string[]> => [...orphans]),
    // Swap-mode lane (runbook §7): watch row only, accounts + history
    // links survive the bot-swap.
    deactivateWatch: jest.fn(async (steamId: string) => {
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

  it('sends the confirm link WITHOUT activating for pending+friend+unconfirmed', async () => {
    // The click-to-activate core: friendship alone must never flip the
    // status — the watch stays pending until the link click.
    const dal = makeDal(
      [{ steamId: '76561198000000001', status: 'pending', locale: 'pt' }],
      { '76561198000000001': { confirmedAt: null } },
    );
    const onConfirmLinkNeeded = jest.fn(async () => true);

    const report = await reconcileFriendsList(
      { '76561198000000001': FRIEND },
      FRIEND,
      dal,
      silentLogger,
      undefined,
      onConfirmLinkNeeded,
    );

    expect(dal.activateWatch).not.toHaveBeenCalled();
    expect(onConfirmLinkNeeded).toHaveBeenCalledTimes(1);
    expect(onConfirmLinkNeeded).toHaveBeenCalledWith({
      steamId: '76561198000000001',
      locale: 'pt',
    });
    expect(report.confirmLinksSent).toEqual(['76561198000000001']);
    expect(report.activated).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('activates (never links) for pending+friend+confirmed', async () => {
    const dal = makeDal(
      [{ steamId: '76561198000000001', status: 'pending' }],
      { '76561198000000001': { confirmedAt: '2026-09-02T00:00:00.000Z' } },
    );
    const onActivated = jest.fn();
    const onConfirmLinkNeeded = jest.fn(async () => true);

    const report = await reconcileFriendsList(
      { '76561198000000001': FRIEND },
      FRIEND,
      dal,
      silentLogger,
      onActivated,
      onConfirmLinkNeeded,
    );

    expect(dal.activateWatch).toHaveBeenCalledWith('76561198000000001');
    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(onConfirmLinkNeeded).not.toHaveBeenCalled();
    expect(report.confirmLinksSent).toEqual([]);
  });

  it('does not count skipped link sends (live token outstanding)', async () => {
    const dal = makeDal(
      [{ steamId: '76561198000000001', status: 'pending' }],
      { '76561198000000001': { confirmedAt: null } },
    );
    const onConfirmLinkNeeded = jest.fn(async () => false);

    const report = await reconcileFriendsList(
      { '76561198000000001': FRIEND },
      FRIEND,
      dal,
      silentLogger,
      undefined,
      onConfirmLinkNeeded,
    );

    expect(onConfirmLinkNeeded).toHaveBeenCalledTimes(1);
    expect(report.confirmLinksSent).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(dal.activateWatch).not.toHaveBeenCalled();
  });

  it('isolates link-hook failures per row (operation confirmLink)', async () => {
    const dal = makeDal(
      [
        { steamId: '76561198000000001', status: 'pending' },
        { steamId: '76561198000000002', status: 'pending' },
      ],
      {
        '76561198000000001': { confirmedAt: null },
        '76561198000000002': { confirmedAt: null },
      },
    );
    const onConfirmLinkNeeded = jest.fn(async () => true);
    onConfirmLinkNeeded.mockRejectedValueOnce(new Error('chat down'));

    const report = await reconcileFriendsList(
      {
        '76561198000000001': FRIEND,
        '76561198000000002': FRIEND,
      },
      FRIEND,
      dal,
      silentLogger,
      undefined,
      onConfirmLinkNeeded,
    );

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({
      steamId: '76561198000000001',
      operation: 'confirmLink',
    });
    // The sibling row still converged.
    expect(report.confirmLinksSent).toEqual(['76561198000000002']);
    expect(dal.activateWatch).not.toHaveBeenCalled();
  });

  it('skips the row this pass when the account read fails (retried next pass)', async () => {
    const dal = makeDal([
      { steamId: '76561198000000001', status: 'pending' },
    ]);
    (dal.getAccount as jest.Mock).mockRejectedValueOnce(
      new Error('turso timeout'),
    );
    const onConfirmLinkNeeded = jest.fn(async () => true);

    const report = await reconcileFriendsList(
      { '76561198000000001': FRIEND },
      FRIEND,
      dal,
      silentLogger,
      undefined,
      onConfirmLinkNeeded,
    );

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({
      steamId: '76561198000000001',
      operation: 'confirmLink',
    });
    expect(dal.activateWatch).not.toHaveBeenCalled();
    expect(onConfirmLinkNeeded).not.toHaveBeenCalled();
    expect(report.confirmLinksSent).toEqual([]);
  });

  it('leaves unconfirmed watches pending silently without a link hook', async () => {
    const dal = makeDal(
      [{ steamId: '76561198000000001', status: 'pending' }],
      { '76561198000000001': { confirmedAt: null } },
    );

    const report = await reconcileFriendsList(
      { '76561198000000001': FRIEND },
      FRIEND,
      dal,
      silentLogger,
    );

    expect(dal.activateWatch).not.toHaveBeenCalled();
    expect(report.activated).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('removes watch + account for offline opt-outs', async () => {
    // The DAL call is the assert here (mocked lane); the links-
    // preserved half of this product decision is pinned by
    // db.integration.test.ts's opt-out test, which follows the real
    // removeWatchAndAccount against the mocked client.
    const dal = makeDal([
      { steamId: '76561198000000002', status: 'active' },
    ]);

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
    );

    expect(report.deactivated).toEqual(['76561198000000002']);
    expect(dal.removeWatchAndAccount).toHaveBeenCalledWith(
      '76561198000000002',
    );
  });

  it('labels a failed opt-out removal and retries it next pass', async () => {
    const dal = makeDal([
      { steamId: '76561198000000002', status: 'active' },
    ]);
    // (makeDal types the field as the DAL interface — cast to reach the
    // underlying mock.)
    (dal.removeWatchAndAccount as jest.Mock).mockRejectedValueOnce(
      new Error('turso timeout'),
    );

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
    );

    // The composite is one transaction: a throw means nothing was
    // removed, the row stays listed, and the next pass retries the pair.
    expect(report.deactivated).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({
      steamId: '76561198000000002',
      operation: 'removeWatch',
    });
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
    const first = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
    );
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

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
    );

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

    await reconcileFriendsList(UNRELATED_FRIEND, FRIEND, dal, logger);

    // Per-removal audit line + pass summary (irreversible deletions say
    // WHO, not just how many).
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(String(logger.info.mock.calls[0][0])).toContain(
      'reconcile deactivated watch (opt-out): steamId=76561198000000001',
    );
    const line = String(logger.info.mock.calls[1][0]);
    expect(line).toContain('friends=1');
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

  it('a failing activation message keeps the activation and records it', async () => {
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
      operation: 'activationMessage',
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
    await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
      onActivated,
    );

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
      // Legacy lane (no accounts row): activates like before the gate.
      getAccount: async () => null,
      activateWatch: async (steamId: string) => {
        statuses.set(steamId, 'active');
        return true;
      },
      removeWatchAndAccount: async () => ({
        watchDeleted: true,
        accountDeleted: true,
      }),
      listOrphanAccounts: async () => [],
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

  it('lets a lone candidate through on an empty snapshot (one removal is not mass)', async () => {
    // The single-exemption: blocking a lone removal would strand genuine
    // single opt-outs — the common churn — behind an override no operator
    // can distinguish from a glitch. Blast radius of a wrong single: one
    // user (and the ERROR line below would still fire for 2+).
    const logger = { info: jest.fn(), error: jest.fn() };
    const dal = makeDal([
      { steamId: '76561198000000001', status: 'active' },
      { steamId: '76561198000000002', status: 'pending' },
    ]);

    const report = await reconcileFriendsList({}, FRIEND, dal, logger);

    expect(report.massRemovalAborted).toBe(false);
    expect(report.deactivated).toEqual(['76561198000000001']);
    expect(dal.removeWatchAndAccount).toHaveBeenCalledWith(
      '76561198000000001',
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('blocks on an empty snapshot once candidates are plural', async () => {
    // The single-exemption boundary: 1 flows, 2+ on an empty snapshot
    // trip the guard (a failed fetch reads as "everyone opted out").
    const logger = { info: jest.fn(), error: jest.fn() };
    const dal = makeDal([
      { steamId: '76561198000000001', status: 'active' },
      { steamId: '76561198000000002', status: 'active' },
    ]);

    const report = await reconcileFriendsList({}, FRIEND, dal, logger);

    expect(report.massRemovalAborted).toBe(true);
    expect(report.deactivated).toEqual([]);
    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain(
      'removals BLOCKED',
    );
  });

  it('still activates while removals are blocked', async () => {    // The breaker gates ONLY the removal branch: a corrupt snapshot
    // cannot falsely activate (that requires friends.has()), so
    // onboarding never stalls behind it.
    const watches = Array.from({ length: 25 }, (_, i) => ({
      steamId: `7656119800000${String(100 + i).padStart(4, '0')}`,
      status: 'active',
    }));
    watches.push({ steamId: '76561198000000001', status: 'pending' });
    const dal = makeDal(watches);

    const report = await reconcileFriendsList(
      {
        '76561198000000001': FRIEND,
        '76561198000000099': FRIEND,
      },
      FRIEND,
      dal,
      silentLogger,
    );

    expect(report.massRemovalAborted).toBe(true);
    expect(report.activated).toEqual(['76561198000000001']);
    expect(report.deactivated).toEqual([]);
    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
  });

  it('stays quiet on an empty snapshot with no removal candidates', async () => {
    // Pending-only base: nothing could be removed, so there is nothing
    // to guard — no ERROR log every 10 min for a healthy state.
    const logger = { info: jest.fn(), error: jest.fn() };
    const dal = makeDal([{ steamId: '76561198000000001', status: 'pending' }]);

    const report = await reconcileFriendsList({}, FRIEND, dal, logger);

    expect(report.massRemovalAborted).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('aborts when removals exceed max(20, 10% of the base)', async () => {
    // 25 active watches, snapshot keeps 1 unrelated friend: 25 removals
    // against a ceiling of max(20, ceil(25 * 10%)) = 20. A glitch hiding
    // inside a large base trips the same guard as the empty snapshot.
    const watches = Array.from({ length: 25 }, (_, i) => ({
      steamId: `7656119800000${String(100 + i).padStart(4, '0')}`,
      status: 'active',
    }));
    const dal = makeDal(watches);

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
    );

    expect(report.massRemovalAborted).toBe(true);
    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
  });

  it('proceeds under the ceiling (genuine small-scale opt-outs still converge)', async () => {
    const dal = makeDal([
      { steamId: '76561198000000001', status: 'active' },
      { steamId: '76561198000000002', status: 'active' },
    ]);

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
    );

    expect(report.massRemovalAborted).toBe(false);
    expect(report.deactivated).toEqual([
      '76561198000000001',
      '76561198000000002',
    ]);
  });

  it('honors massRemoveMax for an operator-confirmed wipe', async () => {
    const dal = makeDal([{ steamId: '76561198000000001', status: 'active' }]);

    const report = await reconcileFriendsList(
      {},
      FRIEND,
      dal,
      silentLogger,
      undefined,
      undefined,
      { massRemoveMax: 50 },
    );

    expect(report.massRemovalAborted).toBe(false);
    expect(report.deactivated).toEqual(['76561198000000001']);
  });
  it('still blocks past a too-small override (forgotten number stays bounded)', async () => {
    // Override of 1 with 25 candidates: all-or-nothing per pass (no
    // partial application), so the whole set stays blocked. A forgotten
    // override degrades to a ceiling, never to guard-off.
    const watches = Array.from({ length: 25 }, (_, i) => ({
      steamId: `7656119800000${String(200 + i).padStart(4, '0')}`,
      status: 'active',
    }));
    const dal = makeDal(watches);

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
      undefined,
      undefined,
      { massRemoveMax: 1 },
    );

    expect(report.massRemovalAborted).toBe(true);
    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
  });
});

describe('evaluateMassRemovalGuard (pure verdict table)', () => {
  const active = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      steamId: `7656119800000${String(300 + i).padStart(4, '0')}`,
      status: 'active',
    }));
  const friendsOf = (...ids: string[]) => new Set(ids);

  it.each([
    // [name, watches, friends, override, blocked]
    ['no watches, empty snapshot', [], new Set<string>(), null, false],
    ['pending-only base, empty snapshot', [{ steamId: '76561198000000301', status: 'pending' }], new Set<string>(), null, false],
    ['single candidate, empty snapshot', active(1), new Set<string>(), null, false],
    ['single candidate, friends present', active(1), friendsOf('76561198000000099'), null, false],
    ['two candidates under ceiling', active(2), friendsOf('76561198000000099'), null, false],
    ['empty snapshot, 3 candidates', active(3), new Set<string>(), null, true],
    ['25 candidates, 1 friend', active(25), friendsOf('76561198000000099'), null, true],
    ['bare override never waives the empty arm (forgotten N)', active(3), new Set<string>(), 50, true],
    ['override below candidates still blocks', active(25), friendsOf('76561198000000099'), 1, true],
    ['malformed override behaves as unset', active(3), new Set<string>(), 0, true],
  ] as Array<
    [
      string,
      Array<{ steamId: string; status: string }>,
      Set<string>,
      number | null,
      boolean,
    ]
  >)(
    '%s',
    (
      _name: string,
      watches: Array<{ steamId: string; status: string }>,
      friends: Set<string>,
      override: number | null,
      blocked: boolean,
    ) => {
      expect(
        evaluateMassRemovalGuard(watches, friends, override).blocked,
      ).toBe(blocked);
    },
  );

  it.each([
    // A forgotten N ≥ base size must NOT switch the empty-snapshot arm
    // off: without swapMode the guard holds no matter what N says
    // (P1-1: old runbook example 500-on-≤250-base flowed silently).
    ['forgotten 500, empty snapshot, 200 candidates', 200, 500, false, true],
    ['forgotten 500, empty snapshot, 3 candidates', 3, 500, false, true],
    // Swap mode waives the empty arm, but only up to N...
    ['swap + within override flows', 200, 500, true, false],
    // ...past N it still trips, override or not.
    ['swap + over override still blocks', 600, 500, true, true],
    ['swap without override still blocks empty', 3, null, true, true],
  ] as Array<[string, number, number | null, boolean, boolean]>)(
    '%s',
    (
      _name: string,
      candidateCount: number,
      override: number | null,
      swapMode: boolean,
      blocked: boolean,
    ) => {
      const watches = Array.from({ length: candidateCount }, (_, i) => ({
        steamId: `7656119800000${String(500 + i).padStart(4, '0')}`,
        status: 'active',
      }));
      expect(
        evaluateMassRemovalGuard(watches, new Set<string>(), override, swapMode)
          .blocked,
      ).toBe(blocked);
    },
  );

  it.each([
    ['null stays null', null, null],
    ['undefined stays null', undefined, null],
    ['NaN stays null', Number.NaN, null],
    ['zero stays null', 0, null],
    ['negative stays null', -5, null],
    ['fraction floors', 20.9, 20],
    ['positive passes through', 500, 500],
  ] as Array<[string, number | null | undefined, number | null]>)(
    'normalizeMassRemoveMax: %s',
    (
      _name: string,
      raw: number | null | undefined,
      expected: number | null,
    ) => {
      expect(normalizeMassRemoveMax(raw)).toBe(expected);
    },
  );

  it('reports the candidate list and the size-derived ceiling', () => {    const verdict = evaluateMassRemovalGuard(
      [
        ...active(30),
        { steamId: '76561198000000099', status: 'pending' },
        { steamId: 'not-an-id', status: 'active' },
      ],
      friendsOf('76561198000000099'),
      null,
    );

    // 30 actives minus the friended one... — none friended here except
    // the pending (not a candidate): all 30 actives are candidates.
    expect(verdict.candidates).toHaveLength(30);
    // max(20, ceil(32 * 10%)) = 20; 30 > 20 → blocked.
    expect(verdict.ceiling).toBe(20);
    expect(verdict.blocked).toBe(true);
  });
});

describe('reconcile swap mode (runbook §7)', () => {
  it('removes the watch but preserves the account (history survives the swap)', async () => {
    // Bot-swap with override: non-re-added actives reset their WATCH
    // rows so the new bot starts clean, but accounts + search-history
    // links persist (attribution keys on accounts). Genuine unfriends
    // (live path, normal reconcile) still take the full-removal lane.
    const dal = makeDal([{ steamId: '76561198000000001', status: 'active' }]);

    const report = await reconcileFriendsList(
      {},
      FRIEND,
      dal,
      silentLogger,
      undefined,
      undefined,
      { massRemoveMax: 50, swapMode: true },
    );

    expect(report.massRemovalAborted).toBe(false);
    expect(report.deactivated).toEqual(['76561198000000001']);
    expect(dal.deactivateWatch).toHaveBeenCalledWith('76561198000000001');
    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
  });

  it('still honors the breaker in swap mode (override gates both lanes)', async () => {
    // Swap mode changes WHAT a removal deletes, not WHETHER the guard
    // trips: without massRemoveMax, a suspect snapshot stays fully
    // blocked even with swapMode on.
    const watches = Array.from({ length: 25 }, (_, i) => ({
      steamId: `7656119800000${String(400 + i).padStart(4, '0')}`,
      status: 'active',
    }));
    const dal = makeDal(watches);

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
      undefined,
      undefined,
      { swapMode: true },
    );

    expect(report.massRemovalAborted).toBe(true);
    expect(dal.deactivateWatch).not.toHaveBeenCalled();
    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
  });

  it('sweeps non-friend orphan accounts through the shared composite', async () => {
    // Reconnect → unfriend while the bot is offline: the live path never
    // ran, the watch loop cannot see account-only rows, and the lingering
    // row would keep attributing new searches. Non-friends go through
    // removeWatchAndAccount (watch DELETE is a no-op for orphans).
    const dal = makeDal([], {}, ['76561198000000011']);

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
    );

    expect(dal.removeWatchAndAccount).toHaveBeenCalledTimes(1);
    expect(dal.removeWatchAndAccount).toHaveBeenCalledWith(
      '76561198000000011',
    );
    expect(report.orphanAccountsSwept).toEqual(['76561198000000011']);
  });

  it('keeps orphan accounts that are still friends (active reconnect users)', async () => {
    // Friend + account + no watch is the HEALTHY reconnect state — the
    // sweep only targets rows whose owner is gone from the snapshot.
    const dal = makeDal([], {}, ['76561198000000011']);

    const report = await reconcileFriendsList(
      { ...UNRELATED_FRIEND, '76561198000000011': FRIEND },
      FRIEND,
      dal,
      silentLogger,
    );

    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
    expect(report.orphanAccountsSwept).toEqual([]);
  });

  it('skips the orphan sweep while the breaker holds', async () => {
    // Same verdict as the watch removals: a suspect snapshot blocks
    // everything, orphans included — retried next pass.
    const watches = Array.from({ length: 25 }, (_, i) => ({
      steamId: `7656119800000${String(400 + i).padStart(4, '0')}`,
      status: 'active',
    }));
    const dal = makeDal(watches, {}, ['76561198000000011']);

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
    );

    expect(report.massRemovalAborted).toBe(true);
    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
    expect(report.orphanAccountsSwept).toEqual([]);
  });

  it('skips the orphan sweep on an empty snapshot (glitch arm)', async () => {
    // The watch-based verdict cannot trip with zero watches, so the
    // sweep carries its own explicit empty-snapshot arm: an empty
    // friendsList means the fetch failed, never a mass opt-out.
    const dal = makeDal([], {}, ['76561198000000011']);

    const report = await reconcileFriendsList({}, FRIEND, dal, silentLogger);

    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
    expect(report.orphanAccountsSwept).toEqual([]);
  });

  it('skips the orphan sweep in swap mode (accounts must survive the swap)', async () => {
    const dal = makeDal([], {}, ['76561198000000011']);

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
      undefined,
      undefined,
      { swapMode: true },
    );

    expect(dal.removeWatchAndAccount).not.toHaveBeenCalled();
    expect(report.orphanAccountsSwept).toEqual([]);
  });

  it('caps orphan deletions per pass (bounded blast radius)', async () => {
    const orphans = Array.from({ length: 12 }, (_, i) => (
      `7656119800000${String(500 + i).padStart(4, '0')}`
    ));
    const dal = makeDal([], {}, orphans);

    const report = await reconcileFriendsList(
      UNRELATED_FRIEND,
      FRIEND,
      dal,
      silentLogger,
    );

    expect(dal.removeWatchAndAccount).toHaveBeenCalledTimes(10);
    expect(report.orphanAccountsSwept).toHaveLength(10);
  });
});

describe('requestSwapExemption (one-shot arming)', () => {
  // The host arms optimistically at request time (so back-to-back
  // snapshots can't both read "unarmed") and rolls back unless the
  // pass ran cleanly — modeled by the caller, pinned here per arm.
  it.each([
    ['window open, nothing consumed → armed', true, false, true],
    ['window closed → never armed', false, false, false],
    ['already consumed → never re-armed', true, true, false],
    ['closed and consumed → never armed', false, true, false],
  ] as Array<[string, boolean, boolean, boolean]>)(
    '%s',
    (
      _name: string,
      windowActive: boolean,
      consumed: boolean,
      useSwap: boolean,
    ) => {
      expect(requestSwapExemption(windowActive, consumed)).toBe(useSwap);
    },
  );
});

describe('shouldKeepSwapExemption (rollback unless clean)', () => {
  // The host rolls the optimistic arm back unless the armed pass ran
  // cleanly: a failed (rejected), blocked, or errored pass leaves it
  // armed so the next pass retries with swap semantics.
  type ErrorRow = { steamId: string; operation: string; message: string };
  const noErrors: Array<ErrorRow> = [];
  const boom: Array<ErrorRow> = [
    { steamId: 'x', operation: 'removeWatch', message: 'boom' },
  ];
  it.each([
    ['clean swap pass stays consumed', false, noErrors, true],
    ['blocked pass rolls back to armed', true, noErrors, false],
    ['pass with row errors rolls back to armed', false, boom, false],
    ['blocked pass with errors rolls back to armed', true, boom, false],
  ])(
    '%s',
    (
      _name: string,
      massRemovalAborted: boolean,
      errors: Array<ErrorRow>,
      keep: boolean,
    ) => {
      expect(shouldKeepSwapExemption({ massRemovalAborted, errors })).toBe(
        keep,
      );
    },
  );
});

describe('isSwapWindowActive (self-expiring override)', () => {
  it.each([
    ['unset means no window', 1_000_000, null, false],
    ['undefined means no window', 1_000_000, undefined, false],
    ['NaN means no window', 1_000_000, Number.NaN, false],
    ['future instant is active', 1_000_000, 2_000_000, true],
    ['exact boundary is over (strict <)', 2_000_000, 2_000_000, false],
    ['past instant expired without a restart', 3_000_000, 2_000_000, false],
  ] as Array<[string, number, number | null | undefined, boolean]>)(
    '%s',
    (
      _name: string,
      nowMs: number,
      until: number | null | undefined,
      active: boolean,
    ) => {
      expect(isSwapWindowActive(nowMs, until)).toBe(active);
    },
  );
});
