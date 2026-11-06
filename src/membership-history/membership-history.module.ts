import { Module } from '@nestjs/common';
import { MembershipHistoryService } from './membership-history.service';

/**
 * Its own module with no imports (Prisma is global), so corners, members and
 * companies can all record history without importing each other.
 */
@Module({
  providers: [MembershipHistoryService],
  exports: [MembershipHistoryService],
})
export class MembershipHistoryModule {}
