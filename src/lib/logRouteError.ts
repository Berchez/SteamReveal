import getErrorMessage from './getErrorMessage';

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable context]';
  }
}

export default function logRouteError(
  routeName: string,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  const message = getErrorMessage(error);
  const contextSuffix = context
    ? ` It was called with these params: ${safeStringify(context)}`
    : '';

  console.error(
    `${routeName} - Internal server error: ${message}.${contextSuffix}`,
    error,
  );
}
