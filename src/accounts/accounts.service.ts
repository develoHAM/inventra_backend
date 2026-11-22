import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { ProfileStatus } from '../generated/prisma/enums';
import { StorageService } from '../storage/storage.service';
import type {
  CompanyProfileRow,
  CompanyProfileView,
  OpenProfileSummary,
} from './company-profile-view';

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
      where: {
        // openable: this account's, not deleted, ACTIVE or PENDING_APPROVAL
        accountId: accountId,
        deletedAt: null,
        status: { in: [ProfileStatus.PENDING_APPROVAL, ProfileStatus.ACTIVE] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, companyId: true, roleId: true },
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
      where: {
        id: profileId,
        // openable: this account's, not deleted, ACTIVE or PENDING_APPROVAL
        accountId: accountId,
        deletedAt: null,
        status: { in: [ProfileStatus.PENDING_APPROVAL, ProfileStatus.ACTIVE] },
      },
      select: { id: true, status: true, companyId: true, roleId: true },
    });
  }

  /** The company dropdown: every profile the account can open, oldest first. */
  async listCompanies(accountId: string): Promise<CompanyProfileView[]> {
    const rows = await this.prisma.profile.findMany({
      where: {
        // openable: this account's, not deleted, ACTIVE or PENDING_APPROVAL
        accountId: accountId,
        deletedAt: null,
        status: { in: [ProfileStatus.PENDING_APPROVAL, ProfileStatus.ACTIVE] },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        name: true,
        profileImageUrl: true,
        role: { select: { code: true, name: true } },
        company: { select: { id: true, name: true } },
      },
    });
    return Promise.all(rows.map((row) => this.toCompanyProfileView(row)));
  }

  /**
   * Is this the platform admin's account (a live ADMIN profile)? The admin
   * runs the platform, so it never joins or creates companies.
   */
  async isPlatformAdmin(accountId: string): Promise<boolean> {
    const adminProfile = await this.prisma.profile.findFirst({
      where: {
        accountId: accountId,
        deletedAt: null,
        role: { code: 'ADMIN' },
      },
      select: { id: true },
    });
    return adminProfile !== null;
  }

  /** One dropdown entry from a CompanyProfileRow (join and create answer with it too). */
  async toCompanyProfileView(
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
