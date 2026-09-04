// Env-gated analytics adapter tests.
//
// The adapter is the only place that decides BETWEEN the JSON file store and
// Turso, so both mocks below must be complete: './analytics' (JSON path) and
// '../../lib/analytics/db' (Turso path). Nothing hits @libsql/client here.
const mockJsonRecordSearch = jest.fn();
const mockJsonAttachCheaterProbability = jest.fn();
const mockRefreshDashboard = jest.fn();
const mockTursoRecordSearch = jest.fn();
const mockTursoAttachCheaterProbability = jest.fn();
const mockGetSearchRecords = jest.fn();

jest.mock('./analytics', () => ({
  recordSearch: mockJsonRecordSearch,
  attachCheaterProbability: mockJsonAttachCheaterProbability,
  refreshDashboard: mockRefreshDashboard,
}));

jest.mock('../../lib/analytics/db', () => ({
  recordSearch: mockTursoRecordSearch,
  attachCheaterProbability: mockTursoAttachCheaterProbability,
  getSearchRecords: mockGetSearchRecords,
}));

const adapter = require('./analyticsAdapter') as typeof import('./analyticsAdapter');

const input = { profile: { steamId: '76561198000000000' }, friends: [] };

const newRecord = {
  id: '1699999999999-abc123',
  searchedAt: '2023-11-14T12:00:00.000Z',
  profile: { steamId: '76561198000000000' },
  friends: [],
  cheater: null,
};

describe('analyticsAdapter', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetAllMocks();
    mockTursoRecordSearch.mockResolvedValue(newRecord);
    mockTursoAttachCheaterProbability.mockResolvedValue(true);
    mockGetSearchRecords.mockResolvedValue([newRecord]);
    mockRefreshDashboard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses the JSON store when DATABASE_URL is not configured', async () => {
    delete process.env.DATABASE_URL;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    mockJsonRecordSearch.mockResolvedValue(newRecord);
    await adapter.recordSearch(input);
    await adapter.attachCheaterProbability('id-1', { score: 42, computedAt: 't' });

    expect(mockJsonRecordSearch).toHaveBeenCalledTimes(1);
    expect(mockJsonAttachCheaterProbability).toHaveBeenCalledTimes(1);
    expect(mockTursoRecordSearch).not.toHaveBeenCalled();
    expect(mockTursoAttachCheaterProbability).not.toHaveBeenCalled();
    expect(mockRefreshDashboard).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('uses Turso when DATABASE_URL is configured and regenerates the dashboard from Turso data', async () => {
    process.env.DATABASE_URL = 'libsql://steamreveal-org.turso.io';

    const record = await adapter.recordSearch(input);

    expect(record.id).toBe(newRecord.id);
    expect(mockTursoRecordSearch).toHaveBeenCalledTimes(1);
    expect(mockJsonRecordSearch).not.toHaveBeenCalled();
    expect(mockGetSearchRecords).toHaveBeenCalledTimes(1);
    expect(mockRefreshDashboard).toHaveBeenCalledTimes(1);
  });

  it('attaches the cheater result to Turso and refreshes the dashboard', async () => {
    process.env.DATABASE_URL = 'libsql://steamreveal-org.turso.io';

    const updated = await adapter.attachCheaterProbability('id-1', {
      score: 72,
      bannedFriendsCount: 4,
      computedAt: '2023-11-14T13:00:00.000Z',
    });

    expect(updated).toBe(true);
    expect(mockTursoAttachCheaterProbability).toHaveBeenCalledTimes(1);
    expect(mockJsonAttachCheaterProbability).not.toHaveBeenCalled();
    expect(mockRefreshDashboard).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the dashboard when the searchId is missing', async () => {
    process.env.DATABASE_URL = 'libsql://steamreveal-org.turso.io';
    mockTursoAttachCheaterProbability.mockResolvedValue(false);

    const updated = await adapter.attachCheaterProbability('missing-id', {
      score: 72,
      computedAt: '2023-11-14T13:00:00.000Z',
    });

    expect(updated).toBe(false);
    expect(mockRefreshDashboard).not.toHaveBeenCalled();
  });

  it('still returns the recorded search when only the dashboard refresh fails', async () => {
    process.env.DATABASE_URL = 'libsql://steamreveal-org.turso.io';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetSearchRecords.mockRejectedValue(new Error('turso down'));

    await expect(adapter.recordSearch(input)).resolves.toEqual(newRecord);
    expect(mockTursoRecordSearch).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});