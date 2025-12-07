import getSteamApiKey from '@/lib/getSteamApiKey';
import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';

export const revalidate = 0;

const steam = new SteamAPI(getSteamApiKey() ?? '');

export async function POST(req: Request) {
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();

      const { target } = body;

      if (!target || target === '' || typeof target !== 'string') {
        return NextResponse.json(
          { message: 'Invalid target. ', target },
          { status: 500 },
        );
      }
      const targetSteamId = await steam.resolve(target);

      const targetInfo = await steam.getUserSummary(targetSteamId);

      return NextResponse.json({ targetInfo }, { status: 200 });
    } catch (error) {
      console.error(
        `getUserInfo - Internal server Error: ${(error as Error).message}. It was fetching with these params: ${JSON.stringify(body)}`,
        error,
      );
      return NextResponse.json(
        { message: `Internal server error: ${(error as Error).message}` },
        { status: 500 },
      );
    }
  } else {
    return NextResponse.json({ message: 'Method not allowed.' });
  }
}
