/** Wrong invite codes one account may try per window before 429. */
export const JOIN_ATTEMPT_LIMIT = 5;

/** The window JOIN_ATTEMPT_LIMIT counts over: the last hour, rolling. */
export const JOIN_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
