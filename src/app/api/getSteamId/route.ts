import getSteamApiKey from '@/lib/getSteamApiKey';
import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';

export const revalidate = 0;

const steam = new SteamAPI(getSteamApiKey() ?? '');

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const target = searchParams.get('target');

    if (!target || typeof target !== 'string') {
      return NextResponse.json(
        { message: 'Invalid target.', target },
        { status: 400 },
      );
    }

    const targetSteamId = await steam.resolve(target);

    return NextResponse.json({ steamId: targetSteamId }, { status: 200 });
  } catch (error) {
    console.error(
      `getSteamId - Internal server Error: ${(error as Error).message}`,
      error,
    );

    return NextResponse.json(
      { message: `Internal server error: ${(error as Error).message}` },
      { status: 500 },
    );
  }
}
