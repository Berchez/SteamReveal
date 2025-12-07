function getSteamApiKey() {
  const random = Math.random();
  if (random < 0.5) {
    return process.env.STEAM_API_KEY;
  }
  return process.env.STEAM_API_KEY_2;
}

export default getSteamApiKey;
