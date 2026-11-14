/**
 * The sign-in a request comes from, as its access token names it. Set on
 * `request.account` for every authenticated request, with or without a
 * company open. `profileId` = the open company profile, or null when none
 * is open (then `request.profile` is undefined too).
 */
export type AuthAccount = {
  accountId: string;
  profileId: string | null;
};
