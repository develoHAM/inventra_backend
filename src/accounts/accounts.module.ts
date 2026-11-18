import { Module } from '@nestjs/common';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { AccountsService } from './accounts.service';
import { AccountCompaniesService } from './account-companies.service';
import { AccountsController } from './accounts.controller';

/**
 * Sign-ins and their company profiles. Imports only the email proofs
 * (joining and creating may spend one; Prisma, Storage and the event
 * emitter are global), so auth and social login can both use it without
 * importing each other. Only AccountsService is exported: joining and
 * creating are reached through /me/companies alone.
 */
@Module({
  imports: [EmailVerificationModule],
  controllers: [AccountsController],
  providers: [AccountsService, AccountCompaniesService],
  exports: [AccountsService],
})
export class AccountsModule {}
