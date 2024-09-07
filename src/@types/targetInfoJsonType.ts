import { UserSummary } from 'steamapi';

type targetInfoJsonType =
  | {
      profileInfo: UserSummary;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      targetLocationInfo: any;
    }
  | undefined;

export default targetInfoJsonType;
