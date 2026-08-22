import { NextResponse } from 'next/server';
import axios from 'axios';
import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';

export const revalidate = 0;

const { FACEIT_API_KEY } = process.env;

const STEAM64_ID_REGEX = /^\d{17}$/;

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const steamID = searchParams.get('steamID');

    if (!steamID || !STEAM64_ID_REGEX.test(steamID)) {
      return errorResponse(
        'steamID is required and must be a valid Steam64 ID.',
        400,
        'INVALID_REQUEST',
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
      return errorResponse(
        'Perfil FACEIT não encontrado para esse SteamID',
        404,
        'NOT_FOUND',
      );
    }

    if (response.status >= 400) {
      return errorResponse(
        'Erro ao consultar a API da FACEIT',
        502,
        'UPSTREAM_ERROR',
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
    if (error instanceof SyntaxError) {
      logRouteError('getFaceitLink', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    logRouteError('getFaceitLink', error);
    return errorResponse('Internal server error.', 500, 'INTERNAL_ERROR');
  }
}
