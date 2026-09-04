import { sanitizeError } from './sanitizeError';

describe('sanitizeError', () => {
  it('redacts token= and token: literals', () => {
    expect(sanitizeError(new Error('auth failed token=supersecret'))).toBe(
      'auth failed token=[REDACTED]',
    );
    expect(sanitizeError('token:eyJhbc== boom')).toBe(
      'token=[REDACTED] boom',
    );
  });

  it('redacts quoted and bare tokens after the word token', () => {
    expect(
      sanitizeError(new Error("Invalid token 'eyJhbGciOiJIUzI1NiJ9.sig'")),
    ).toBe('Invalid token=[REDACTED]');
    expect(sanitizeError('Unauthorized token abc123XYZ_')).toBe(
      'Unauthorized token=[REDACTED]',
    );
  });

  it('redacts standalone JWT-shaped strings anywhere in the message', () => {
    expect(
      sanitizeError(
        'connect rejected, credential eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig is bad',
      ),
    ).toBe('connect rejected, credential [JWT REDACTED] is bad');
  });

  it('redacts libsql:// connection strings and other db URLs', () => {
    expect(
      sanitizeError('failed to open libsql://steamreveal-user:tok@host.turso.io:8080'),
    ).toBe('failed to open [URL REDACTED]');
    expect(sanitizeError('bad url https://user:pass@example.com/x')).toBe(
      'bad url [URL REDACTED]',
    );
  });

  it('leaves ordinary messages untouched', () => {
    expect(sanitizeError(new Error('Rate limit exceeded'))).toBe(
      'Rate limit exceeded',
    );
    expect(sanitizeError('plain string')).toBe('plain string');
  });
});