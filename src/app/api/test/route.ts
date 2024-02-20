import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';

export const revalidate = 0;

export async function GET(req: Request) {
  if (req.method === 'GET') {

    try {
        console.log('walter', process.env.STEAM_API_KEY);
        const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');
        steam.resolve('https://steamcommunity.com/id/DimGG').then(id => {
            console.log('walter', id); // 76561198146931523
        });
        

        return NextResponse.json(
            { message: 'Deu certo' },
            { status: 200 },
        );
    } catch (error) {
      return NextResponse.json(
        { message: 'Erro interno do servidor ' + (error as Error).message },
        { status: 500 },
      );
    }
  } else {
    return NextResponse.json({ message: 'Método não permitido.' });
  }
}