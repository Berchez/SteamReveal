import { UserSummary } from 'steamapi';

type targetInfoJsonType =
  | {
      profileInfo: UserSummary;
      targetLocationInfo: any;
    }
  | undefined;

export default targetInfoJsonType;
