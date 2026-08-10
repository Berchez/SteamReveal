import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import scrapeGamersClubName from './utils/scrapeGamersClubName';

/**
 * Custom environment variable loader for standalone execution.
 * Reads the .env file in the workspace root and populates process.env.
 */
function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const lines = envContent.split(/\r?\n/);
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const index = trimmed.indexOf('=');
        if (index > -1) {
          const key = trimmed.slice(0, index).trim();
          let value = trimmed.slice(index + 1).trim();
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
    });
  }
}

// Load environment variables before setting up the server
loadEnv();

const app = express();
const PORT = process.env.GAMERSCLUB_PROXY_PORT || process.env.PORT || '3001';

app.use(express.json());

// Endpoint: GET /api/gamersclub/:steamId
app.get('/api/gamersclub/:steamId', async (req: Request, res: Response) => {
  const { steamId } = req.params;

  if (!steamId || Array.isArray(steamId)) {
    return res.status(400).json({ error: 'Invalid steamId parameter' });
  }

  try {
    console.log(
      `[GamersClub Proxy] Scraping GamersClub name for Steam ID: ${steamId}`,
    );
    const name = await scrapeGamersClubName(steamId);

    return res.status(200).json({
      steamId,
      name,
    });
  } catch (error) {
    console.error(
      `[GamersClub Proxy] Scraping error for Steam ID ${steamId}:`,
      error,
    );
    let errorMessage = '';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else {
      errorMessage = String(error);
    }
    return res.status(500).json({
      error: 'Failed to scrape GamersClub name',
      details: errorMessage,
    });
  }
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(
    `[GamersClub Proxy] Standalone server running on http://localhost:${PORT}`,
  );
  console.log(
    `[GamersClub Proxy] Endpoint active: GET /api/gamersclub/:steamId`,
  );
});
