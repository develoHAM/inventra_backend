import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { CAN_AUTHENTICATE } from '../auth/auth.constants';
import { StorageService } from '../storage/storage.service';
import {
  COMPANY_PROFILE_SELECT,
  OPEN_PROFILE_SELECT,
} from './company-profile-view';
import type {
  CompanyProfileRow,
  CompanyProfileView,
  OpenProfileSummary,
} from './company-profile-view';

/**
 * "Openable": this account's profile, not deleted, ACTIVE or
 * PENDING_APPROVAL. The only profiles a session may open, list or switch to.
 */
function openableProfilesOf(accountId: string) {
  return {
    accountId: accountId,
    deletedAt: null,
    status: { in: [...CAN_AUTHENTICATE] },
  } satisfies Prisma.ProfileWhereInput;
}

/** Sign-ins (accounts) and which of their company profiles to open. */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

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
    if (preferredProfileId !== null) {
      const preferred = await this.findOpenableProfile(
        accountId,
        preferredProfileId,
      );
      if (preferred) return preferred;
    }
    return this.prisma.profile.findFirst({
      where: openableProfilesOf(accountId),
      orderBy: { createdAt: 'desc' },
      select: OPEN_PROFILE_SELECT,
    });
  }

  /**
   * This one profile, if this account may open it; else null (another
   * account's, left, suspended, deleted, or no such id). One query with
   * every rule in the WHERE, so a miss never says WHICH rule failed. The
   * caller decides what null means (switch: 404; refresh: fall back).
   */
  findOpenableProfile(
    accountId: string,
    profileId: string,
  ): Promise<OpenProfileSummary | null> {
    return this.prisma.profile.findFirst({
      where: { id: profileId, ...openableProfilesOf(accountId) },
      select: OPEN_PROFILE_SELECT,
    });
  }

  /** The company dropdown: every profile the account can open, oldest first. */
  async listCompanies(accountId: string): Promise<CompanyProfileView[]> {
    const rows = await this.prisma.profile.findMany({
      where: openableProfilesOf(accountId),
      orderBy: { createdAt: 'asc' },
      select: COMPANY_PROFILE_SELECT,
    });
    return Promise.all(rows.map((row) => this.toCompanyProfileView(row)));
  }

  private async toCompanyProfileView(
    row: CompanyProfileRow,
  ): Promise<CompanyProfileView> {
    return {
      profileId: row.id,
      status: row.status,
      name: row.name,
      // the bucket is private: the stored key becomes a short-lived URL
      profileImageUrl: row.profileImageUrl
        ? await this.storage.presignGetUrl(row.profileImageUrl)
        : null,
      role: row.role,
      company: row.company,
    };
  }
}
