// Specifically detects the synchronous TypeError that steamapi@3.0.12
// throws from SteamAPI.resolve() when `target` does not match any
// recognized format (Steam64, Steam2/3 ID, or profile/vanity URL).
// Discovered through manual testing (curl with target="lixo_invalido") —
// without this helper, the error falls into the generic catch block and is
// reported as a 500 INTERNAL_ERROR, when it is actually a client input
// format error (same category as ticket item 1, but originating inside
// the library rather than from our own validation).
//
// Checks the error message instead of comparing class references because
// the library throws a generic native `TypeError`, not a dedicated exported
// error class — there is no stronger way to identify this specific error
// without relying on undocumented library internals..
export default function isSteamResolveFormatError(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'Invalid format';
}
