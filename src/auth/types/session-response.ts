import type {
  CompanyProfileView,
  OpenProfileSummary,
} from '../../accounts/company-profile-view';

/**
 * What every sign-in answers (password and social login, refresh, switch):
 * the tokens, the profile the session has open (null = no company open),
 * and every company the account can open, for the app's company dropdown.
 */
export type SessionResponse = {
  accessToken: string;
  refreshToken: string;
  profile: OpenProfileSummary | null;
  companies: CompanyProfileView[];
};
