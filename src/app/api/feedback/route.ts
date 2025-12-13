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

    if (!type || !['bug', 'suggestion', 'other'].includes(type)) {
      return NextResponse.json(
        { message: 'Invalid feedback type.', type },
        { status: 400 },
      );
    }

    await sendFeedbackEmail({
      message,
      type,
      page: page ?? 'unknown',
      language: language ?? 'unknown',
      userAgent: userAgent ?? 'unknown',
    });

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
