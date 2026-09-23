import {
  FRIENDS_LIST_PRIVATE_CODE,
  isPrivateFriendsError,
  visibilityFromCloseFriends,
} from './friendsVisibility';

describe('visibilityFromCloseFriends', () => {
  it('maps a non-empty list to public', () => {
    expect(
      visibilityFromCloseFriends([
        { friend: { steamID: '76561198000000001' }, count: 1 },
      ] as never),
    ).toBe('public');
  });

  it('maps an empty list to empty', () => {
    expect(visibilityFromCloseFriends([])).toBe('empty');
  });

  it('maps undefined to empty (no friends resolved)', () => {
    expect(visibilityFromCloseFriends(undefined)).toBe('empty');
  });
});

describe('isPrivateFriendsError', () => {
  it('matches the real backend shape: 400 + { error: { message, code } }', () => {
    // This mirrors what errorResponse() actually serializes (note `error`
    // is an OBJECT) plus axios' generic message — the production shape the
    // previous string-only matcher silently missed.
    const axiosError = Object.assign(
      new Error('Request failed with status code 400'),
      {
        response: {
          status: 400,
          data: {
            error: {
              message: "Target's friends list is private or inaccessible.",
              code: FRIENDS_LIST_PRIVATE_CODE,
            },
          },
        },
      },
    );
    expect(isPrivateFriendsError(axiosError)).toBe(true);
  });

  it('matches the code even when the copy changes', () => {
    expect(
      isPrivateFriendsError({
        response: {
          status: 400,
          data: {
            error: { message: 'Some future copy', code: 'FRIENDS_LIST_PRIVATE' },
          },
        },
      }),
    ).toBe(true);
  });

  it('falls back to the message pattern for code-less responses', () => {
    expect(
      isPrivateFriendsError(
        new Error("Target's friends list is private or inaccessible."),
      ),
    ).toBe(true);
    expect(
      isPrivateFriendsError({
        response: {
          status: 400,
          data: { error: 'The friend list of this player is not public.' },
        },
      }),
    ).toBe(true);
  });

  it('rejects timeouts, 500s and other statuses even with similar text', () => {
    expect(
      isPrivateFriendsError({
        response: { status: 504, data: { error: 'Steam API timed out' } },
      }),
    ).toBe(false);
    expect(
      isPrivateFriendsError({
        response: {
          status: 500,
          data: {
            error: {
              message: "Target's friends list is private or inaccessible.",
              code: 'FRIENDS_LIST_PRIVATE',
            },
          },
        },
      }),
    ).toBe(false);
    expect(isPrivateFriendsError(new Error('Network Error'))).toBe(false);
  });

  it('rejects other 400 codes that share the route', () => {
    expect(
      isPrivateFriendsError({
        response: {
          status: 400,
          data: { error: { message: 'Invalid target.', code: 'INVALID_REQUEST' } },
        },
      }),
    ).toBe(false);
  });

  it('rejects null, undefined and non-objects without throwing', () => {
    expect(isPrivateFriendsError(null)).toBe(false);
    expect(isPrivateFriendsError(undefined)).toBe(false);
    expect(isPrivateFriendsError('private')).toBe(false);
  });
});
