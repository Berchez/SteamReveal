const clearStat = (stat: string) => {
  const cleaned = stat.replace('ms', '').replace('%', '').trim();

  return cleaned === '' ? undefined : cleaned;
};

export default clearStat;
