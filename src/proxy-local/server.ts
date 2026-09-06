import express, { Request, Response } from 'express';
import { loadEnv } from '../lib/env';
import { sanitizeError } from '../lib/sanitizeError';
import scrapeGamersClubName, {
  scrapeGamersClubBan,
} from './utils/scrapeGamersClubName';

// Load environment variables before setting up the server. loadEnv() follows
// dotenv semantics: a var already present in the process (shell/CI export)
// is NEVER overwritten by .env, so host-provided values win over the file.
loadEnv();

const app = express();
const PORT = process.env.LOCAL_PROXY_PORT || process.env.PORT || '3001';

app.use(express.json());

// Endpoint: GET /api/gamersclub/:steamId
app.get('/api/gamersclub/:steamId', async (req: Request, res: Response) => {
  const { steamId } = req.params;
  const allowScrape = req.query.allowScrape !== 'false';

  if (!steamId || Array.isArray(steamId)) {
    return res.status(400).json({ error: 'Invalid steamId parameter' });
  }

  try {
    console.log(
      `[Local Proxy] Fetching GamersClub status for Steam ID: ${steamId} (allowScrape: ${allowScrape})`,
    );

    let name: string | null = null;
    let banned = false;
    let banReason: string | null = null;
    let sessions: number | null = null;

    // The cheater-report flow passes includeBan=true so it always gets a fresh
    // profile scrape with the punishment status. That single scrape drives both
    // the name and the ban — running scrapeGamersClubName separately would do a
    // second full search+profile fetch on GamersClub per request (doubling
    // latency, load on the target site, and our own rate-limit exposure).
    const includeBan = req.query.includeBan === 'true';

    if (includeBan) {
      const banProfile = await scrapeGamersClubBan(steamId);
      name = banProfile.name;
      banned = banProfile.banned;
      banReason = banProfile.banReason;
      sessions = banProfile.sessions;
    } else {
      name = await scrapeGamersClubName(steamId, allowScrape);
    }

    return res.status(200).json({
      steamId,
      name,
      banned,
      banReason,
      sessions,
    });
  } catch (error) {
    console.error(
      `[Local Proxy] Scraping error for Steam ID ${steamId}:`,
      error,
    );
    return res.status(500).json({
      error: 'Failed to scrape GamersClub name',
      details: sanitizeError(error),
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
  console.log(`[Local Proxy] Endpoint active: GET /api/gamersclub/:steamId`);
});
