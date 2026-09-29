/** Answers: did this phone text exactly this text to the receiver number recently? */
export interface PhoneOwnershipVerifier {
  messageExists(
    mobileNum: string,
    text: string,
    withinMinutes: number,
  ): Promise<boolean>;
}
