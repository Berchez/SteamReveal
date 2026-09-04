#!/usr/bin/env node
/**
 * GC selector smoke test (canary for the GamersClub scrape selectors).
 *
 * GamersClub has no public API, so `name`, the activity (matches) and `ban`
 * are extracted from HTML markup (`.gc-list-item` / `.gc-list-title` /
 * `.gc-list-text` and the `.alert-danger` alert). If GamersClub changes the
 * HTML, these selectors "break" silently (name/sessions become null, the ban
 * disappears) with no error — and the unit tests stay green because they use
 * fake HTML.
 *
 * This script solves that: it scrapes ONE real GamersClub page live (using the
 * production session cookie) and runs the SAME production extractors, failing
 * (non-zero exit) if any selector fails to match.
 *
 * Usage:
 *   pnpm run smoke:gc
 *
 * Required env vars:
 *   GAMERSCLUB_SESSION_COOKIE  (read from .env if present, like the proxy)
 *   GC_SMOKE_ACTIVE_STEAM_ID   Steam64 of an ACTIVE (non-banned) player
 *
 * Optional env vars:
 *   GC_SMOKE_BANNED_STEAM_ID   Steam64 of a player BANNED on GC (covers the
 *                              ban + reason selectors). If absent, the ban
 *                              check is skipped (does not fail the script).
 *
 * Exit code: 0 = all selectors matched; 1 = some broke (detected markup drift)
 * or the required config is incomplete. NEVER runs in `pnpm test` or pre-commit
 * — it is deliberately manual and depends on a live network + session cookie.
 */
import { loadEnv } from '../src/lib/env';
import { scrapeGamersClubProfile } from '../src/proxy-local/utils/scrapeGamersClubName';

loadEnv();

const STEAM64_ID_REGEX = /^\d{17}$/;

/**
 * Strips surrounding quotes and any trailing human label (e.g. a nickname pasted
 * after the numeric ID) so a sloppy .env value can't silently build a broken
 * GamersClub search URL. Extracts the first run of 17+ digits.
 */
const sanitizeSteamId = (value: string | undefined): string | null => {
  if (!value) return null;
  const match = value.match(/(\d{17,})/);
  if (!match) return null;
  const candidate = match[1];
  return STEAM64_ID_REGEX.test(candidate) ? candidate : null;
};

const rawActiveSteamId = process.env.GC_SMOKE_ACTIVE_STEAM_ID;
const rawBannedSteamId = process.env.GC_SMOKE_BANNED_STEAM_ID;

function validateSteamId(
  value: string | undefined,
  name: string,
  allowEmpty: boolean,
): string | null {
  if (!value) {
    if (!allowEmpty) {
      // eslint-disable-next-line no-console
      console.error(
        `❌ ${name} not set in .env — it is required for the full smoke run.`,
      );
    }
    return null;
  }
  const sanitized = sanitizeSteamId(value);
  if (!sanitized) {
    // eslint-disable-next-line no-console
    console.error(
      `❌ ${name} invalid in .env (expected a 17-digit Steam64 ID): "${value}"`,
    );
    return null;
  }
  return sanitized;
}

let failures = 0;

function report(name: string, ok: boolean, detail: string): void {
  const status = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}: ${detail}`);
}

async function smokeActiveProfile(steamId: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\nChecking ACTIVE player ${steamId} ...`);
  const profile = await scrapeGamersClubProfile(steamId);

  if (!profile) {
    report('profile', false, `scrape returned null (could not resolve the player / network or cookie error)`);
    return;
  }

  report('name', typeof profile.name === 'string' && profile.name.length > 0,
    profile.name ? `extracted name "${profile.name}"` : 'did NOT extract name (.gc-list-title "Nome")');
  report('sessions', typeof profile.sessions === 'number' && profile.sessions > 0,
    profile.sessions != null ? `extracted sessions=${profile.sessions}` : 'did NOT extract activity (.gc-list-item counter)');
  report('not_banned', profile.banned === false,
    profile.banned ? 'flagged as BANNED (expected: active)' : 'ok, not banned');
}

async function smokeBannedProfile(steamId: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\nChecking BANNED player ${steamId} ...`);
  const profile = await scrapeGamersClubProfile(steamId);

  if (!profile) {
    report('banned_profile', false, `scrape returned null (could not resolve the player / network or cookie error)`);
    return;
  }

  report('name', typeof profile.name === 'string' && profile.name.length > 0,
    profile.name ? `extracted name "${profile.name}"` : 'did NOT extract name (.gc-list-title "Nome")');
  report('is_banned', profile.banned === true,
    profile.banned ? 'detected the ban alert (.alert-danger)' : 'did NOT detect ban (.alert-danger)');
  report('banReason', typeof profile.banReason === 'string' && profile.banReason.length > 0,
    profile.banReason ? `extracted reason "${profile.banReason}"` : 'did NOT extract banReason (span.primary-color)');
}

async function main(): Promise<void> {
  if (!process.env.GAMERSCLUB_SESSION_COOKIE) {
    // eslint-disable-next-line no-console
    console.error(
      'GAMERSCLUB_SESSION_COOKIE is missing from .env — required to scrape GC.',
    );
    process.exit(1);
  }

  const validatedActive = validateSteamId(rawActiveSteamId, 'GC_SMOKE_ACTIVE_STEAM_ID', false);
  const validatedBanned = validateSteamId(rawBannedSteamId, 'GC_SMOKE_BANNED_STEAM_ID', true);

  if (!validatedActive) {
    // eslint-disable-next-line no-console
    console.error(
      'Set GC_SMOKE_ACTIVE_STEAM_ID (a plain 17-digit Steam64) in .env and run again.',
    );
    process.exit(1);
  }

  if (validatedActive) {
    try {
      await smokeActiveProfile(validatedActive);
    } catch (err) {
      report('scrape_active_throw', false, err instanceof Error ? err.message : String(err));
    }
  }

  if (validatedBanned) {
    try {
      await smokeBannedProfile(validatedBanned);
    } catch (err) {
      report('scrape_banned_throw', false, err instanceof Error ? err.message : String(err));
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('\nGC_SMOKE_BANNED_STEAM_ID not set or invalid — skipping the ban check (optional).');
  }

  if (failures === 0) {
    // eslint-disable-next-line no-console
    console.log('\n✔ All GC selectors matched the current HTML — no drift detected.');
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.error(`\n✖ ${failures} GC selector(s) BROKE — review the markup in scrapeGamersClubName.ts.`);
    process.exit(1);
  }
}

main();