import { UserSummary } from 'steamapi';

export type closeFriendsDataIWant = {
  friend: UserSummary;
  count: number;
  probability?: number;
};
