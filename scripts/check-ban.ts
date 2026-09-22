import { loadEnv } from '../src/lib/env';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchWithTimeout } = require('./smoke-timeout.cjs');

// Read-only Ban Reveal verdict probe (Via A): asks Steam's GetPlayerBans
// for the given IDs and prints VAC/game-ban verdicts. Makes ZERO writes
// (one batched HTTPS GET, no DB, no outbox, no subscriptions) — safe to
// run against any key, including production.
//
// Usage:
//   pnpm exec ts-node -O "{\"module\": \"commonjs\"}" scripts/check-ban.ts <steamId64> [...]
//
// Exit 0 always carries a verdict table (banned/clean/unknown per id);
// exit 1 only for usage/env failures. A "banned" row here is the live
// proof the sweep's parse path (parseBanVerdict) detects real bans.

const FETCH_TIMEOUT_MS = 25_000;

loadEnv();

const key =
  process.env.STEAM_BAN_CHECK_API_KEY ||
  process.env.STEAM_API_KEY ||
  process.env.STEAM_API_KEY_2;

const ids = process.argv.slice(2).filter((id) => /^\d{17}$/.test(id));

if (ids.length === 0) {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: check-ban.ts <steamId64> [...] (17-digit ids only)',
  );
  process.exit(1);
}

if (!key) {
  // eslint-disable-next-line no-console
  console.log(
    'CHECK-BAN SKIPPED: no Steam key (STEAM_BAN_CHECK_API_KEY/STEAM_API_KEY) set',
  );
  process.exit(0);
}

type BanRow = {
  steamID?: unknown;
  vacBans?: unknown;
  gameBans?: unknown;
  NumberOfVACBans?: unknown;
  NumberOfGameBans?: unknown;
};

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const parseVerdict = (ban: unknown): string => {
  if (!ban || typeof ban !== 'object') return 'unknown (malformed row)';
  const row = ban as BanRow;
  // Accept both the steamapi lib shape (vacBans) and raw Steam JSON
  // (NumberOfVACBans) — same scope rule as parseBanVerdict in banCheck.ts.
  const vac = num(row.vacBans ?? row.NumberOfVACBans);
  const game = num(row.gameBans ?? row.NumberOfGameBans);
  if (vac === null || game === null) return 'unknown (absent fields)';
  return vac > 0 || game > 0 ? 'BANNED' : 'clean';
};

const main = async (): Promise<void> => {
  // Never log the key (repo rule: secrets never reach stdout/logs).
  const url =
    `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/` +
    `?key=${encodeURIComponent(key as string)}` +
    `&steamids=${ids.map(encodeURIComponent).join(',')}`;
  const res = await fetchWithTimeout(url, undefined, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`Steam answered HTTP ${res.status}`);
  }
  const body = (await res.json()) as { players?: unknown };
  const players = Array.isArray(body.players) ? body.players : [];
  // Raw Steam JSON keys its id as `SteamId`; the steamapi lib normalizes
  // to `steamID` (see User.js) — accept all casings here so this probe
  // works against either shape.
  const idOf = (p: unknown): string =>
    String(
      (p as Record<string, unknown>).steamID ??
        (p as Record<string, unknown>).SteamId ??
        (p as Record<string, unknown>).steamid ??
        '',
    );
  const byId = new Map(players.map((p) => [idOf(p), p as BanRow]));
  ids.forEach((id) => {
    const row = byId.get(id) as BanRow | undefined;
    const vacRaw = row?.vacBans ?? row?.NumberOfVACBans ?? '?';
    const gameRaw = row?.gameBans ?? row?.NumberOfGameBans ?? '?';
    // eslint-disable-next-line no-console
    console.log(
      `${id}: ${row ? parseVerdict(row) : 'unknown (absent from response)'}` +
        ` (vacBans=${String(vacRaw)}, gameBans=${String(gameRaw)})`,
    );
  });
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    `CHECK-BAN FAIL: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});
