import getErrorMessage from './getErrorMessage';
import { truncateString, writeOpsLog } from './opsLog';

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable context]';
  }
}

/** Stack budget per file line (stacks can be huge; the console keeps all). */
const STACK_CONTEXT_CHARS = 2000;

export default function logRouteError(
  routeName: string,
  error: unknown,
  // `stack` is reserved: the file log injects the error's own stack under
  // that key, so a caller-supplied one would collide silently. The `never`
  // makes it a compile-time error instead of a convention comment.
  context?: Record<string, unknown> & { stack?: never },
): void {
  const message = getErrorMessage(error);
  const contextSuffix = context
    ? ` It was called with these params: ${safeStringify(context)}`
    : '';

  console.error(
    `${routeName} - Internal server error: ${message}.${contextSuffix}`,
    error,
  );
  // Durable side of the same event (bug-capture net): the console line
  // above is byte-identical to before. writeOpsLog sanitizes AGAIN at the
  // persistence boundary on purpose — a grep over the call sites showed
  // ~30 of them pass RAW errors here (getUserInfo, getSteamId,
  // getCloseFriends, ...), so "already sanitized upstream" does not hold
  // repo-wide, and re-sanitizing converges. Never throws: a failed write
  // degrades to the console line above. The file also carries the
  // sanitized, truncated stack — a message alone rarely diagnoses a
  // next-morning incident; the console keeps the full error object.
  const stack =
    error instanceof Error && typeof error.stack === 'string'
      ? truncateString(error.stack, STACK_CONTEXT_CHARS)
      : undefined;
  // Ours wins on a `stack` key by design (a caller-supplied stack would
  // shadow the real one — worse for diagnosis). Verified: no current call
  // site passes a `stack` key (contexts are steamId/body/target/type/page).
  writeOpsLog('site', 'error', `${routeName}: ${message}`, {
    ...(context ?? {}),
    ...(stack === undefined ? {} : { stack }),
  });
}
