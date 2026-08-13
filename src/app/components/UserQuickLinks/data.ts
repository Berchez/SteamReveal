// The order of this array determines the display order in the grid.
// To add a new site, simply append a new object here;

import { QuickLink } from '@/@types/userQuickLinkType';

const quickLinks: QuickLink[] = [
  {
    id: 'steamid-uk',
    title: 'SteamID.uk',
    icon: '🔍',
    iconUrl: 'https://i.imgur.com/qKLLYRC.png',
    getUrl: (steamId) =>
      `https://steamid.uk/profile/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'steamdb',
    title: 'SteamDB',
    icon: '🔍',
    iconUrl: 'https://steamdb.info/static/logos/512px.png',
    getUrl: (steamId) =>
      `https://steamdb.info/calculator/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'steamhistory',
    title: 'SteamHistory',
    icon: '📜',
    iconUrl:
      'https://storage.ko-fi.com/cdn/useruploads/91a12520-96ba-4a53-839e-8b8ae9898ce2_e66bd745-c7b3-489c-b6e5-decb14527111.png',
    getUrl: (steamId) =>
      `https://steamhistory.net/id/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'csstats',
    title: 'CSStats',
    icon: '📊',
    iconUrl: 'https://i.imgur.com/C9IPIKx.jpeg',
    getUrl: (steamId) =>
      `https://csstats.gg/player/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'faceit',
    title: 'Faceit',
    icon: '🎮',
    iconUrl:
      'https://avatars.akamai.steamstatic.com/e74d4f1f7730b917c5a33c492a1112973862bb47_full.jpg',
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
    iconUrl: 'https://i.imgur.com/AW0Vys9.jpeg',
    getUrl: (steamId) =>
      `https://csrep.gg/player/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'clash-inventory',
    title: 'Inventory',
    icon: '📦',
    iconUrl: 'https://i.imgur.com/x31txKn.png',
    getUrl: (steamId) =>
      `https://inventory.clash.gg/users/${encodeURIComponent(steamId)}`,
  },
  {
    id: 'gamersclub',
    title: 'GamersClub',
    icon: 'GC',
    iconUrl: 'https://gamersclub.com.br/favicon.ico',
    getUrl: (steamId) =>
      `https://gamersclub.com.br/buscar?busca=${encodeURIComponent(
        `https://steamcommunity.com/profiles/${steamId}/`,
      )}`,
  },
];

export default quickLinks;
