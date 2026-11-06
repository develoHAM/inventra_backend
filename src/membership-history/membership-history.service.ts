import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { MembershipChangeInput } from './membership-change';

@Injectable()
export class MembershipHistoryService {
  /**
   * Append rows inside the caller's transaction, so a change and its
   * history commit or roll back together. Rows are never updated or deleted.
   */
  async record(
    transaction: Prisma.TransactionClient,
    changes: MembershipChangeInput[],
  ): Promise<void> {
    if (changes.length === 0) return;
    await transaction.membershipChange.createMany({
      data: changes.map((change) => ({
        companyId: change.companyId,
        userId: change.userId,
        reason: change.reason,
        fromRoleId: change.fromRoleId,
        toRoleId: change.toRoleId,
        fromCompanyStoreId: change.fromCornerId,
        toCompanyStoreId: change.toCornerId,
        changedByUserId: change.changedByUserId,
      })),
    });
  }
}
