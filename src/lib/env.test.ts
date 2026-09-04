import os from 'os';
import path from 'path';
import { loadEnv, parseEnvFile } from './env';

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