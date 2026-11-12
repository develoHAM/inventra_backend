import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';

/**
 * Sign-ins and their company profiles. Imports nothing (Prisma is global),
 * so auth and social login can both use it without importing each other.
 */
@Module({
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
