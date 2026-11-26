import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AccountDeletionService } from './account-deletion.service';
import { PrismaService } from '../prisma/prisma.service';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service';
import { LeavingService } from '../profiles/leaving.service';
import type { LeaveOutcome } from '../profiles/leaving.service';
import { ProviderDisconnectService } from '../social-auth/provider-disconnect.service';
import { AccountsService } from '../accounts/accounts.service';
import type { AuthAccount } from '../auth/types/auth-account';
import {
  PhoneVerificationPurpose,
  ProfileStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

/** "Some Date": the moment a row was stamped isn't what these tests check. */
const ANY_DATE: unknown = expect.any(Date);

/**
 * Han deletes their account. Han is staff in Company A and the last owner
 * of Company B (the system picks B's next owner), and signs in with a
 * password and with Kakao.
 */
describe('AccountDeletionService', () => {
  let service: AccountDeletionService;
  let tx: {
    account: { updateManyAndReturn: jest.Mock; update: jest.Mock };
    profile: { findMany: jest.Mock };
    accountLoginMethod: { findMany: jest.Mock; deleteMany: jest.Mock };
    refreshToken: { updateMany: jest.Mock };
    deviceToken: { deleteMany: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  let phoneVerification: { consume: jest.Mock };
  let leaving: { leaveInTransaction: jest.Mock };
  let disconnect: { disconnectQuietly: jest.Mock };
  let accounts: { isPlatformAdmin: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  /** The order things happened in: the lock, each step, the commit, events, disconnects. */
  let timeline: string[];
  /** What the account lock returns: [] when the account is already deleted. */
  let lockedRows: { phone: string | null }[];

  const han: AuthAccount = { accountId: 'account-of-han', profileId: 'han-a' };
  const dto = { phoneVerificationToken: 'raw-phone-token' };

  // Han's profiles as the query returns them (it orders them by companyId).
  const profileRows = [
    { id: 'han-a', companyId: 'company-a' },
    { id: 'han-b', companyId: 'company-b' },
  ];
  // Han's login methods as stored (the Kakao row has no refresh token).
  const loginRows = [
    {
      id: 'lm-local',
      method: 'local',
      providerUserId: null,
      refreshToken: null,
    },
    {
      id: 'lm-kakao',
      method: 'kakao',
      providerUserId: '4321',
      refreshToken: null,
    },
  ];
  // What each company's leave announces after the commit.
  const leftA = { name: NotificationEvent.MEMBER_LEFT, payload: { a: 1 } };
  const newOwnerB = {
    name: NotificationEvent.MEMBER_ROLE_CHANGED,
    payload: { b: 1 },
  };
  const leftB = { name: NotificationEvent.MEMBER_LEFT, payload: { b: 2 } };
  const outcomes: Record<string, LeaveOutcome> = {
    'han-a': {
      summary: { companyClosed: false, newOwner: null },
      events: [leftA],
    },
    'han-b': {
      summary: {
        companyClosed: false,
        newOwner: { profileId: 'lee', name: 'Lee', picked: 'AUTO' },
      },
      events: [newOwnerB, leftB],
    },
  };

  beforeEach(() => {
    timeline = [];
    lockedRows = [{ phone: '01012345678' }];
    tx = {
      account: {
        updateManyAndReturn: jest.fn(() => {
          timeline.push('lock account');
          return Promise.resolve(lockedRows);
        }),
        update: jest.fn(() => {
          timeline.push('mark account deleted');
          return Promise.resolve({});
        }),
      },
      profile: {
        findMany: jest.fn(() => {
          timeline.push('read profiles');
          return Promise.resolve(profileRows);
        }),
      },
      accountLoginMethod: {
        findMany: jest.fn(() => {
          timeline.push('read login methods');
          return Promise.resolve(loginRows);
        }),
        deleteMany: jest.fn(() => {
          timeline.push('delete login methods');
          return Promise.resolve({ count: 2 });
        }),
      },
      refreshToken: {
        updateMany: jest.fn(() => {
          timeline.push('revoke sessions');
          return Promise.resolve({ count: 3 });
        }),
      },
      deviceToken: {
        deleteMany: jest.fn(() => {
          timeline.push('delete devices');
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    prisma = {
      $transaction: jest.fn(async (callback: (client: unknown) => unknown) => {
        const result = await callback(tx);
        timeline.push('commit');
        return result;
      }),
    };
    phoneVerification = {
      consume: jest.fn(() => {
        timeline.push('spend proof');
        return Promise.resolve();
      }),
    };
    leaving = {
      leaveInTransaction: jest.fn(
        (
          _transaction: unknown,
          input: { profileId: string; companyId: string },
        ) => {
          timeline.push(`leave ${input.companyId}`);
          return Promise.resolve(outcomes[input.profileId]);
        },
      ),
    };
    disconnect = {
      disconnectQuietly: jest.fn((login: { method: string }) => {
        timeline.push(`disconnect ${login.method}`);
        return Promise.resolve();
      }),
    };
    accounts = { isPlatformAdmin: jest.fn().mockResolvedValue(false) };
    eventEmitter = {
      emit: jest.fn((name: string) => {
        timeline.push(`emit ${name}`);
        return true;
      }),
    };
    // constructor order: (prisma, phoneVerification, leaving, disconnect, accounts, eventEmitter)
    service = new AccountDeletionService(
      prisma as unknown as PrismaService,
      phoneVerification as unknown as PhoneVerificationService,
      leaving as unknown as LeavingService,
      disconnect as unknown as ProviderDisconnectService,
      accounts as unknown as AccountsService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  it('one transaction, in this order: lock, proof, each company, logins, sessions, devices, the account; then the events, then the disconnects', async () => {
    await expect(service.deleteAccount(han, dto)).resolves.toBeUndefined();

    expect(timeline).toEqual([
      'lock account',
      'spend proof',
      'read profiles',
      'leave company-a',
      'leave company-b',
      'read login methods',
      'delete login methods',
      'revoke sessions',
      'delete devices',
      'mark account deleted',
      'commit',
      'emit member.left',
      'emit member.roleChanged',
      'emit member.left',
      'disconnect local',
      'disconnect kakao',
    ]);
  });

  it('the platform admin → 403 before anything: it runs the platform, and has no phone to prove', async () => {
    accounts.isPlatformAdmin.mockResolvedValue(true);

    await expect(service.deleteAccount(han, dto)).rejects.toThrow(
      new ForbiddenException('The platform admin cannot delete its account'),
    );
    expect(accounts.isPlatformAdmin).toHaveBeenCalledWith('account-of-han');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('locks only a live account, and reads its phone in the same statement', async () => {
    await service.deleteAccount(han, dto);

    expect(tx.account.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: 'account-of-han', deletedAt: null },
      data: { updatedAt: ANY_DATE },
      select: { phone: true },
    });
  });

  it('deleted meanwhile (a second DELETE /me waited for the lock) → 401, nothing else runs', async () => {
    lockedRows = [];

    await expect(service.deleteAccount(han, dto)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(timeline).toEqual(['lock account']);
  });

  it('an account without a phone (only the seeded admin has none) → 403, nothing spent', async () => {
    lockedRows = [{ phone: null }];

    await expect(service.deleteAccount(han, dto)).rejects.toThrow(
      new ForbiddenException('The platform admin cannot delete its account'),
    );
    expect(phoneVerification.consume).not.toHaveBeenCalled();
  });

  it("spends a DELETE_ACCOUNT proof of the account's OWN phone, inside the transaction", async () => {
    await service.deleteAccount(han, dto);

    expect(phoneVerification.consume).toHaveBeenCalledWith(tx, {
      token: 'raw-phone-token',
      phone: '01012345678',
      purpose: PhoneVerificationPurpose.DELETE_ACCOUNT,
    });
  });

  it('a bad proof (another phone or purpose, used, expired) → its 400; nothing else runs, nothing is sent', async () => {
    phoneVerification.consume.mockRejectedValue(
      new BadRequestException('Invalid or expired verification token'),
    );

    await expect(service.deleteAccount(han, dto)).rejects.toThrow(
      new BadRequestException('Invalid or expired verification token'),
    );
    expect(timeline).toEqual(['lock account']);
  });

  it('leaves every company it is still in (live, not DEACTIVATED), in companyId order: one lock order for everyone', async () => {
    await service.deleteAccount(han, dto);

    expect(tx.profile.findMany).toHaveBeenCalledWith({
      where: {
        accountId: 'account-of-han',
        deletedAt: null,
        status: { not: ProfileStatus.DEACTIVATED },
      },
      orderBy: { companyId: 'asc' },
      select: { id: true, companyId: true },
    });
  });

  it('each leave is the shared procedure: reason ACCOUNT_DELETED, Han as the actor, no successor named (the system picks)', async () => {
    await service.deleteAccount(han, dto);

    expect(leaving.leaveInTransaction).toHaveBeenNthCalledWith(1, tx, {
      profileId: 'han-a',
      companyId: 'company-a',
      actorProfileId: 'han-a',
      reason: 'ACCOUNT_DELETED',
    });
    expect(leaving.leaveInTransaction).toHaveBeenNthCalledWith(2, tx, {
      profileId: 'han-b',
      companyId: 'company-b',
      actorProfileId: 'han-b',
      reason: 'ACCOUNT_DELETED',
    });
    // nobody named: the system picks, as when a last owner leaves without naming anyone
    expect(leaving.leaveInTransaction).not.toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        ownerSuccessorProfileId: expect.anything() as unknown,
      }),
    );
  });

  it('a company that just changed (the procedure answers 409) → the whole deletion fails; no logins deleted, nothing sent', async () => {
    leaving.leaveInTransaction.mockImplementation(
      (_transaction: unknown, input: { companyId: string }) => {
        timeline.push(`leave ${input.companyId}`);
        return input.companyId === 'company-b'
          ? Promise.reject(
              new ConflictException('This member was just changed; reload'),
            )
          : Promise.resolve(outcomes['han-a']);
      },
    );

    await expect(service.deleteAccount(han, dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(timeline).toEqual([
      'lock account',
      'spend proof',
      'read profiles',
      'leave company-a',
      'leave company-b',
    ]);
  });

  it('no company left to leave (all DEACTIVATED already) → the sign-in is still deleted', async () => {
    tx.profile.findMany.mockResolvedValue([]);

    await service.deleteAccount(han, dto);

    expect(leaving.leaveInTransaction).not.toHaveBeenCalled();
    expect(tx.account.update).toHaveBeenCalled();
  });

  it('reads the login methods (the disconnects need them), then deletes them all: the identities and the email are free again', async () => {
    await service.deleteAccount(han, dto);

    expect(tx.accountLoginMethod.findMany).toHaveBeenCalledWith({
      where: { accountId: 'account-of-han' },
      select: {
        id: true,
        method: true,
        providerUserId: true,
        refreshToken: true,
      },
    });
    expect(tx.accountLoginMethod.deleteMany).toHaveBeenCalledWith({
      where: { accountId: 'account-of-han' },
    });
  });

  it('ends every live session and removes every device: no new access tokens, no pushes', async () => {
    await service.deleteAccount(han, dto);

    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { accountId: 'account-of-han', revokedAt: null },
      data: { revokedAt: ANY_DATE },
    });
    expect(tx.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { accountId: 'account-of-han' },
    });
  });

  it('marks the account deleted (old access tokens refused, the phone free) and forgets its last company', async () => {
    await service.deleteAccount(han, dto);

    expect(tx.account.update).toHaveBeenCalledWith({
      where: { id: 'account-of-han' },
      data: { deletedAt: ANY_DATE, lastProfileId: null },
    });
  });

  it("after the commit: every company's events in order, then one disconnect per login, with the rows as read", async () => {
    await service.deleteAccount(han, dto);

    expect(eventEmitter.emit.mock.calls).toEqual([
      [leftA.name, leftA.payload],
      [newOwnerB.name, newOwnerB.payload],
      [leftB.name, leftB.payload],
    ]);
    expect(disconnect.disconnectQuietly.mock.calls).toEqual([
      [loginRows[0]],
      [loginRows[1]],
    ]);
  });
});
