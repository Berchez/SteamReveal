/**
 * @jest-environment node
 *
 * getRequesterDevice/getRequesterCountry's SSR guards (`typeof navigator ===
 * 'undefined'`, `typeof document === 'undefined'`) need an environment
 * where those globals genuinely don't exist. Simulating that inside a
 * jsdom-environment test (by deleting or redefining `global.navigator` /
 * `global.document`) corrupts jsdom's internal Window state and crashes
 * the Jest worker during teardown — see homeAnalyticsUtils.test.ts for the
 * rest of this module's tests, which stay in jsdom since they need a real
 * `document.body` and `navigator.userAgent`.
 *
 * IMPORTANT FINDING: since Node 21, the Node runtime itself exposes a
 * built-in global `navigator` object (used by the Fetch API implementation,
 * with a userAgent like "Node.js/22.16.0"). That means on Node 21+,
 * `typeof navigator === 'undefined'` is FALSE during real SSR — the guard
 * in getRequesterDevice() no longer catches the server case the way it did
 * when this code was written. In practice getRequesterDevice() called on
 * the server now falls through to the regex test against Node's own
 * userAgent and returns 'desktop' instead of null. This test explicitly
 * removes the global to verify the intended behavior, but that condition
 * no longer occurs naturally in this project's actual Node 22 runtime —
 * worth deciding whether this matters for how `device` is used downstream
 * in the analytics payload.
 */
import { getRequesterDevice, getRequesterCountry } from './homeAnalyticsUtils';

describe('homeAnalyticsUtils SSR guards (node environment, no DOM globals)', () => {
  it('getRequesterDevice returns null when navigator does not exist', () => {
    // Node 21+ ships its own global `navigator` (Fetch API), so it must be
    // explicitly removed here to reproduce the "no navigator at all" case
    // the source code's guard was written for. Safe to redefine in a plain
    // node environment — no jsdom Window involved, so no teardown risk.
    const originalNavigator = global.navigator;
    // @ts-expect-error simulating an environment with no navigator at all
    delete global.navigator;

    expect(typeof navigator).toBe('undefined');
    expect(getRequesterDevice()).toBeNull();

    global.navigator = originalNavigator;
  });

  it('getRequesterCountry returns null when document does not exist', () => {
    expect(typeof document).toBe('undefined');
    expect(getRequesterCountry()).toBeNull();
  });
});
