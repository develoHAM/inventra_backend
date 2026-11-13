import { BadRequestException, Injectable } from '@nestjs/common';
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
        profileId: change.profileId,
        reason: change.reason,
        fromRoleId: change.fromRoleId,
        toRoleId: change.toRoleId,
        fromCompanyStoreId: change.fromCornerId,
        toCompanyStoreId: change.toCornerId,
        changedByProfileId: change.changedByProfileId,
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

    if (query.cursor) {
      // The bookmark must be an entry of this feed: an unknown id would read
      // as "the end", and one from another feed would start at the wrong
      // place. AND keeps both conditions (a spread could overwrite an `id`
      // in `where`). Checking first is safe: history rows never change.
      const bookmark = await this.prisma.membershipChange.findFirst({
        where: { AND: [where, { id: query.cursor }] },
        select: { id: true },
      });
      if (!bookmark)
        throw new BadRequestException('This cursor is not from this history');
    }

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
