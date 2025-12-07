export function getSteamApiKey() {
  const random = Math.random();
  if (random < 0.5) {
    return process.env.STEAM_API_KEY;
  } else {
    return process.env.STEAM_API_KEY_2;
  }
}
