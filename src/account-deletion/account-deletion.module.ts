import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { PhoneVerificationModule } from '../phone-verification/phone-verification.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { SocialAuthModule } from '../social-auth/social-auth.module';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';

/**
 * DELETE /me. Its own small module because deletion needs four others: the
 * phone proof, the provider disconnect, the leave procedure and the admin
 * check. Inside AccountsModule it would be an import cycle (SocialAuthModule
 * already imports AccountsModule). Nothing imports this module, so it can't
 * be part of a cycle.
 */
@Module({
  imports: [
    PhoneVerificationModule, // PhoneVerificationService.consume
    SocialAuthModule, // ProviderDisconnectService
    ProfilesModule, // LeavingService.leaveInTransaction
    AccountsModule, // AccountsService.isPlatformAdmin
  ],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService],
})
export class AccountDeletionModule {}
