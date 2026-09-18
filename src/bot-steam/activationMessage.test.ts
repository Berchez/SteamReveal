import { handleActivation, sendConfirmLink } from './activationMessage';

jest.mock('../lib/analytics/db', () => ({
  getAccount: jest.fn(),
  hashConfirmToken: jest.fn(() => 'ab'.repeat(32)),
  issueConfirmToken: jest.fn(),
  issueConfirmTokenIfAbsent: jest.fn(),
  clearConfirmToken: jest.fn(),
  enqueueEvent: jest.fn(),
}));

jest.mock('./notifyMessage', () => ({
  sendConfirmMessage: jest.fn(),
}));

jest.mock('./welcomeMessage', () => ({
  sendWelcomeMessage: jest.fn(),
}));

const mockedDb = jest.requireMock('../lib/analytics/db') as {
  getAccount: jest.Mock;
  hashConfirmToken: jest.Mock;
  issueConfirmToken: jest.Mock;
  issueConfirmTokenIfAbsent: jest.Mock;
  clearConfirmToken: jest.Mock;
  enqueueEvent: jest.Mock;
};

const { sendConfirmMessage } = jest.requireMock('./notifyMessage') as {
  sendConfirmMessage: jest.Mock;
};

const { sendWelcomeMessage } = jest.requireMock('./welcomeMessage') as {
  sendWelcomeMessage: jest.Mock;
};

const STEAM = '76561198000000001';
const CONFIG = {
  siteUrl: 'https://reveal.example',
  confirmTokenTtlMs: 24 * 3600 * 1000,
};
const CHAT = {
  sendFriendMessage: jest.fn(async () => ({ ordinal: 1 })),
};

describe('handleActivation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('issues a fresh token + confirm link for unconfirmed accounts', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
    });
    mockedDb.issueConfirmToken.mockResolvedValue(true);

    await handleActivation(CHAT, STEAM, 'es', CONFIG);

    expect(mockedDb.issueConfirmToken).toHaveBeenCalledTimes(1);
    const [issuedId, hash, expiresAt] =
      mockedDb.issueConfirmToken.mock.calls[0];
    expect(issuedId).toBe(STEAM);
    // The token itself never reaches the DAL — only its hash, derived
    // from the exact token embedded in the link below.
    expect(hash).toBe('ab'.repeat(32));
    const ttlMs = Date.parse(expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 3600 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 3600 * 1000);

    expect(sendConfirmMessage).toHaveBeenCalledTimes(1);
    const [chat, id, locale, url] = sendConfirmMessage.mock.calls[0];
    expect(chat).toBe(CHAT);
    expect(id).toBe(STEAM);
    expect(locale).toBe('es');
    expect(url).toMatch(
      /^https:\/\/reveal\.example\/api\/watch\/confirm\?token=[0-9a-f]{64}$/,
    );
    // And the DAL hash came from that same plaintext token.
    const token = url.split('token=')[1];
    expect(mockedDb.hashConfirmToken).toHaveBeenCalledWith(token);
    expect(sendWelcomeMessage).not.toHaveBeenCalled();
  });

  it('falls back to welcome when the token lost a confirm race', async () => {
    // Read unconfirmed, but the user clicked the previous link between
    // the read and the issue: the fresh link would already be dead.
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
    });
    mockedDb.issueConfirmToken.mockResolvedValue(false);

    await handleActivation(CHAT, STEAM, 'pt', CONFIG);

    expect(sendConfirmMessage).not.toHaveBeenCalled();
    expect(sendWelcomeMessage).toHaveBeenCalledWith(CHAT, STEAM, 'pt');
  });

  it('falls back to the signup account locale when the watch has none', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
      locale: 'pt',
    });
    mockedDb.issueConfirmToken.mockResolvedValue(true);

    await handleActivation(CHAT, STEAM, null, CONFIG);

    expect(sendConfirmMessage).toHaveBeenCalledTimes(1);
    expect(sendConfirmMessage.mock.calls[0][2]).toBe('pt');
  });

  it('sends welcome for confirmed accounts and legacy rows alike', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: '2026-09-02T00:00:00.000Z',
    });
    await handleActivation(CHAT, STEAM, 'en', CONFIG);
    expect(sendWelcomeMessage).toHaveBeenCalledWith(CHAT, STEAM, 'en');

    jest.clearAllMocks();
    mockedDb.getAccount.mockResolvedValue(null);
    await handleActivation(CHAT, STEAM, null, CONFIG);
    expect(sendWelcomeMessage).toHaveBeenCalledWith(CHAT, STEAM, null);

    expect(mockedDb.issueConfirmToken).not.toHaveBeenCalled();
    expect(sendConfirmMessage).not.toHaveBeenCalled();
  });

  it('lets DAL read failures propagate to reconcile per-row isolation', async () => {
    mockedDb.getAccount.mockRejectedValue(new Error('turso down'));
    await expect(handleActivation(CHAT, STEAM, 'en', CONFIG)).rejects.toThrow(
      'turso down',
    );
  });

  it('rolls the issued token back when its own link send fails (no silent lockout)', async () => {
    // Same failure class as sendConfirmLink's rollback test, on the
    // activation lane: the hash must not outlive an undelivered link.
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
    });
    mockedDb.issueConfirmToken.mockResolvedValue(true);
    sendConfirmMessage.mockRejectedValueOnce(new Error('chat down'));

    await expect(handleActivation(CHAT, STEAM, 'en', CONFIG)).rejects.toThrow(
      'chat down',
    );
    expect(mockedDb.clearConfirmToken).toHaveBeenCalledWith(
      STEAM,
      'ab'.repeat(32),
    );
  });

  it('queues the welcome through the outbox when the direct send fails (activated rows never re-fire)', async () => {
    // handleActivation runs AFTER activateWatch committed — the row is
    // active, so nothing will ever re-fire this hook. Before the fallback
    // a chat hiccup here lost the welcome forever, silently.
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: '2026-09-02T00:00:00.000Z',
    });
    sendWelcomeMessage.mockRejectedValueOnce(new Error('chat down'));

    await expect(
      handleActivation(CHAT, STEAM, 'en', CONFIG),
    ).resolves.toBeUndefined();

    expect(mockedDb.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(mockedDb.enqueueEvent).toHaveBeenCalledWith(STEAM, 'welcome');
  });

  it('also queues the race-fallback welcome when its direct send fails', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
    });
    mockedDb.issueConfirmToken.mockResolvedValue(false);
    sendWelcomeMessage.mockRejectedValueOnce(new Error('chat down'));

    await expect(
      handleActivation(CHAT, STEAM, 'en', CONFIG),
    ).resolves.toBeUndefined();

    expect(mockedDb.enqueueEvent).toHaveBeenCalledWith(STEAM, 'welcome');
  });

  it('propagates when the welcome outbox fallback itself fails (loud, never a silent loss)', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: '2026-09-02T00:00:00.000Z',
    });
    sendWelcomeMessage.mockRejectedValueOnce(new Error('chat down'));
    mockedDb.enqueueEvent.mockRejectedValueOnce(new Error('turso down'));

    await expect(handleActivation(CHAT, STEAM, 'en', CONFIG)).rejects.toThrow(
      'turso down',
    );
  });
});

