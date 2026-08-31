import { cache } from 'react';
import SteamAPI, { UserSummary } from 'steamapi';
import getSteamApiKey from '@/lib/getSteamApiKey';

const steam = new SteamAPI(getSteamApiKey() ?? '');

const getPlayerProfile = cache(
  async (target: string): Promise<UserSummary | undefined> => {
    try {
      const steamId = await steam.resolve(target);
      const profile = await steam.getUserSummary(steamId);
      const resolved = Array.isArray(profile) ? profile[0] : profile;
      // Ensure a plain serializable object is returned to avoid passing class
      // instances from Server -> Client components (Next.js runtime error).
      // JSON round-trip strips prototypes/methods, leaving a plain object.
      return resolved ? JSON.parse(JSON.stringify(resolved)) : undefined;
    } catch {
      return undefined;
    }
  },
);

export default getPlayerProfile;
