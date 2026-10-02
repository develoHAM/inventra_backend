import { IsUUID } from 'class-validator';

export class ConfirmVerificationDto {
  @IsUUID()
  verificationId!: string;
}
