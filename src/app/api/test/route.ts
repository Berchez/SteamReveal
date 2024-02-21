import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';

export const revalidate = 0;

export async function POST(req: Request) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();

      const { target } = body;

      const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

      steam.resolve(target).then((id) => {
        console.log('walter', id);
      });

      return NextResponse.json({ message: 'Deu certo' }, { status: 200 });
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
