export const CODE_TTL_SECONDS = 300; // time to switch to the SMS app and send
export const MAX_CONFIRM_CHECKS = 10; // each check is one OCTOMO API call
export const DAILY_START_LIMIT = 10; // per phone, all purposes, rolling 24 h
export const TOKEN_TTL_SECONDS = 600; // the proof lives 10 minutes

export const OCTOMO_EXISTS_URL =
  'https://api.octoverse.kr/octomo/v1/public/message/exists';
export const OCTOMO_RECEIVER_NUMBER = '1666-3538';

/** Injection token for "whichever phone-ownership verifier this environment uses". */
export const PHONE_VERIFIER = 'PHONE_VERIFIER';
