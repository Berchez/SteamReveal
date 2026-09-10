import INVITE_REREQUEST_AFTER_MS from './watchInviteCooldown';

describe('INVITE_REREQUEST_AFTER_MS', () => {
  it('is exactly 7 days in milliseconds', () => {
    expect(INVITE_REREQUEST_AFTER_MS).toBe(7 * 24 * 3600 * 1000);
  });
});
