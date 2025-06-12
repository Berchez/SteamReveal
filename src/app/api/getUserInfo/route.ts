import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';

export const revalidate = 0;

const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

export async function POST(req: Request) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();

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
      return NextResponse.json(
        { message: `Internal server error: ${(error as Error).message}` },
        { status: 500 },
      );
    }
  } else {
    return NextResponse.json({ message: 'Method not allowed.' });
  }
}
