// The order of this array determines the display order in the grid.
// To add a new site, simply append a new object here;

import { QuickLink } from '@/@types/userQuickLinkType';

const quickLinks: QuickLink[] = [
  {
    id: 'steamid-uk',
    title: 'SteamID.uk',
    icon: '🔍',
    iconUrl: '/images/QuickLinks/steamid.png',
    getUrl: (steamId) =>
      `https://steamid.uk/profile/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'steamdb',
    title: 'SteamDB',
    icon: '🔍',
    iconUrl: '/images/QuickLinks/steamdb.png',
    getUrl: (steamId) =>
      `https://steamdb.info/calculator/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'steamhistory',
    title: 'SteamHistory',
    icon: '📜',
    iconUrl: '/images/QuickLinks/steamhistory.png',
    getUrl: (steamId) =>
      `https://steamhistory.net/id/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'csstats',
    title: 'CSStats',
    icon: '📊',
    iconUrl: '/images/QuickLinks/csstats.jpeg',
    getUrl: (steamId) =>
      `https://csstats.gg/player/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'faceit',
    title: 'Faceit',
    icon: '🎮',
    iconUrl: '/images/QuickLinks/faceit.jpg',
    // Static fallback URL—overridden at runtime by the useFaceitLink hook
    // while the API request is still pending.
    getUrl: (steamId) =>
      `https://faceitfinder.com/profile/${encodeURIComponent(steamId)}`,
    isDynamic: true,
  },
  {
    id: 'csrep',
    title: 'CSRep',
    icon: '📈',
    iconUrl: '/images/QuickLinks/csrep.jpeg',
    getUrl: (steamId) =>
      `https://csrep.gg/player/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'clash-inventory',
    title: 'Inventory',
    icon: '📦',
    iconUrl: '/images/QuickLinks/inventory.png',
    getUrl: (steamId) =>
      `https://inventory.clash.gg/users/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'gamersclub',
    title: 'GamersClub',
    icon: 'GC',
    iconUrl: '/images/QuickLinks/gamersclub.png',
    getUrl: (steamId) =>
      `https://gamersclub.com.br/buscar?busca=${encodeURIComponent(
        `https://steamcommunity.com/profiles/${steamId}/`,
      )}`,
  },
];

export default quickLinks;
