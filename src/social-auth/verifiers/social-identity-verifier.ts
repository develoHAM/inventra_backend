/** The providers we accept: a runtime list (route checks) and, derived from it, the type. */
export const SOCIAL_PROVIDERS = [
  'kakao',
  'google',
  'facebook',
  'apple',
] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** Who the provider says signed in, once we have checked the provider's proof. */
export interface SocialIdentity {
  provider: SocialProvider;
  providerUserId: string; // the provider's stable id for this person (`sub`)
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  // Apple/Google: what lets us revoke our access later. Plain here; encrypted before storage.
  refreshToken: string | null;
}

/** One per provider: the only code that knows how that provider proves an identity. */
export interface SocialIdentityVerifier {
  /**
   * Check the credential the app got from the provider's SDK and return who it
   * proves. `nonce` is the raw nonce the app sent, for providers that bind one.
   * Throws 401 for a bad credential, 503 when the provider can't be reached.
   */
  verify(
    credential: Record<string, unknown>,
    nonce?: string,
  ): Promise<SocialIdentity>;

  /** Ask the provider to forget our app for this user (unlink, account deletion). */
  disconnect(login: {
    providerUserId: string;
    refreshToken: string | null;
  }): Promise<void>;
}
