/**
 * Maximum number of "close friends" the product computes/accepts for a
 * single target.
 *
 * Single source of truth, shared between:
 *  - GET /api/getCloseFriends, which computes this list server-side and
 *    trims it to this many entries (see `closestFriends` there) before
 *    returning it to the client.
 *  - POST /api/getCheaterProbability, which receives that same list back
 *    from the client (see useHome.ts) and caps + validates it rather
 *    than trusting its size blindly (see Ticket 8, and
 *    utils/validateCloseFriends.ts).
 *
 * Change this ONE value if the product should ever consider more/fewer
 * close friends — both endpoints stay in sync automatically instead of
 * needing two hand-edited magic numbers kept in sync by memory.
 */
const MAX_CLOSE_FRIENDS = 20;
export default MAX_CLOSE_FRIENDS;
