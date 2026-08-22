import { NextResponse } from 'next/server';

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'UPSTREAM_ERROR'
  | 'RATE_LIMITED'
  | 'METHOD_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export function errorResponse(
  message: string,
  status: number,
  code?: ApiErrorCode,
) {
  return NextResponse.json({ error: { message, code } }, { status });
}
