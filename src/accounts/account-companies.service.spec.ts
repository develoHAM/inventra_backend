import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { AccountCompaniesService } from './account-companies.service';
import {
  JOIN_ATTEMPT_LIMIT,
  JOIN_ATTEMPT_WINDOW_MS,
} from './accounts.constants';
import { NotificationEvent } from '../notifications/notification-events';
import { ProfileStatus } from '../generated/prisma/enums';
import type { AuthAccount } from '../auth/types/auth-account';

describe('AccountCompaniesService', () => {
  let service: AccountCompaniesService;
  let prisma: {
    companyJoinAttempt: { count: jest.Mock; create: jest.Mock };
    company: { findFirst: jest.Mock; findUnique: jest.Mock };
    role: { findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };
  let transaction: {
    account: { updateMany: jest.Mock };
    profile: {
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      createManyAndReturn: jest.Mock;
    };
    company: { createManyAndReturn: jest.Mock };
  };
  let accounts: { isPlatformAdmin: jest.Mock; toCompanyProfileView: jest.Mock };
  let emailVerification: { consume: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  // a fresh sign-in: no company open yet
  const account: AuthAccount = { accountId: 'account-1', profileId: null };
  const NOW = new Date('2026-11-15T12:00:00.000Z').getTime();

  /** A profile row as the company-dropdown select returns it. */
  const profileRow = (changes: Record<string, unknown> = {}) => ({
    id: 'profile-new',
    status: ProfileStatus.PENDING_APPROVAL,
    name: 'Sam',
    profileImageUrl: null,
    role: null,
    company: { id: 'company-1', name: 'Acme' },
    ...changes,
  });

  /** The HttpException a call rejects with (to read its status). */
  const rejectionOf = (call: Promise<unknown>) =>
    call.then(
      () => {
        throw new Error('expected a rejection');
      },
      (error: unknown) => error as HttpException,
    );

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);

    transaction = {
      account: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      profile: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'profile-new' }),
        update: jest.fn().mockResolvedValue(
          profileRow({
            name: 'Owner Kim',
            role: { code: 'OWNER', name: 'Owner' },
            company: { id: 'company-new', name: 'New Co' },
          }),
        ),
        createManyAndReturn: jest.fn().mockResolvedValue([profileRow()]),
      },
      company: {
        createManyAndReturn: jest
          .fn()
          .mockResolvedValue([{ id: 'company-new' }]),
      },
    };
    prisma = {
      companyJoinAttempt: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
      },
      company: {
        findFirst: jest.fn().mockResolvedValue({ id: 'company-1' }),
        findUnique: jest.fn().mockResolvedValue(null), // join-code draws: free
      },
      role: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 2 }) },
      $transaction: jest.fn((work: (client: unknown) => unknown) =>
        work(transaction),
      ),
    };
    accounts = {
      isPlatformAdmin: jest.fn().mockResolvedValue(false),
      toCompanyProfileView: jest.fn((row: { id: string }) =>
        Promise.resolve({ profileId: row.id, view: true }),
      ),
    };
    emailVerification = { consume: jest.fn().mockResolvedValue(undefined) };
    eventEmitter = { emit: jest.fn() };

    service = new AccountCompaniesService(
      prisma as any,
      accounts as any,
      emailVerification as any,
      eventEmitter as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('join', () => {
    const dto = { joinCode: '48291307', name: 'Sam' };

    it('the platform admin → 403, and nothing is looked up or written', async () => {
      accounts.isPlatformAdmin.mockResolvedValue(true);

      await expect(service.join(account, dto)).rejects.toThrow(
        new ForbiddenException(
          'The platform admin cannot join or create companies',
        ),
      );
      expect(accounts.isPlatformAdmin).toHaveBeenCalledWith('account-1');
      expect(prisma.companyJoinAttempt.count).not.toHaveBeenCalled();
      expect(prisma.company.findFirst).not.toHaveBeenCalled();
      expect(transaction.profile.createManyAndReturn).not.toHaveBeenCalled();
    });

    it("counts this account's failed attempts in the last hour (a rolling window)", async () => {
      await service.join(account, dto);

      expect(prisma.companyJoinAttempt.count).toHaveBeenCalledWith({
        where: {
          accountId: 'account-1',
          createdAt: { gte: new Date(NOW - JOIN_ATTEMPT_WINDOW_MS) },
        },
      });
      expect(JOIN_ATTEMPT_WINDOW_MS).toBe(60 * 60 * 1000);
    });

    it('5 failures in the window → 429, and the code is never looked up (a blocked account learns nothing)', async () => {
      expect(JOIN_ATTEMPT_LIMIT).toBe(5);
      prisma.companyJoinAttempt.count.mockResolvedValue(5);

      const error = await rejectionOf(service.join(account, dto));

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(error.message).toBe(
        'Too many invite code attempts; try again later',
      );
      expect(prisma.company.findFirst).not.toHaveBeenCalled();
      expect(prisma.companyJoinAttempt.create).not.toHaveBeenCalled();
    });

    it('4 failures → still allowed to try', async () => {
      prisma.companyJoinAttempt.count.mockResolvedValue(4);

      await service.join(account, dto);

      expect(prisma.company.findFirst).toHaveBeenCalled();
    });

    it('looks the code up among live companies only', async () => {
      await service.join(account, dto);

      expect(prisma.company.findFirst).toHaveBeenCalledWith({
        where: { joinCode: '48291307', deletedAt: null },
        select: { id: true },
      });
    });

    it("an unknown (or deleted company's) code → records a failed attempt, then 404", async () => {
      prisma.company.findFirst.mockResolvedValue(null);

      await expect(service.join(account, dto)).rejects.toThrow(
        new NotFoundException('Invalid join code'),
      );
      expect(prisma.companyJoinAttempt.create).toHaveBeenCalledWith({
        data: { accountId: 'account-1' },
      });
      expect(transaction.profile.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('…with no transaction: a throw inside one would roll the attempt row back', async () => {
      prisma.company.findFirst.mockResolvedValue(null);

      await expect(service.join(account, dto)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a correct code records no attempt', async () => {
      await service.join(account, dto);

      expect(prisma.companyJoinAttempt.create).not.toHaveBeenCalled();
    });

    it('inserts a waiting profile with no role, letting the partial unique index refuse a second one', async () => {
      await service.join(account, dto);

      expect(transaction.profile.createManyAndReturn).toHaveBeenCalledWith({
        data: [
          {
            accountId: 'account-1',
            companyId: 'company-1',
            name: 'Sam',
            status: ProfileStatus.PENDING_APPROVAL,
            roleId: null,
            contactEmail: null, // no proof sent: set later, or never
          },
        ],
        skipDuplicates: true,
        select: {
          id: true,
          status: true,
          name: true,
          profileImageUrl: true,
          role: { select: { code: true, name: true } },
          company: { select: { id: true, name: true } },
        },
      });
    });

    it('already pending or a member there (nothing inserted) → 409, no event, no attempt recorded', async () => {
      transaction.profile.createManyAndReturn.mockResolvedValue([]);

      await expect(service.join(account, dto)).rejects.toThrow(
        new ConflictException(
          'You already belong to or are waiting for this company',
        ),
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(prisma.companyJoinAttempt.create).not.toHaveBeenCalled();
    });

    it('…and that 409 is thrown INSIDE the transaction, so a proof sent with it is not wasted', async () => {
      transaction.profile.createManyAndReturn.mockResolvedValue([]);

      await expect(service.join(account, dto)).rejects.toThrow(
        ConflictException,
      );
      await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
        ConflictException,
      );
    });

    it('the profile is inserted on the transaction (after the code lookup, which stays outside)', async () => {
      await service.join(account, dto);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.company.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.$transaction.mock.invocationCallOrder[0],
      );
    });

    describe('with a proven contact email (contactEmail + emailVerificationToken)', () => {
      const withProof = {
        ...dto,
        contactEmail: 'sam@acme.com',
        emailVerificationToken: 'email-token',
      };

      it('spends the proof for that address on the transaction, BEFORE the insert', async () => {
        await service.join(account, withProof);

        expect(emailVerification.consume).toHaveBeenCalledWith(transaction, {
          token: 'email-token',
          email: 'sam@acme.com',
        });
        expect(
          emailVerification.consume.mock.invocationCallOrder[0],
        ).toBeLessThan(
          transaction.profile.createManyAndReturn.mock.invocationCallOrder[0],
        );
      });

      it('the new profile gets that contact email', async () => {
        await service.join(account, withProof);

        expect(
          transaction.profile.createManyAndReturn.mock.calls[0][0].data,
        ).toEqual([expect.objectContaining({ contactEmail: 'sam@acme.com' })]);
      });

      it('a bad, used or expired proof → 400: no profile, no event, and not counted as a guessed code', async () => {
        emailVerification.consume.mockRejectedValue(
          new BadRequestException('Invalid or expired email verification'),
        );

        await expect(service.join(account, withProof)).rejects.toThrow(
          new BadRequestException('Invalid or expired email verification'),
        );
        expect(transaction.profile.createManyAndReturn).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        expect(prisma.companyJoinAttempt.create).not.toHaveBeenCalled();
      });

      it('a wrong code → 404 before the proof is touched (it stays unspent)', async () => {
        prisma.company.findFirst.mockResolvedValue(null);

        await expect(service.join(account, withProof)).rejects.toThrow(
          NotFoundException,
        );
        expect(emailVerification.consume).not.toHaveBeenCalled();
      });
    });

    it('without the pair, no proof is spent', async () => {
      await service.join(account, dto);

      expect(emailVerification.consume).not.toHaveBeenCalled();
    });

    it('emits MEMBER_JOIN_REQUESTED after the insert', async () => {
      await service.join(account, dto);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.MEMBER_JOIN_REQUESTED,
        { companyId: 'company-1', memberProfileId: 'profile-new' },
      );
      expect(
        transaction.profile.createManyAndReturn.mock.invocationCallOrder[0],
      ).toBeLessThan(eventEmitter.emit.mock.invocationCallOrder[0]);
    });

    it('returns the new profile as a dropdown entry (CompanyProfileView)', async () => {
      await expect(service.join(account, dto)).resolves.toEqual({
        profileId: 'profile-new',
        view: true,
      });
      expect(accounts.toCompanyProfileView).toHaveBeenCalledWith(profileRow());
    });
  });

  describe('create', () => {
    const dto = {
      companyName: 'New Co',
      taxId: '123-45-67890',
      ownerName: 'Owner Kim',
    };

    it('the platform admin → 403, and no transaction starts', async () => {
      accounts.isPlatformAdmin.mockResolvedValue(true);

      await expect(service.create(account, dto)).rejects.toThrow(
        new ForbiddenException(
          'The platform admin cannot join or create companies',
        ),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('reads the OWNER role and draws a free join code BEFORE the transaction', async () => {
      await service.create(account, dto);

      expect(prisma.role.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { code: 'OWNER' },
        select: { id: true },
      });
      expect(
        prisma.role.findUniqueOrThrow.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
      expect(
        prisma.company.findUnique.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.$transaction.mock.invocationCallOrder[0]);
    });

    it("locks the account's row by writing it, THEN counts (Review Focus 5: two creates at once)", async () => {
      await service.create(account, dto);

      expect(transaction.account.updateMany).toHaveBeenCalledWith({
        where: { id: 'account-1' },
        data: { updatedAt: expect.any(Date) },
      });
      expect(
        transaction.account.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(transaction.profile.count.mock.invocationCallOrder[0]);
    });

    it("counts this account's live OWNER profiles that are still waiting for approval", async () => {
      await service.create(account, dto);

      expect(transaction.profile.count).toHaveBeenCalledWith({
        where: {
          accountId: 'account-1',
          deletedAt: null,
          status: ProfileStatus.PENDING_APPROVAL,
          role: { code: 'OWNER' },
        },
      });
    });

    it('a company already waiting → 409, nothing created, no event', async () => {
      transaction.profile.count.mockResolvedValue(1);

      await expect(service.create(account, dto)).rejects.toThrow(
        new ConflictException(
          'You already have a company waiting for approval',
        ),
      );
      expect(transaction.profile.create).not.toHaveBeenCalled();
      expect(transaction.company.createManyAndReturn).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('creates the waiting OWNER profile first (no company yet), then the company created by it', async () => {
      await service.create(account, dto);

      expect(transaction.profile.create).toHaveBeenCalledWith({
        data: {
          accountId: 'account-1',
          name: 'Owner Kim',
          companyId: null,
          roleId: 2,
          status: ProfileStatus.PENDING_APPROVAL,
          contactEmail: null, // no proof sent
        },
        select: { id: true },
      });
      expect(transaction.company.createManyAndReturn).toHaveBeenCalledWith({
        data: [
          {
            name: 'New Co',
            taxId: '123-45-67890',
            joinCode: expect.stringMatching(/^\d{8}$/),
            createdByProfileId: 'profile-new',
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      expect(
        transaction.profile.create.mock.invocationCallOrder[0],
      ).toBeLessThan(
        transaction.company.createManyAndReturn.mock.invocationCallOrder[0],
      );
    });

    it('a taken tax ID (nothing inserted) → 409 thrown INSIDE the transaction, so the owner profile rolls back too', async () => {
      transaction.company.createManyAndReturn.mockResolvedValue([]);

      await expect(service.create(account, dto)).rejects.toThrow(
        new ConflictException('Tax ID already registered'),
      );
      // the throw came out of the transaction's work, not after it
      await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
        ConflictException,
      );
      expect(transaction.profile.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('then points the owner profile at its company, selecting the dropdown entry', async () => {
      await service.create(account, dto);

      expect(transaction.profile.update).toHaveBeenCalledWith({
        where: { id: 'profile-new' },
        data: { companyId: 'company-new' },
        select: {
          id: true,
          status: true,
          name: true,
          profileImageUrl: true,
          role: { select: { code: true, name: true } },
          company: { select: { id: true, name: true } },
        },
      });
    });

    it('emits COMPANY_REGISTERED only after the transaction commits', async () => {
      prisma.$transaction.mockImplementation(
        async (work: (client: unknown) => unknown) => {
          const result = await work(transaction);
          // still inside the transaction: nothing announced yet
          expect(eventEmitter.emit).not.toHaveBeenCalled();
          return result;
        },
      );

      await service.create(account, dto);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.COMPANY_REGISTERED,
        { companyId: 'company-new' },
      );
    });

    it('returns the new OWNER profile as a dropdown entry (CompanyProfileView)', async () => {
      await expect(service.create(account, dto)).resolves.toEqual({
        profileId: 'profile-new',
        view: true,
      });
      expect(accounts.toCompanyProfileView).toHaveBeenCalledWith(
        profileRow({
          name: 'Owner Kim',
          role: { code: 'OWNER', name: 'Owner' },
          company: { id: 'company-new', name: 'New Co' },
        }),
      );
    });

    it('without the pair, no proof is spent', async () => {
      await service.create(account, dto);

      expect(emailVerification.consume).not.toHaveBeenCalled();
    });

    describe('with a proven contact email (contactEmail + emailVerificationToken)', () => {
      const withProof = {
        ...dto,
        contactEmail: 'kim@newco.com',
        emailVerificationToken: 'email-token',
      };

      it('spends it on the transaction AFTER the lock and count, BEFORE the owner profile', async () => {
        await service.create(account, withProof);

        expect(emailVerification.consume).toHaveBeenCalledWith(transaction, {
          token: 'email-token',
          email: 'kim@newco.com',
        });
        const spent = emailVerification.consume.mock.invocationCallOrder[0];
        expect(
          transaction.profile.count.mock.invocationCallOrder[0],
        ).toBeLessThan(spent);
        expect(spent).toBeLessThan(
          transaction.profile.create.mock.invocationCallOrder[0],
        );
      });

      it('the owner profile gets that contact email', async () => {
        await service.create(account, withProof);

        expect(transaction.profile.create.mock.calls[0][0].data).toEqual(
          expect.objectContaining({ contactEmail: 'kim@newco.com' }),
        );
      });

      it('a company already waiting → 409 before the proof is spent', async () => {
        transaction.profile.count.mockResolvedValue(1);

        await expect(service.create(account, withProof)).rejects.toThrow(
          ConflictException,
        );
        expect(emailVerification.consume).not.toHaveBeenCalled();
      });

      it('a bad proof → 400: no profile, no company, no event', async () => {
        emailVerification.consume.mockRejectedValue(
          new BadRequestException('Invalid or expired email verification'),
        );

        await expect(service.create(account, withProof)).rejects.toThrow(
          new BadRequestException('Invalid or expired email verification'),
        );
        expect(transaction.profile.create).not.toHaveBeenCalled();
        expect(transaction.company.createManyAndReturn).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('a taken tax ID → 409 thrown inside the transaction: the spent proof rolls back with it', async () => {
        transaction.company.createManyAndReturn.mockResolvedValue([]);

        await expect(service.create(account, withProof)).rejects.toThrow(
          new ConflictException('Tax ID already registered'),
        );
        expect(emailVerification.consume).toHaveBeenCalled();
        await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
          ConflictException,
        );
      });
    });
  });
});
