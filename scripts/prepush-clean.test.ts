const {
  parseWindowsListeningPids,
  parseLsofListeningPids,
  isRepoDevServer,
} = require('./prepush-clean.cjs');

describe('parseWindowsListeningPids', () => {
  const NETSTAT = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3100           0.0.0.0:0              LISTENING       15764',
    '  TCP    [::]:3100              [::]:0                 LISTENING       15764',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       10388',
    '  TCP    127.0.0.1:3100         127.0.0.1:51234        TIME_WAIT       0',
    '  TCP    0.0.0.0:31001          0.0.0.0:0              LISTENING       9999',
    '  UDP    0.0.0.0:3100           *:*                                    5555',
  ].join('\n');

  it('finds IPv4 + IPv6 listeners on the exact port', () => {
    expect(parseWindowsListeningPids(NETSTAT, 3100)).toEqual([15764]);
  });

  it('ignores TIME_WAIT, other ports, port-prefixes and UDP', () => {
    expect(parseWindowsListeningPids(NETSTAT, 3000)).toEqual([10388]);
    expect(parseWindowsListeningPids(NETSTAT, 3101)).toEqual([]);
    expect(parseWindowsListeningPids('', 3100)).toEqual([]);
  });
});

describe('parseLsofListeningPids', () => {
  const LSOF = [
    'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node    15764 user   21u  IPv6 0xabc 0t0  TCP *:3100 (LISTEN)',
    'node    10388 user   22u  IPv4 0xdef 0t0  TCP *:3000 (LISTEN)',
  ].join('\n');

  it('finds PIDs from the headerless lsof form', () => {
    // Helper parses rows; the caller scopes by port via -iTCP:<port>.
    expect(parseLsofListeningPids(LSOF)).toEqual([15764, 10388]);
    expect(parseLsofListeningPids('')).toEqual([]);
  });
});

describe('isRepoDevServer', () => {
  it('matches Next dev servers of this repo', () => {
    expect(
      isRepoDevServer(
        '"C:\\Program Files\\nodejs\\node.exe" D:\\GitHub\\OSINT-steam\\node_modules\\.pnpm\\next@14.2.10_...\\node_modules\\next\\dist\\server\\lib\\start-server.js',
      ),
    ).toBe(true);
    expect(
      isRepoDevServer(
        '/repo/OSINT-steam/node_modules/next/dist/bin/next dev -p 3100',
      ),
    ).toBe(true);
  });

  it('rejects bot, proxy, test runners, editors and other projects', () => {
    expect(isRepoDevServer('')).toBe(false);
    expect(isRepoDevServer(null)).toBe(false);
    expect(
      isRepoDevServer(
        'node D:\\GitHub\\OSINT-steam\\node_modules\\.bin\\ts-node src/bot-steam/index.ts',
      ),
    ).toBe(false);
    expect(isRepoDevServer('node src/proxy-local/server.ts')).toBe(false);
    expect(
      isRepoDevServer(
        '/home/u/OSINT-steam/node_modules/.bin/jest --runTestsByPath x',
      ),
    ).toBe(false);
    expect(
      isRepoDevServer(
        'C:\\other-project\\node_modules\\next\\dist\\server\\lib\\start-server.js',
      ),
    ).toBe(false);
    expect(
      isRepoDevServer('cloudflared tunnel --url http://localhost:3001'),
    ).toBe(false);
  });
});
