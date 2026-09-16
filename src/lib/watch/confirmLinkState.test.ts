import {
  resolveConfirmLinkState,
} from './confirmLinkState';
import type { WatchAccount } from '@/lib/analytics/types';

const STEAM = '76561198000000001';

const baseAccount = (overrides: Partial<WatchAccount> = {}): WatchAccount => ({
  steamId: STEAM,
  createdAt: '2026-06-01T00:00:00.000Z',
  confirmedAt: null,
  confirmTokenHash: null,
  confirmExpiresAt: null,
  locale: null,
  ...overrides,
});

describe('resolveConfirmLinkState', () => {
  it('reads {false, false} without an account row', () => {
    expect(resolveConfirmLinkState(null)).toEqual({
      confirmExpired: false,
      confirmLinkSent: false,
    });
  });

  it('reads {false, false} once confirmed (link spent)', () => {
    expect(
      resolveConfirmLinkState(
        baseAccount({
          confirmedAt: '2026-06-02T00:00:00.000Z',
          confirmTokenHash: 'ab'.repeat(32),
          confirmExpiresAt: '2000-01-01T00:00:00.000Z',
        }),
      ),
    ).toEqual({ confirmExpired: false, confirmLinkSent: false });
  });

  it('flags an unclicked live link as sent but not expired', () => {
    expect(
      resolveConfirmLinkState(
        baseAccount({
          confirmTokenHash: 'ab'.repeat(32),
          confirmExpiresAt: '2999-01-01T00:00:00.000Z',
        }),
      ),
    ).toEqual({ confirmExpired: false, confirmLinkSent: true });
  });

  it('flags a dead unclicked link as expired and sent', () => {
    expect(
      resolveConfirmLinkState(
        baseAccount({
          confirmTokenHash: 'ab'.repeat(32),
          confirmExpiresAt: '2000-01-01T00:00:00.000Z',
        }),
      ),
    ).toEqual({ confirmExpired: true, confirmLinkSent: true });
  });

  it('fail-closes a corrupt expiry, still detecting the issued link', () => {
    expect(
      resolveConfirmLinkState(
        baseAccount({
          confirmTokenHash: 'ab'.repeat(32),
          confirmExpiresAt: 'not-a-date',
        }),
      ),
    ).toEqual({ confirmExpired: false, confirmLinkSent: true });
  });

  it('reads {false, false} for an unconfirmed account with no generation', () => {
    expect(resolveConfirmLinkState(baseAccount())).toEqual({
      confirmExpired: false,
      confirmLinkSent: false,
    });
  });
});
