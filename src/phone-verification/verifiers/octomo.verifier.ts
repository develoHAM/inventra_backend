import { Injectable, Logger } from '@nestjs/common';
import { PhoneOwnershipVerifier } from './phone-ownership-verifier';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.schema';
import { OCTOMO_EXISTS_URL } from '../phone-verification.constants';

@Injectable()
export class OctomoPhoneVerifier implements PhoneOwnershipVerifier {
  private readonly logger = new Logger(OctomoPhoneVerifier.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async messageExists(
    mobileNum: string,
    text: string,
    withinMinutes: number,
  ): Promise<boolean> {
    const response = await fetch(OCTOMO_EXISTS_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Octomo ${this.config.get('OCTOMO_API_KEY', { infer: true })}`,
      },
      body: JSON.stringify({
        mobileNum: mobileNum,
        text: text,
        withinMinutes: withinMinutes,
      }),
      signal: AbortSignal.timeout(5000), // a hanging provider must not hang our request
    });

    // fetch only rejects when no response arrives; a 401/429/500 still resolves.
    if (!response.ok) {
      const text = await response.text();
      const octomoError = new Error(
        `OCTOMO responded ${response.status} - ${text}`,
      );

      this.logger.error(octomoError.message, octomoError.stack);

      throw octomoError;
    }

    const body = (await response.json()) as { exists?: unknown };
    return body.exists === true;
  }
}
