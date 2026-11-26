import { IsNotEmpty, IsString } from 'class-validator';

/** DELETE /me: a fresh proof that the person holds the account's phone. */
export class DeleteAccountDto {
  // from POST /auth/phone/confirm, started with purpose DELETE_ACCOUNT
  @IsString()
  @IsNotEmpty()
  phoneVerificationToken!: string;
}
