import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import scrapeGamersClubName from './utils/scrapeGamersClubName';
import recordSearch from './utils/analytics';

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
const PORT = process.env.LOCAL_PROXY_PORT || process.env.PORT || '3001';

app.use(express.json());

// Endpoint: GET /api/gamersclub/:steamId
app.get('/api/gamersclub/:steamId', async (req: Request, res: Response) => {
  const { steamId } = req.params;

  if (!steamId || Array.isArray(steamId)) {
    return res.status(400).json({ error: 'Invalid steamId parameter' });
  }

  try {
    console.log(
      `[Local Proxy] Scraping GamersClub name for Steam ID: ${steamId}`,
    );
    const name = await scrapeGamersClubName(steamId);

    return res.status(200).json({
      steamId,
      name,
    });
  } catch (error) {
    console.error(
      `[Local Proxy] Scraping error for Steam ID ${steamId}:`,
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

// Endpoint: POST /api/analytics/record
// Called by the deployed site (via the same tunnel used for LOCAL_PROXY_URL)
// every time a search finishes. Writes to the local analytics.html — this is why
// it has to live on this local server rather than on Vercel.
app.post('/api/analytics/record', async (req: Request, res: Response) => {
  const { profile, friends } = req.body ?? {};

  if (!profile || !profile.steamId) {
    return res.status(400).json({ error: 'Invalid or missing profile' });
  }

  try {
    await recordSearch({ profile, friends: Array.isArray(friends) ? friends : [] });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[Analytics] Failed to record search:', error);
    let errorMessage = '';
    if (error instanceof Error) {
      errorMessage = error.message;
    } else {
      errorMessage = String(error);
    }
    return res.status(500).json({
      error: 'Failed to record search',
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
    `[Local Proxy] Standalone server running on http://localhost:${PORT}`,
  );
  console.log(
    `[Local Proxy] Endpoint active: GET /api/gamersclub/:steamId`,
  );
  console.log(
    `[Local Proxy] Endpoint active: POST /api/analytics/record`,
  );
});