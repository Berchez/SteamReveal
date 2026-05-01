function getSteamApiKey() {
  const key1 = process.env.STEAM_API_KEY;
  const key2 = process.env.STEAM_API_KEY_2;

  if (key1 && key2) {
    return Math.random() < 0.5 ? key1 : key2;
  }

  return key1 || key2;
}

export default getSteamApiKey;
