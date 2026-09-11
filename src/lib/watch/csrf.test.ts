import checkSameOrigin from './csrf';

const makeRequest = (url: string, headers: Record<string, string> = {}) =>
  ({
    url,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  }) as unknown as Request;

describe('checkSameOrigin', () => {
  it('accepts matching Origin (exact origin echo)', () => {
    expect(
      checkSameOrigin(
        makeRequest('http://localhost:3000/api/watch/request', {
          origin: 'http://localhost:3000',
        }),
      ),
    ).toBe(true);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(
      checkSameOrigin(
        makeRequest('https://reveal.example/api/watch/request', {
          referer: 'https://reveal.example/en/watch',
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['cross-origin Origin', { origin: 'https://evil.example' }],
    ['cross-origin Referer', { referer: 'https://evil.example/x' }],
    ['no origin headers at all', {}],
    ['garbage Origin', { origin: 'not-a-url' }],
    ['scheme downgrade', { origin: 'http://reveal.example' }],
  ])('rejects %s', (_label, headers) => {
    expect(
      checkSameOrigin(
        makeRequest('https://reveal.example/api/watch/request', headers),
      ),
    ).toBe(false);
  });

  it('rejects unparseable request URLs', () => {
    expect(
      checkSameOrigin(
        makeRequest('::bad-url::', { origin: 'http://localhost:3000' }),
      ),
    ).toBe(false);
  });
});
