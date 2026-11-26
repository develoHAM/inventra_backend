import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { decryptToken } from '../common/token-cipher';
import { SOCIAL_VERIFIERS } from './social-auth.constants';
import { SOCIAL_PROVIDERS } from './verifiers/social-identity-verifier';
import type {
  SocialIdentityVerifier,
  SocialProvider,
} from './verifiers/social-identity-verifier';

/**
 * Asks a social provider to forget us: after an unlink, and for each login
 * of a deleted account. Always after the commit, and never thrown: the
 * login is already gone here, so a provider outage is logged, not reported.
 */
@Injectable()
export class ProviderDisconnectService {
  private readonly logger = new Logger(ProviderDisconnectService.name);
  private readonly encryptionKey: string;

  constructor(
    // the map isn't a class, so Nest finds it by this name (social-auth.module.ts)
    @Inject(SOCIAL_VERIFIERS)
    private readonly verifiers: Record<SocialProvider, SocialIdentityVerifier>,
    config: ConfigService<Env, true>,
  ) {
    // the key the link encrypted the refresh token with
    this.encryptionKey = config.get('LOGIN_TOKEN_ENCRYPTION_KEY', {
      infer: true,
    });
  }

  /** Best-effort: logged, never thrown. A password login has no provider to tell. */
  async disconnectQuietly(login: {
    id: string;
    method: string;
    providerUserId: string | null;
    refreshToken: string | null;
  }): Promise<void> {
    const provider = SOCIAL_PROVIDERS.find((name) => name === login.method);
    if (!provider || login.providerUserId === null) {
      return; // a password login
    }
    try {
      await this.verifiers[provider].disconnect({
        providerUserId: login.providerUserId,
        refreshToken:
          login.refreshToken === null
            ? null
            : decryptToken(login.refreshToken, this.encryptionKey),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not disconnect ${provider} login ${login.id}: ${reason}`,
      );
    }
  }
}
