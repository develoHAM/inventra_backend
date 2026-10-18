export const EMAIL_CODE_TTL_SECONDS = 600; // the code lives 10 minutes
export const MAX_EMAIL_CODE_ATTEMPTS = 5; // wrong guesses allowed per code
export const EMAIL_RESEND_COOLDOWN_SECONDS = 60; // per address: we SEND, so anti-spam
export const DAILY_EMAIL_CODE_LIMIT = 10; // per address, rolling 24 h
export const EMAIL_TOKEN_TTL_SECONDS = 600; // the proof lives 10 minutes

/** Notification eventType for the code email (not a domain event). */
export const EMAIL_VERIFICATION_CODE_EVENT = 'email.verificationCode';
