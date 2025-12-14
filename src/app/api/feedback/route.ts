import { NextResponse } from 'next/server';
import { sendFeedbackEmail } from './utils';

export const revalidate = 0;

type FeedbackType = 'bug' | 'suggestion' | 'other';

type FeedbackBody = {
  message: string;
  type: FeedbackType;
  page?: string;
  language?: string;
  userAgent?: string;
};

const RATE_LIMIT_WINDOW = 120_000; // 2 min
const RATE_LIMIT_MAX = 3;

const rateLimitMap = new Map<
  string,
  { count: number; firstRequestAt: number }
>();

function isRateLimited(ip: string) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry) {
    rateLimitMap.set(ip, { count: 1, firstRequestAt: now });
    return false;
  }

  if (now - entry.firstRequestAt > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, firstRequestAt: now });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as FeedbackBody;
    const { message, type, page, language, userAgent } = body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return NextResponse.json(
        { message: 'Invalid message.' },
        { status: 400 },
      );
    }

    // Limit slightly below UI max to account for multi-byte characters (e.g. emojis)
    if (message.length > 2000) {
      return NextResponse.json(
        { message: 'Message too long.' },
        { status: 413 },
      );
    }

    if (!['bug', 'suggestion', 'other'].includes(type)) {
      return NextResponse.json(
        { message: 'Invalid feedback type.' },
        { status: 400 },
      );
    }

    const ip =
      req.headers.get('x-real-ip') ??
      req.headers.get('x-forwarded-for')?.split(',')[0] ??
      'unknown';

    console.log('ip', {
      ip,
      1: req.headers.get('x-real-ip'),
      '2a': req.headers.get('x-forwarded-for'),
      '2b': req.headers.get('x-forwarded-for')?.split(',')[0],
    });

    if (isRateLimited(ip)) {
      return NextResponse.json(
        { message: 'Too many requests. Try again later.' },
        { status: 429 },
      );
    }

    try {
      await sendFeedbackEmail({
        message,
        type,
        page: page ?? 'unknown',
        language: language ?? 'unknown',
        userAgent: userAgent ?? 'unknown',
      });
    } catch (providerError) {
      console.error('Email provider error:', providerError);

      return NextResponse.json(
        { message: 'Failed to send feedback email.' },
        { status: 502 },
      );
    }

    return NextResponse.json(
      { message: 'Feedback sent successfully.' },
      { status: 200 },
    );
  } catch (error) {
    console.error(
      `feedback - Internal server error: ${(error as Error).message}`,
      error,
    );

    return NextResponse.json(
      { message: 'Internal server error.' },
      { status: 500 },
    );
  }
}
