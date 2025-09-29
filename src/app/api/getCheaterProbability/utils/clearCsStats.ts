const clearStat = (stat: string) => {
  const cleaned = stat.replace('ms', '').replace('%', '').trim();

  return cleaned === '' ? '-1' : cleaned;
};

export default clearStat;
