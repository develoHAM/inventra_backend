import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { MembershipChangeInput } from './membership-change';
import {
  MEMBERSHIP_CHANGE_SELECT,
  toMembershipChangeView,
} from './membership-change-view';
import type { MembershipHistoryPage } from './membership-change-view';
import { DEFAULT_HISTORY_LIMIT } from './dto/history-query.dto';
import type { HistoryQueryDto } from './dto/history-query.dto';

@Injectable()
export class MembershipHistoryService {
  constructor(private readonly prisma: PrismaService) {}

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

  /**
   * One page of history, newest first. The caller has already decided who
   * may read which rows and passes them as `where`; this only fetches.
   */
  async page(
    where: Prisma.MembershipChangeWhereInput,
    query: HistoryQueryDto,
  ): Promise<MembershipHistoryPage> {
    const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;
    const rows = await this.prisma.membershipChange.findMany({
      where: where,
      // Rows written together share a timestamp: the id settles the tie, so
      // the order is the same on every request.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than we show, only to learn whether another page exists.
      take: limit + 1,
      // Start at the bookmarked entry, then step over it.
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: MEMBERSHIP_CHANGE_SELECT,
    });

    const hasMore = rows.length > limit;
    const items = rows
      .slice(0, limit)
      .map((row) => toMembershipChangeView(row));
    return {
      items: items,
      // The last entry shown, not the one we only peeked at.
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }
}
