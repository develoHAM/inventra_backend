import { Injectable } from '@nestjs/common';
import { PhoneOwnershipVerifier } from './phone-ownership-verifier';

/** e2e stand-in: tests call receive() to play "the user texted the code". */
@Injectable()
export class FakePhoneVerifier implements PhoneOwnershipVerifier {
  private readonly received: { mobileNum: string; text: string }[] = [];

  receive(mobileNum: string, text: string): void {
    this.received.push({ mobileNum: mobileNum, text: text });
  }

  async messageExists(mobileNum: string, text: string): Promise<boolean> {
    return this.received.some(
      (message) => message.mobileNum === mobileNum && message.text === text,
    );
  }
}
