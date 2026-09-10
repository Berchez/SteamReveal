/**
 * Watch lifecycle states — single source of truth shared by the API
 * contract (`GET /api/watch/status`) and the frontend polling hook.
 * 'none' covers never-requested AND opted-out/deactivated: both mean "no
 * watch", and the distinction is internal state the API never exposes.
 */
export type WatchStatusValue = 'pending' | 'active' | 'none';
