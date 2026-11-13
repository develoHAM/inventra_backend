import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { CAN_AUTHENTICATE } from '../auth/auth.constants';
import { OPEN_PROFILE_SELECT } from './company-profile-view';
import type { OpenProfileSummary } from './company-profile-view';

/** Sign-ins (accounts) and which of their company profiles to open. */
@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inside the caller's transaction: a new account for this phone. The
   * insert asks "unless a live account has it" (ON CONFLICT DO NOTHING on
   * UQ_accounts_phone), so two signups with one phone at the same moment
   * give one account. null = taken; the caller decides it means 409.
   */
  async createAccount(
    transaction: Prisma.TransactionClient,
    phone: string | null,
  ): Promise<string | null> {
    const [created] = await transaction.account.createManyAndReturn({
      data: [{ phone: phone }],
      skipDuplicates: true,
      select: { id: true },
    });
    return created?.id ?? null;
  }

  /**
   * Which profile a sign-in opens: the preferred one (the account's last
   * used, or the session's own) if it can still be opened, else the newest
   * one that can, else none. "Can be opened" = this account's, not
   * deleted, ACTIVE or PENDING_APPROVAL.
   */
  async findProfileToOpen(
    accountId: string,
    preferredProfileId: string | null,
  ): Promise<OpenProfileSummary | null> {
    const openable = {
      accountId: accountId,
      deletedAt: null,
      status: { in: [...CAN_AUTHENTICATE] },
    };
    if (preferredProfileId !== null) {
      const preferred = await this.prisma.profile.findFirst({
        where: { id: preferredProfileId, ...openable },
        select: OPEN_PROFILE_SELECT,
      });
      if (preferred) return preferred;
    }
    return this.prisma.profile.findFirst({
      where: openable,
      orderBy: { createdAt: 'desc' },
      select: OPEN_PROFILE_SELECT,
    });
  }
}
