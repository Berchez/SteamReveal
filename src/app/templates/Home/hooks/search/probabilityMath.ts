import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import { cityNameAndScore } from '@/@types/cityNameAndScore';

/**
 * Pure functions extracted from useHome.ts (Phase 0 of the architecture
 * refactor). They are intentionally kept free of side effects: previously,
 * they lived inside async functions that also made API calls and called
 * setState, which made them impossible to test in isolation — every assertion
 * had to go through mocked axios + renderHook + waitFor.
 *
 * Both scoring functions follow the same format ("combining three heuristics"):
 *   - a measure relative to the rest of the result set
 *   - a measure relative to the best entry in the set
 *   - a measure relative to a fixed constant, empirically chosen
 *
 * Then, a weighted average is calculated and converted to a percentage from
 * 0-100. The weights/constants have been preserved exactly as they were —
 * this is a pure extraction, not a behavior change under normal conditions.
 *
 * DOCUMENTED EXCEPTION: in computeCloseFriendsProbability, two cases that
 * previously caused a crash (TypeError) are now handled without errors —
 * see the comment in the function. This is not "identical behavior"; it is
 * a bug fix discovered during the extraction.
 */

const CLOSE_FRIENDS_SAMPLE_SIZE = 5;
const CLOSE_FRIENDS_REASONABLE_COUNT = 50;
const LOCATION_REASONABLE_COUNT = 100;

const clampToOne = (value: number): number => (value > 1 ? 1 : value);

/**
 * Calculates the probability that each close friend is a "real-world"
 * contact (rather than just a random Steam friend), based on how many
 * mutually shared friend-of-friend connections they have with the target.
 *
 * PRECONDITION that the caller must guarantee: `closeFriends` is already
 * sorted in descending order by `count` (the API route already returns it
 * this way). An empty array or an array with fewer than
 * CLOSE_FRIENDS_SAMPLE_SIZE (5) items is now handled without errors — in
 * the original inline version, the code unconditionally accessed
 * closeFriends[0..4].count, assuming that 5+ items were always present,
 * which caused a TypeError when that was not the case.
 *
 * Since the getCloseFriends route now explicitly discards friends whose
 * Steam summary could not be resolved, having fewer than 5 items is an
 * expected and documented case — it is no longer just defensive paranoia.
 */
export function computeCloseFriendsProbability(
  closeFriends: closeFriendsDataIWant[],
): closeFriendsDataIWant[] {
  if (closeFriends.length === 0) {
    return [];
  }

  const sampleSize = Math.min(CLOSE_FRIENDS_SAMPLE_SIZE, closeFriends.length);
  const sampleTotal = closeFriends
    .slice(0, sampleSize)
    .reduce((sum, f) => sum + f.count, 0);
  const sampleMean = sampleTotal / sampleSize;

  const biggestCountValue = closeFriends[0].count;

  return closeFriends.map((f) => {
    const meanProbabilityMethod =
      sampleMean === 0 ? 0 : clampToOne(f.count / (sampleMean * 1.5));

    const biggestCountMethod =
      biggestCountValue === 0 ? 0 : f.count / biggestCountValue;

    const constantMethod = clampToOne(f.count / CLOSE_FRIENDS_REASONABLE_COUNT);

    const probabilityFloat =
      (meanProbabilityMethod * 2 + biggestCountMethod * 2 + constantMethod) / 5;

    return {
      friend: f.friend,
      count: f.count,
      probability: probabilityFloat * 100,
    };
  });
}

/**
 * Aggregates close friends into a "location key -> weighted score" map.
 * A friend only contributes if their Steam profile exposes a city;
 * the weight is multiplied (rather than added) when multiple friends
 * share exactly the same country/state/city combination — a cluster of
 * friends in the same place weighs more than several friends spread across
 * different locations, even when their individual counts are similar.
 */
export function computeCityScores(
  closeFriends: closeFriendsDataIWant[],
): cityNameAndScore {
  const citiesScored: cityNameAndScore = {};

  closeFriends
    .filter((f) => f.friend.cityID !== undefined)
    .forEach((f) => {
      const cityKey = `${f.friend.countryCode}/${f.friend.stateCode}/${f.friend.cityID}`;
      citiesScored[cityKey] = citiesScored[cityKey]
        ? citiesScored[cityKey] * f.count
        : f.count;
    });

  return citiesScored;
}

/**
 * Converts city scores (already resolved with names via getCitiesNames)
 * into a 0-100 probability for each candidate location.
 */
export function computeLocationProbabilities(
  citiesScoredWithNames: Array<{
    location: {
      cityName?: string;
      stateName?: string;
      countryName?: string;
      countryCode?: string;
    };
    count: number;
  }>,
) {
  const totalCountOfScores = citiesScoredWithNames.reduce(
    (sum, c) => sum + c.count,
    0,
  );

  return citiesScoredWithNames.map((c) => {
    const totalCountMethod =
      totalCountOfScores === 0 ? 0 : c.count / totalCountOfScores;

    const constantMethod = clampToOne(c.count / LOCATION_REASONABLE_COUNT);

    const probabilityFloat = (totalCountMethod * 2 + constantMethod) / 3;

    return {
      location: c.location,
      count: c.count,
      probability: probabilityFloat * 100,
    };
  });
}
