import { trackModalEvent } from './modalAnalytics';
import { parseModalEventBody } from '@/app/api/analytics/input';

describe('modalAnalytics (promo-modal engagement instrumentation)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterEach(() => {
    delete (global as Record<string, unknown>).fetch;
  });

  it('posts modal + event to the modals route (fire-and-forget)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as Record<string, unknown>).fetch = fetchMock;

    await trackModalEvent('sponsor', 'shown');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/recordAnalyticsModals');
    expect((init as { keepalive?: boolean }).keepalive).toBe(true);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      modal: 'sponsor',
      event: 'shown',
    });
  });

  it('carries no identifiers (counts only — no session, no search)', async () => {
    // Pins the P1-2 decision: the beacon must never grow a browser UUID
    // or search correlation without its own privacy review. localStorage
    // stays untouched even when available.
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as Record<string, unknown>).fetch = fetchMock;
    const setItem = jest.spyOn(window.localStorage.__proto__, 'setItem');
    const getItem = jest.spyOn(window.localStorage.__proto__, 'getItem');

    await trackModalEvent('support', 'dismissed');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ modal: 'support', event: 'dismissed' });
    // No anonymous session is minted or read for modals (the single
    // getItem call below, if any, is the owner skip-password header —
    // never the sr_anon_sid funnel key).
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalledWith('sr_anon_sid');
  });

  it('the exact beacon payload passes the server-side parser', async () => {
    // Links the client's payload shape to the route's validation: if one
    // side drifts (renamed field, loosened bound), this fails here instead
    // of as silently-dropped rows in production.
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as Record<string, unknown>).fetch = fetchMock;

    await trackModalEvent('login_prompt', 'cta_clicked');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(parseModalEventBody(body)).toEqual(body);
  });

  it('never throws without fetch (SSR / exotic environments)', async () => {
    delete (global as Record<string, unknown>).fetch;

    await expect(trackModalEvent('sponsor', 'closed')).resolves.toBeUndefined();
  });

  it('never throws when the network fails', async () => {
    (global as Record<string, unknown>).fetch = jest
      .fn()
      .mockRejectedValue(new Error('offline'));

    await expect(
      trackModalEvent('support', 'cta_clicked'),
    ).resolves.toBeUndefined();
  });
});
