// Jest-only redirect for the ops-log layer (src/lib/opsLog.ts): route and
// bot code under test calls the REAL writeOpsLog, which resolves its
// directory from OPS_LOG_DIR — point it at a throwaway tmpdir so `pnpm
// test` (and `pnpm run build`, which runs the suite first) never touches
// the repo's real .data/logs.
//
// Runs once per TEST FILE (not per worker), with per-file cleanup below —
// leftovers would otherwise pile up in the OS tmp area on every run.
// .data/ is gitignored anyway, so even a leak could not enter version
// control.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opslog-jest-'));
process.env.OPS_LOG_DIR = dir;

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: leftovers live in the OS tmp area, never in the repo.
  }
});
