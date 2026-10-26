/** Injection token for Record<SocialProvider, SocialIdentityVerifier>: this environment's verifiers. */
export const SOCIAL_VERIFIERS = 'SOCIAL_VERIFIERS';

export const NONCE_TTL_SECONDS = 300; // one sign-in: issue → SDK → our endpoint
export const SIGNUP_TICKET_TTL_SECONDS = 900; // time to fill in the signup form
export const TICKET_NAME_MAX_LENGTH = 100; // the ticket's name column
