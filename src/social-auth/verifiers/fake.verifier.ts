import { Injectable, UnauthorizedException } from '@nestjs/common';
import type {
  SocialIdentity,
  SocialIdentityVerifier,
  SocialProvider,
} from './social-identity-verifier';

/**
 * e2e stand-in for every provider. A test registers a credential token and the
 * identity it proves, then signs in with `{ token }`. Each provider gets its own
 * view (forProvider), so a Kakao token fails on the Google route, as for real.
 */
@Injectable()
export class FakeSocialVerifier {
  private readonly identities = new Map<string, SocialIdentity>();

  /** What disconnect() was asked to do, oldest first (e2e checks unlink with it). */
  readonly disconnected: {
    provider: SocialProvider;
    providerUserId: string;
    refreshToken: string | null;
  }[] = [];

  register(credentialToken: string, identity: SocialIdentity): void {
    this.identities.set(credentialToken, identity);
  }

  forProvider(provider: SocialProvider): SocialIdentityVerifier {
    return {
      verify: async (credential) => {
        const identity =
          typeof credential.token === 'string'
            ? this.identities.get(credential.token)
            : undefined;
        if (!identity || identity.provider !== provider) {
          throw new UnauthorizedException('Invalid social credential');
        }
        return { ...identity };
      },
      disconnect: async (login) => {
        this.disconnected.push({
          provider: provider,
          providerUserId: login.providerUserId,
          refreshToken: login.refreshToken,
        });
      },
    };
  }
}
