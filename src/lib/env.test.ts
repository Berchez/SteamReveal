import os from 'os';
import path from 'path';
import { loadEnv, parseEnvFile, requireRemoteTursoToken } from './env';

describe('parseEnvFile', () => {
  it('parses key=value pairs and strips surrounding quotes', () => {
    const entries = parseEnvFile('A=1\nB="two"\nC=\'three\'');
    expect(entries).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two' },
      { key: 'C', value: 'three' },
    ]);
  });

  it('ignores blank lines, full-line comments and malformed lines', () => {
    const entries = parseEnvFile(
      '# comment\n\nFOO=bar\n=no-key\n\nNOT-A-TOKEN-WITHOUT-EQUALS',
    );
    expect(entries).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('handles CRLF line endings and trims surrounding whitespace', () => {
    const entries = parseEnvFile('KEY_A =  hello \r\nKEY_B=x');
    expect(entries).toEqual([
      { key: 'KEY_A', value: 'hello' },
      { key: 'KEY_B', value: 'x' },
    ]);
  });

  it('keeps values that contain an equals sign', () => {
    const entries = parseEnvFile('TOKEN=abc=def');
    expect(entries).toEqual([{ key: 'TOKEN', value: 'abc=def' }]);
  });
});

describe('loadEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sets vars from the file and does not overwrite existing ones', () => {
    // Existing var must win (dotenv semantics).
    process.env.ALREADY_SET = 'from-host';

    const fs = jest.requireActual('fs');
    const envPath = path.join(os.tmpdir(), `env-fixture-${Date.now()}.env`);
    fs.writeFileSync(envPath, 'ALREADY_SET=from-file\nNEW_VAR=new-value\n');

    try {
      loadEnv(envPath);
      expect(process.env.ALREADY_SET).toBe('from-host');
      expect(process.env.NEW_VAR).toBe('new-value');
    } finally {
      fs.unlinkSync(envPath);
    }
  });

  it('is a no-op when the file does not exist', () => {
    process.env.SHOULD_STAY = 'x';
    loadEnv(path.join(os.tmpdir(), 'does-not-exist-unique.env'));
    expect(process.env.SHOULD_STAY).toBe('x');
  });
});

describe('requireRemoteTursoToken', () => {
  it('accepts a remote URL with a token', () => {
    expect(
      requireRemoteTursoToken('libsql://demo-org.turso.io', 'token'),
    ).toBeNull();
    expect(
      requireRemoteTursoToken('https://demo-org.turso.io', 'token'),
    ).toBeNull();
  });

  it('rejects remote libsql:// URLs without a token', () => {
    expect(requireRemoteTursoToken('libsql://demo-org.turso.io', undefined)).toBe(
      'DATABASE_TOKEN is required for remote Turso URLs (libsql:// or https://).',
    );
    expect(requireRemoteTursoToken('libsql://demo-org.turso.io', null)).toBe(
      'DATABASE_TOKEN is required for remote Turso URLs (libsql:// or https://).',
    );
  });

  it('rejects remote https:// URLs without a token (same auth path as libsql://)', () => {
    expect(requireRemoteTursoToken('https://demo-org.turso.io', undefined)).toBe(
      'DATABASE_TOKEN is required for remote Turso URLs (libsql:// or https://).',
    );
  });

  it('accepts local file: URLs without a token (no auth needed)', () => {
    expect(requireRemoteTursoToken('file:analytics.db', undefined)).toBeNull();
    expect(requireRemoteTursoToken('file::memory:', null)).toBeNull();
  });

  it('returns null when the URL is missing (callers own that error)', () => {
    expect(requireRemoteTursoToken(undefined, undefined)).toBeNull();
  });
});