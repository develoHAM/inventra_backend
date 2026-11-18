import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { ProfileStatus } from '../generated/prisma/enums';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import { generateUniqueJoinCode } from '../companies/join-code';
import { NotificationEvent } from '../notifications/notification-events';
import type {
  CompanyRegisteredEvent,
  MemberJoinRequestedEvent,
} from '../notifications/notification-events';
import type { AuthAccount } from '../auth/types/auth-account';
import { AccountsService } from './accounts.service';
import { COMPANY_PROFILE_SELECT } from './company-profile-view';
import type { CompanyProfileView } from './company-profile-view';
import {
  JOIN_ATTEMPT_LIMIT,
  JOIN_ATTEMPT_WINDOW_MS,
} from './accounts.constants';
import { JoinCompanyDto } from './dto/join-company.dto';
import { CreateCompanyDto } from './dto/create-company.dto';
import { ContactEmailProofDto } from './dto/contact-email-proof.dto';

/** A signed-in account joins or creates companies (each a new profile). */
@Injectable()
export class AccountCompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly emailVerification: EmailVerificationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Ask to join the company whose invite code this is: a PENDING_APPROVAL
   * profile with no role and no branch, approved as today (admin, owner, or
   * a manager into their own branch). With a proven contact email, the
   * approval email can reach it straight away.
   */
  async join(
    account: AuthAccount,
    dto: JoinCompanyDto,
  ): Promise<CompanyProfileView> {
    const { accountId } = account;
    await this.refuseThePlatformAdmin(accountId);

    // ① The guessing brake. Checked before the code is looked at, so a
    // blocked account learns nothing, not even that this code was right.
    const recentFailures = await this.prisma.companyJoinAttempt.count({
      where: {
        accountId: accountId,
        createdAt: { gte: new Date(Date.now() - JOIN_ATTEMPT_WINDOW_MS) },
      },
    });
    if (recentFailures >= JOIN_ATTEMPT_LIMIT) {
      throw new HttpException(
        'Too many invite code attempts; try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // ② The code. A wrong one must leave its row behind, so no transaction
    // here: a throw inside one would roll the row back with it.
    const company = await this.prisma.company.findFirst({
      where: { joinCode: dto.joinCode, deletedAt: null },
      select: { id: true },
    });
    if (!company) {
      await this.prisma.companyJoinAttempt.create({
        data: { accountId: accountId },
      });
      throw new NotFoundException('Invalid join code');
    }

    // ③ The proof (if sent) and the profile, together: only now does a
    // transaction start, after the 404 above has saved its attempt row.
    const profile = await this.prisma.$transaction(async (transaction) => {
      const contactEmail = await this.spendContactEmailProof(transaction, dto);
      // One current profile per account per company: the partial unique
      // index UQ_profiles_account_company decides, even for two joins at once.
      const [inserted] = await transaction.profile.createManyAndReturn({
        data: [
          {
            accountId: accountId,
            companyId: company.id,
            name: dto.name,
            status: ProfileStatus.PENDING_APPROVAL,
            roleId: null, // the approver gives the role (and the branch)
            contactEmail: contactEmail,
          },
        ],
        skipDuplicates: true,
        select: COMPANY_PROFILE_SELECT,
      });
      if (!inserted) {
        // thrown inside, so a proof sent with a refused join stays unspent
        throw new ConflictException(
          'You already belong to or are waiting for this company',
        );
      }
      return inserted;
    });

    const joinRequested: MemberJoinRequestedEvent = {
      companyId: company.id,
      memberProfileId: profile.id,
    };
    this.eventEmitter.emit(
      NotificationEvent.MEMBER_JOIN_REQUESTED,
      joinRequested,
    );

    return this.accounts.toCompanyProfileView(profile);
  }

  /**
   * Register a new company with this account as its PENDING_APPROVAL owner;
   * the platform admin approves it (PATCH /companies/:id/approve). At most
   * one company waiting for approval per account. With a proven contact
   * email, the company-approved email reaches the owner.
   */
  async create(
    account: AuthAccount,
    dto: CreateCompanyDto,
  ): Promise<CompanyProfileView> {
    const { accountId } = account;
    await this.refuseThePlatformAdmin(accountId);

    // Read before the transaction: neither changes while it runs.
    const ownerRole = await this.prisma.role.findUniqueOrThrow({
      where: { code: 'OWNER' },
      select: { id: true },
    });
    const joinCode = await generateUniqueJoinCode(this.prisma);

    const { profile, companyId } = await this.prisma.$transaction(
      async (transaction) => {
        // ① Lock this account's row by writing it, THEN count. Of two
        // creates at once, the second waits here until the first commits;
        // its count then sees the first's waiting company → 409.
        await transaction.account.updateMany({
          where: { id: accountId },
          data: { updatedAt: new Date() },
        });
        const waiting = await transaction.profile.count({
          where: {
            accountId: accountId,
            deletedAt: null,
            status: ProfileStatus.PENDING_APPROVAL,
            role: { code: 'OWNER' },
          },
        });
        if (waiting > 0) {
          throw new ConflictException(
            'You already have a company waiting for approval',
          );
        }

        // ② The proof (if sent), then the owner profile first (the company
        // row names its creator)…
        const contactEmail = await this.spendContactEmailProof(
          transaction,
          dto,
        );
        const owner = await transaction.profile.create({
          data: {
            accountId: accountId,
            name: dto.ownerName,
            companyId: null,
            roleId: ownerRole.id,
            status: ProfileStatus.PENDING_APPROVAL,
            contactEmail: contactEmail,
          },
          select: { id: true },
        });

        // …then the company. A taken tax ID inserts nothing; the throw rolls
        // the owner profile back with it. (A join-code clash would too, but
        // the code was just checked free, and the unique index backstops it.)
        const [company] = await transaction.company.createManyAndReturn({
          data: [
            {
              name: dto.companyName,
              taxId: dto.taxId,
              joinCode: joinCode,
              createdByProfileId: owner.id,
            },
          ],
          skipDuplicates: true,
          select: { id: true },
        });
        if (!company) {
          throw new ConflictException('Tax ID already registered');
        }

        // ③ Close the loop: the owner profile now belongs to its company.
        const ownerProfile = await transaction.profile.update({
          where: { id: owner.id },
          data: { companyId: company.id },
          select: COMPANY_PROFILE_SELECT,
        });
        return { profile: ownerProfile, companyId: company.id };
      },
    );

    // After the commit: never announce a company that rolled back.
    const registered: CompanyRegisteredEvent = { companyId: companyId };
    this.eventEmitter.emit(NotificationEvent.COMPANY_REGISTERED, registered);

    return this.accounts.toCompanyProfileView(profile);
  }

  /**
   * Inside the caller's transaction: spend the contact-email proof, if one
   * was sent, and return the address to store (null = none sent). The DTO
   * guarantees both fields or neither. A bad, used or expired proof (or one
   * issued for another address) throws 400, rolling the transaction back.
   */
  private async spendContactEmailProof(
    transaction: Prisma.TransactionClient,
    dto: ContactEmailProofDto,
  ): Promise<string | null> {
    if (
      dto.contactEmail === undefined ||
      dto.emailVerificationToken === undefined
    ) {
      return null;
    }
    await this.emailVerification.consume(transaction, {
      token: dto.emailVerificationToken,
      email: dto.contactEmail,
    });
    return dto.contactEmail;
  }

  /** The platform admin runs the platform; it never joins or owns a company. */
  private async refuseThePlatformAdmin(accountId: string): Promise<void> {
    if (await this.accounts.isPlatformAdmin(accountId)) {
      throw new ForbiddenException(
        'The platform admin cannot join or create companies',
      );
    }
  }
}
