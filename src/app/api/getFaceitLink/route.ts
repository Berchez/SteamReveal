import { NextResponse } from 'next/server';
import axios from 'axios';

export const revalidate = 0;

const { FACEIT_API_KEY } = process.env;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const steamID = searchParams.get('steamID');

    if (!steamID || typeof steamID !== 'string') {
      return NextResponse.json(
        { message: 'steamID is required', steamID },
        { status: 400 },
      );
    }

    const url = `https://open.faceit.com/data/v4/players?game=cs2&game_player_id=${encodeURIComponent(steamID)}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${FACEIT_API_KEY ?? ''}`,
      },
      validateStatus: () => true,
      timeout: 5000,
    });

    if (response.status === 404) {
      return NextResponse.json(
        { error: 'Perfil FACEIT não encontrado para esse SteamID' },
        { status: 404 },
      );
    }

    if (response.status >= 400) {
      return NextResponse.json(
        { error: 'Erro ao consultar a API da FACEIT', status: response.status },
        { status: 502 },
      );
    }

    const { data } = response;

    return NextResponse.json(
      {
        faceitLink: data?.faceit_url?.replace('{lang}', 'en'),
        nickname: data?.nickname,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error(
      `getFaceitLink - Internal server Error: ${(error as Error).message}`,
      error,
    );

    return NextResponse.json(
      { message: `Internal server error: ${(error as Error).message}` },
      { status: 500 },
    );
  }
}