describe('sendConfirmLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: the guarded issue succeeds (no concurrent resend in flight).
    mockedDb.issueConfirmTokenIfAbsent.mockResolvedValue(true);
  });

  it('sends a fresh link for unconfirmed accounts without a live token', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
      confirmTokenHash: null,
      confirmExpiresAt: null,
      locale: 'pt',
    });

    await expect(sendConfirmLink(CHAT, STEAM, null, CONFIG)).resolves.toBe(
      true,
    );

    // Guarded (if-absent) issue — the resend lane's unconditional issue is
    // a different DAL call, never made here.
    expect(mockedDb.issueConfirmTokenIfAbsent).toHaveBeenCalledTimes(1);
    expect(mockedDb.issueConfirmToken).not.toHaveBeenCalled();
    expect(sendConfirmMessage).toHaveBeenCalledTimes(1);
    // Watch locale first, account locale fallback (mirrors handleActivation).
    expect(sendConfirmMessage.mock.calls[0][2]).toBe('pt');
    expect(sendWelcomeMessage).not.toHaveBeenCalled();
  });

  it('skips quietly when a live token is already outstanding', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
      confirmTokenHash: 'ab'.repeat(32),
      confirmExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    });

    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).resolves.toBe(
      false,
    );

    // Resending every pass would spam chat on every reconnect: one
    // outstanding link max, enforced here.
    expect(mockedDb.issueConfirmTokenIfAbsent).not.toHaveBeenCalled();
    expect(sendConfirmMessage).not.toHaveBeenCalled();
    expect(sendWelcomeMessage).not.toHaveBeenCalled();
  });

  it('never re-issues over an expired token (expiry flow owns it)', async () => {
    // Regression net for silent auto-resend: an expired generation must
    // NOT produce a fresh link here — the expiry poller already noticed
    // (or will), and only an explicit resend request re-arms. Otherwise
    // every reconcile pass (boot, reconnects, 10-min backstop) would spam
    // a new link forever to users who never click.
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
      confirmTokenHash: 'ab'.repeat(32),
      confirmExpiresAt: '2000-01-01T00:00:00.000Z',
    });

    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).resolves.toBe(
      false,
    );

    expect(mockedDb.issueConfirmTokenIfAbsent).not.toHaveBeenCalled();
    expect(sendConfirmMessage).not.toHaveBeenCalled();
    expect(sendWelcomeMessage).not.toHaveBeenCalled();
  });

  it('skips confirmed accounts and missing rows without sending anything', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: '2026-09-02T00:00:00.000Z',
    });
    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).resolves.toBe(
      false,
    );

    mockedDb.getAccount.mockResolvedValue(null);
    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).resolves.toBe(
      false,
    );

    expect(mockedDb.issueConfirmTokenIfAbsent).not.toHaveBeenCalled();
    expect(sendConfirmMessage).not.toHaveBeenCalled();
    expect(sendWelcomeMessage).not.toHaveBeenCalled();
  });

  it('skips (never welcomes) when the guarded issue loses a race', async () => {
    // Two losers, same quiet skip: a concurrent click (confirmed between
    // the read and the issue) or a concurrent resend-lane issue (the P1-2
    // race — an explicit user request wins and its delivery supersedes
    // this one). Unlike handleActivation's welcome fallback, welcoming
    // here would lie — the watch is not active, and the confirm route
    // owns activation + welcome from this point on. And since WE issued
    // nothing, there is nothing to roll back.
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
      confirmTokenHash: null,
      confirmExpiresAt: null,
    });
    mockedDb.issueConfirmTokenIfAbsent.mockResolvedValueOnce(false);

    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).resolves.toBe(
      false,
    );

    expect(sendConfirmMessage).not.toHaveBeenCalled();
    expect(sendWelcomeMessage).not.toHaveBeenCalled();
    expect(mockedDb.clearConfirmToken).not.toHaveBeenCalled();
  });

  it('lets DAL read failures propagate to reconcile per-row isolation', async () => {
    mockedDb.getAccount.mockRejectedValue(new Error('turso down'));
    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).rejects.toThrow(
      'turso down',
    );
    expect(mockedDb.clearConfirmToken).not.toHaveBeenCalled();
  });

  it('rolls the issued token back when the chat send fails (no silent 24h lockout)', async () => {
    // The P1 scenario, pinned: issueConfirmToken commits, then
    // sendConfirmMessage throws. Before the rollback the hash stayed —
    // the UI showed "check your Steam chat" (confirmLinkSent derives
    // from hash presence), every later pass skipped on first-issue-only,
    // and the resend button only appeared after the 24h expiry.
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
      confirmTokenHash: null,
      confirmExpiresAt: null,
    });
    mockedDb.issueConfirmTokenIfAbsent.mockResolvedValue(true);
    sendConfirmMessage.mockRejectedValueOnce(new Error('chat down'));

    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).rejects.toThrow(
      'chat down',
    );

    // Compare-and-delete with the exact hash that was issued, so a
    // concurrent click (consumed) or resend (replaced) is never clobbered.
    expect(mockedDb.clearConfirmToken).toHaveBeenCalledTimes(1);
    expect(mockedDb.clearConfirmToken).toHaveBeenCalledWith(
      STEAM,
      'ab'.repeat(32),
    );
  });

  it('rethrows the original send error when the rollback loses the race (newer generation won)', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
      confirmTokenHash: null,
      confirmExpiresAt: null,
    });
    mockedDb.issueConfirmTokenIfAbsent.mockResolvedValue(true);
    // clearConfirmToken false = the hash no longer matched: a click or a
    // resend replaced the state mid-flight. That newer state stands.
    mockedDb.clearConfirmToken.mockResolvedValueOnce(false);
    sendConfirmMessage.mockRejectedValueOnce(new Error('chat down'));

    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).rejects.toThrow(
      'chat down',
    );
    expect(mockedDb.clearConfirmToken).toHaveBeenCalledTimes(1);
  });

  it('reports loudly when BOTH the send and the rollback fail (stuck hash needs hand attention)', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
      confirmTokenHash: null,
      confirmExpiresAt: null,
    });
    mockedDb.issueConfirmTokenIfAbsent.mockResolvedValue(true);
    mockedDb.clearConfirmToken.mockRejectedValueOnce(new Error('turso down'));
    sendConfirmMessage.mockRejectedValueOnce(new Error('chat down'));

    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).rejects.toThrow(
      /chat down.*rollback failed.*turso down/,
    );
  });

  it('never rolls anything back on the happy path (a delivered link keeps its hash)', async () => {
    mockedDb.getAccount.mockResolvedValue({
      steamId: STEAM,
      confirmedAt: null,
      confirmTokenHash: null,
      confirmExpiresAt: null,
    });
    mockedDb.issueConfirmTokenIfAbsent.mockResolvedValue(true);

    await expect(sendConfirmLink(CHAT, STEAM, 'en', CONFIG)).resolves.toBe(
      true,
    );

    expect(mockedDb.clearConfirmToken).not.toHaveBeenCalled();
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
  });
});
