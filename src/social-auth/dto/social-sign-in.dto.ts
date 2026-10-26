import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { SOCIAL_PROVIDERS } from '../verifiers/social-identity-verifier';
import type { SocialProvider } from '../verifiers/social-identity-verifier';

export class SocialSignInDto {
  // Which provider the credential came from: one of ours, or 400.
  @IsIn(SOCIAL_PROVIDERS)
  provider!: SocialProvider;

  // Each provider sends different fields ({ idToken }, { identityToken, … },
  // { accessToken } …); its verifier checks them, so here: just an object.
  @IsObject()
  credential!: Record<string, unknown>;

  // The raw nonce from POST /auth/social/nonce (its SHA-256 went to the SDK).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nonce?: string;
}
