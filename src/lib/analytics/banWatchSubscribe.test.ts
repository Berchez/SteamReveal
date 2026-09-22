import { subscribeBanWatcher } from './banWatchSubscribe';

const SUB = '76561198000000001';
const TARGET = '76561198000000002';

const silentLogger = { error: jest.fn() };

const makeDeps = (overrides = {}) => ({
  getTargetSteamId: jest.fn(async () => TARGET),
  ensureTarget: jest.fn(async () => undefined),
  readTarget: jest.fn(async () => null),
  checkBanned: jest.fn(async (): Promise<boolean | null> => false),
  markChecked: jest.fn(async () => undefined),
  create: jest.fn(async () => ({ created: true })),
  ...overrides,
});

describe('subscribeBanWatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('subscribes via the trusted join (never client input)', async () => {
    const deps = makeDeps();
    const res = await subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);

    expect(res).toEqual({ subscribed: true, created: true });
    expect(deps.getTargetSteamId).toHaveBeenCalledWith('search-1');
    expect(deps.ensureTarget).toHaveBeenCalledWith(TARGET);
    expect(deps.create).toHaveBeenCalledWith(SUB, TARGET, 'search-1', false);
  });

  it('marks already-banned-at-subscribe as notified (cached verdict, no alert later)', async () => {
    const deps = makeDeps({
      readTarget: jest.fn(async () => ({
        lastKnownBanned: true,
        lastBanCheckedAt: '2026-01-01T00:00:00.000Z',
      })),
    });
    await subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);

    expect(deps.checkBanned).not.toHaveBeenCalled();
    expect(deps.markChecked).not.toHaveBeenCalled();
    expect(deps.create).toHaveBeenCalledWith(SUB, TARGET, 'search-1', true);
  });

  it('persists a live banned verdict as a sweep-equivalent sighting (one live call per target)', async () => {
    const deps = makeDeps({
      checkBanned: jest.fn(async (): Promise<boolean | null> => true),
    });
    await subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);

    expect(deps.markChecked).toHaveBeenCalledWith(TARGET, true);
    expect(deps.create).toHaveBeenCalledWith(SUB, TARGET, 'search-1', true);
  });

  it('persists a live clean verdict too (sweep detects the later transition)', async () => {
    const deps = makeDeps();
    await subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);

    expect(deps.markChecked).toHaveBeenCalledWith(TARGET, false);
    expect(deps.create).toHaveBeenCalledWith(SUB, TARGET, 'search-1', false);
  });

  it('persists nothing when the live check is unknown (sweep baseline heals)', async () => {
    const deps = makeDeps({
      checkBanned: jest.fn(async (): Promise<boolean | null> => null),
    });
    await subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);

    expect(deps.markChecked).not.toHaveBeenCalled();
    expect(deps.create).toHaveBeenCalledWith(SUB, TARGET, 'search-1', false);
  });

  it('still subscribes when the sighting persist fails (fail-open)', async () => {
    const deps = makeDeps({
      checkBanned: jest.fn(async (): Promise<boolean | null> => true),
      markChecked: jest.fn(async () => {
        throw new Error('Turso down');
      }),
    });
    const res = await subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);

    expect(res).toEqual({ subscribed: true, created: true });
    expect(deps.create).toHaveBeenCalledWith(SUB, TARGET, 'search-1', true);
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it('re-opening an already-subscribed profile is a no-op insert', async () => {
    const deps = makeDeps({
      create: jest.fn(async () => ({ created: false })),
    });
    const res = await subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);

    expect(res).toEqual({ subscribed: true, created: false });
  });

  it('does nothing when the search has no profile row', async () => {
    const deps = makeDeps({
      getTargetSteamId: jest.fn(async () => null),
    });
    const res = await subscribeBanWatcher(SUB, 'ghost', silentLogger, deps);

    expect(res).toEqual({ subscribed: false, reason: 'no-target' });
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('fail-open on ban-check failure (sweep baseline heals without alerting)', async () => {
    const deps = makeDeps({
      checkBanned: jest.fn(async () => {
        throw new Error('Steam down');
      }),
    });
    const res = await subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);

    expect(res).toEqual({ subscribed: true, created: true });
    expect(deps.create).toHaveBeenCalledWith(SUB, TARGET, 'search-1', false);
    expect(silentLogger.error).toHaveBeenCalled();
  });

  it('shares one live Steam call across concurrent opens of the same target (single-flight)', async () => {
    // The viral-profile case: N opens land while the target is still
    // unswept. Without dedupe each would fire its own GetPlayerBans
    // against the shared key pool.
    let release!: (verdict: boolean | null) => void;
    const gate = new Promise<boolean | null>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({ checkBanned: jest.fn(() => gate) });
    const first = subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);
    const second = subscribeBanWatcher(
      '76561198000000009',
      'search-2',
      silentLogger,
      deps,
    );
    // Microtasks always drain before the next macrotask, so by the time
    // this fires both opens are parked on the same gate.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(deps.checkBanned).toHaveBeenCalledTimes(1);
    release(true);
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra).toEqual({ subscribed: true, created: true });
    expect(rb).toEqual({ subscribed: true, created: true });
    expect(deps.checkBanned).toHaveBeenCalledTimes(1);
    // The persist is per-subscriber (cheap idempotent write), only the
    // Steam call is deduped.
    expect(deps.markChecked).toHaveBeenCalledWith(TARGET, true);
    expect(deps.create).toHaveBeenCalledWith(
      '76561198000000009',
      TARGET,
      'search-2',
      true,
    );
  });

  it('never throws (route contract: cheater write always wins)', async () => {
    const deps = makeDeps({
      getTargetSteamId: jest.fn(async () => {
        throw new Error('DB down');
      }),
    });
    const res = await subscribeBanWatcher(SUB, 'search-1', silentLogger, deps);

    expect(res).toEqual({ subscribed: false, reason: 'error' });
  });
});
