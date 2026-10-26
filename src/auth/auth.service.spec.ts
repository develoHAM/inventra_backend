import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  PhoneVerificationPurpose,
  UserStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let tx: {
    user: { create: jest.Mock; update: jest.Mock };
    company: { create: jest.Mock; findUnique: jest.Mock };
    userLoginMethod: { createMany: jest.Mock };
  };
  let passwordService: { hash: jest.Mock; verify: jest.Mock };
  let tokenService: {
    signAccess: jest.Mock;
    signRefresh: jest.Mock;
    hashToken: jest.Mock;
    verifyRefresh: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };
  let phoneVerification: { consume: jest.Mock };
  let devices: { unregister: jest.Mock };
  let signupTickets: { consume: jest.Mock };
  let emailVerification: { consume: jest.Mock };

  /** A spent Kakao ticket whose provider email is verified. */
  const kakaoTicket = {
    provider: 'kakao',
    providerUserId: '4012345678',
    email: 'owner@kakao.com',
    emailVerified: true,
    name: '김사장',
    providerRefreshToken: null,
  };

  const registerDto = {
    companyName: 'Acme',
    taxId: '123-45-67890',
    ownerName: 'Jane Owner',
    credentials: {
      type: 'password',
      email: 'jane@acme.com',
      password: 'password123',
    },
    ownerPhone: '01012345678',
    ownerPhoneVerificationToken: 'owner-verification-token',
  };

  const memberDto = {
    joinCode: '48291307',
    credentials: {
      type: 'password',
      email: 'sam@acme.com',
      password: 'password123',
    },
    name: 'Sam Staff',
    phone: '01099998888',
    phoneVerificationToken: 'member-verification-token',
  };

  beforeEach(() => {
    // transaction-scoped client used by the owner-register flow
    tx = {
      user: {
        create: jest.fn().mockResolvedValue({ id: 'user-1' }),
        update: jest.fn().mockResolvedValue({
          id: 'user-1',
          status: 'PENDING_APPROVAL',
          companyId: 'company-1',
          roleId: 2,
        }),
      },
      company: {
        create: jest.fn().mockResolvedValue({ id: 'company-1' }),
        // member signup looks the join code up inside its transaction
        findUnique: jest.fn().mockResolvedValue({
          id: 'company-1',
          joinCode: '48291307',
        }),
      },
      // the first login method: ON CONFLICT DO NOTHING → count 1 inserted, 0 skipped
      userLoginMethod: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    prisma = {
      userLoginMethod: { findFirst: jest.fn().mockResolvedValue(null) },
      // null default = "not taken" (register tax-ID check) / "not found" (member join-code)
      company: { findUnique: jest.fn().mockResolvedValue(null) },
      role: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 2, code: 'OWNER' }),
      },
      // null default = "phone not taken"
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      refreshToken: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };

    passwordService = {
      hash: jest.fn().mockResolvedValue('hashed-pw'),
      verify: jest.fn().mockResolvedValue(true),
    };
    tokenService = {
      signAccess: jest.fn().mockResolvedValue('access-token'),
      signRefresh: jest.fn().mockResolvedValue({
        token: 'refresh-token',
        jti: 'jti-1',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      }),
      hashToken: jest.fn().mockReturnValue('hashed-refresh'),
      verifyRefresh: jest
        .fn()
        .mockResolvedValue({ sub: 'user-1', jti: 'jti-1' }),
    };

    eventEmitter = { emit: jest.fn().mockReturnValue(true) };
    phoneVerification = { consume: jest.fn().mockResolvedValue(undefined) };
    devices = { unregister: jest.fn().mockResolvedValue(undefined) };
    signupTickets = { consume: jest.fn().mockResolvedValue(kakaoTicket) };
    emailVerification = { consume: jest.fn().mockResolvedValue(undefined) };
    service = new AuthService(
      prisma,
      passwordService as any,
      tokenService as any,
      eventEmitter as any,
      phoneVerification as any,
      devices as any,
      signupTickets as any,
      emailVerification as any,
    );
  });

  describe('register (company self-signup)', () => {
    it('creates company + owner and returns a pending session', async () => {
      const result = await service.register(registerDto as any);

      // company references the just-created user (circular-FK, user-first)
      expect(tx.company.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Acme',
          taxId: '123-45-67890',
          createdByUserId: 'user-1',
        }),
      });
      // user linked back to the company
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { companyId: 'company-1' },
      });
      // refresh token stored HASHED
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          tokenHash: 'hashed-refresh',
          expiresAt: expect.any(Date),
        },
      });
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 'user-1',
          status: 'PENDING_APPROVAL',
          companyId: 'company-1',
          roleId: 2,
        },
      });
    });

    it('emits company.registered with the new company id, after the transaction commits', async () => {
      await service.register(registerDto as any);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.COMPANY_REGISTERED,
        { companyId: 'company-1' },
      );
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        eventEmitter.emit.mock.invocationCallOrder[0],
      );
    });

    it('emits nothing when the signup transaction fails', async () => {
      tx.company.create.mockRejectedValue(new Error('db down'));

      await expect(service.register(registerDto as any)).rejects.toThrow(
        'db down',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rejects a duplicate email with 409 before any writes', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({ id: 'lm-1' });

      await expect(service.register(registerDto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rejects a duplicate tax ID with 409 before any writes', async () => {
      prisma.company.findUnique.mockResolvedValue({ id: 'existing-company' });

      await expect(service.register(registerDto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a phone another user already has with 409 before any writes', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'someone-else' });

      await expect(service.register(registerDto as any)).rejects.toThrow(
        new ConflictException('Phone already registered'),
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { phone: '01012345678', deletedAt: null },
        select: { id: true },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(phoneVerification.consume).not.toHaveBeenCalled();
    });

    it('spends the phone token inside the transaction, before creating the owner', async () => {
      await service.register(registerDto as any);

      expect(phoneVerification.consume).toHaveBeenCalledWith(tx, {
        token: 'owner-verification-token',
        phone: '01012345678',
        purpose: PhoneVerificationPurpose.SIGNUP,
      });
      expect(
        phoneVerification.consume.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.user.create.mock.invocationCallOrder[0]);
    });

    it('sets the contact email to the login email (where notifications go)', async () => {
      await service.register(registerDto as any);

      expect(tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ contactEmail: 'jane@acme.com' }),
      });
    });

    it('stores the verified phone on the owner', async () => {
      await service.register(registerDto as any);

      expect(tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ phone: '01012345678' }),
      });
    });

    it('creates nothing and emits nothing when the phone token is invalid', async () => {
      phoneVerification.consume.mockRejectedValue(
        new BadRequestException('Invalid or expired verification token'),
      );

      await expect(service.register(registerDto as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(tx.company.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('social signup (credentials.type = social)', () => {
    const social = { type: 'social', signupToken: 'raw-signup-token' };
    const socialOwner = (credentials: Record<string, unknown> = social) =>
      ({ ...registerDto, credentials: credentials }) as any;
    /** The data the owner was created with. */
    const createdOwner = () => tx.user.create.mock.calls[0][0].data;
    /** The login row inserted for the new user. */
    const insertedLogin = () =>
      tx.userLoginMethod.createMany.mock.calls[0][0].data[0];

    it('creates the owner with the provider login (no password), from the ticket', async () => {
      const result = await service.register(socialOwner());

      expect(tx.userLoginMethod.createMany).toHaveBeenCalledWith({
        data: [
          {
            method: 'kakao',
            providerUserId: '4012345678',
            email: 'owner@kakao.com',
            emailVerified: true,
            refreshToken: null,
            userId: 'user-1',
          },
        ],
        skipDuplicates: true, // INSERT … ON CONFLICT DO NOTHING
      });
      expect(result).toMatchObject({
        accessToken: 'access-token',
        user: { id: 'user-1' },
      });
    });

    it('a verified provider email becomes the contact email', async () => {
      await service.register(socialOwner());

      expect(createdOwner().contactEmail).toBe('owner@kakao.com');
      expect(emailVerification.consume).not.toHaveBeenCalled();
    });

    it('spends phone token → ticket inside ONE transaction, before the user is created', async () => {
      await service.register(socialOwner());

      expect(signupTickets.consume).toHaveBeenCalledWith(
        tx,
        'raw-signup-token',
      );
      expect(
        phoneVerification.consume.mock.invocationCallOrder[0],
      ).toBeLessThan(signupTickets.consume.mock.invocationCallOrder[0]);
      expect(signupTickets.consume.mock.invocationCallOrder[0]).toBeLessThan(
        tx.user.create.mock.invocationCallOrder[0],
      );
    });

    it('no password: no email-taken check, no hashing (never matched by email)', async () => {
      await service.register(socialOwner());

      expect(prisma.userLoginMethod.findFirst).not.toHaveBeenCalled();
      expect(passwordService.hash).not.toHaveBeenCalled();
    });

    it('an Apple ticket keeps its (already encrypted) refresh token on the login', async () => {
      signupTickets.consume.mockResolvedValue({
        ...kakaoTicket,
        provider: 'apple',
        providerRefreshToken: 'encrypted-apple-refresh',
      });

      await service.register(socialOwner());

      expect(insertedLogin()).toMatchObject({
        method: 'apple',
        refreshToken: 'encrypted-apple-refresh',
      });
    });

    it('an invalid ticket → 400, nothing created, nothing emitted', async () => {
      signupTickets.consume.mockRejectedValue(
        new BadRequestException('Invalid or expired signup token'),
      );

      await expect(service.register(socialOwner())).rejects.toThrow(
        new BadRequestException('Invalid or expired signup token'),
      );
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('a double-tapped signup: the second spend of the same ticket fails → one account', async () => {
      // the conditional updateMany lets exactly one transaction spend it
      signupTickets.consume
        .mockResolvedValueOnce(kakaoTicket)
        .mockRejectedValueOnce(
          new BadRequestException('Invalid or expired signup token'),
        );

      const attempts = await Promise.allSettled([
        service.register(socialOwner()),
        service.register(socialOwner()),
      ]);

      expect(attempts.map((attempt) => attempt.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      expect(tx.user.create).toHaveBeenCalledTimes(1);
    });

    describe('the contact email', () => {
      const appleLaterSignIn = {
        ...kakaoTicket,
        provider: 'apple',
        email: null, // Apple's second-and-later sign-ins carry no email
        emailVerified: false,
      };

      it.each([
        ['no provider email (Apple, later sign-in)', appleLaterSignIn],
        [
          'an unverified provider email',
          { ...kakaoTicket, emailVerified: false },
        ],
      ])('%s and nothing typed → 400, no account', async (_label, ticket) => {
        signupTickets.consume.mockResolvedValue(ticket);

        await expect(service.register(socialOwner())).rejects.toThrow(
          new BadRequestException('A verified contact email is required'),
        );
        expect(tx.user.create).not.toHaveBeenCalled();
      });

      it('a typed address proven by an emailed code → spent in the same transaction, stored normalized', async () => {
        signupTickets.consume.mockResolvedValue(appleLaterSignIn);

        await service.register(
          socialOwner({
            ...social,
            contactEmail: ' Owner@Example.COM ',
            emailVerificationToken: 'raw-email-token',
          }),
        );

        expect(emailVerification.consume).toHaveBeenCalledWith(tx, {
          token: 'raw-email-token',
          email: ' Owner@Example.COM ',
        });
        expect(createdOwner().contactEmail).toBe('owner@example.com');
        // the login keeps what the PROVIDER said (none here)
        expect(insertedLogin().email).toBeNull();
      });

      it("the user's typed, verified address wins over a verified provider email", async () => {
        await service.register(
          socialOwner({
            ...social,
            contactEmail: 'work@acme.com',
            emailVerificationToken: 'raw-email-token',
          }),
        );

        expect(createdOwner().contactEmail).toBe('work@acme.com');
      });

      it('an invalid email token → 400 from consume, no account (the ticket rolls back too)', async () => {
        emailVerification.consume.mockRejectedValue(
          new BadRequestException('Invalid or expired email verification'),
        );

        await expect(
          service.register(
            socialOwner({
              ...social,
              contactEmail: 'work@acme.com',
              emailVerificationToken: 'wrong',
            }),
          ),
        ).rejects.toThrow(BadRequestException);
        expect(tx.user.create).not.toHaveBeenCalled();
      });

      it.each([
        ['an address without its code', { contactEmail: 'work@acme.com' }],
        [
          'a code without its address',
          { emailVerificationToken: 'raw-email-token' },
        ],
      ])(
        '%s → 400, even with a verified provider email',
        async (_label, extra) => {
          await expect(
            service.register(socialOwner({ ...social, ...extra })),
          ).rejects.toThrow(
            new BadRequestException('A verified contact email is required'),
          );
        },
      );
    });

    describe('the same identity registering twice at once (two tickets)', () => {
      it('the login row is inserted right after the user, in the same transaction', async () => {
        await service.register(socialOwner());

        expect(tx.user.create.mock.invocationCallOrder[0]).toBeLessThan(
          tx.userLoginMethod.createMany.mock.invocationCallOrder[0],
        );
      });

      it('the identity got registered meanwhile → the insert is skipped (count 0) → 409', async () => {
        tx.userLoginMethod.createMany.mockResolvedValue({ count: 0 });

        await expect(service.register(socialOwner())).rejects.toThrow(
          new ConflictException('This account is already registered'),
        );
        // thrown INSIDE the transaction → it rolls back (the new user row too)
        await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
          ConflictException,
        );
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });

      it('any other failure passes through as is', async () => {
        const failure = new Error('db down');
        tx.userLoginMethod.createMany.mockRejectedValue(failure);

        await expect(service.register(socialOwner())).rejects.toBe(failure);
      });
    });

    describe('member signup', () => {
      const socialMember = { ...memberDto, credentials: social } as any;

      beforeEach(() => {
        tx.user.create.mockResolvedValue({
          id: 'member-1',
          status: 'PENDING_APPROVAL',
          companyId: 'company-1',
          roleId: null,
        });
      });

      it('creates the member with the provider login', async () => {
        await service.registerMember(socialMember);

        expect(tx.user.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            companyId: 'company-1',
            contactEmail: 'owner@kakao.com',
          }),
        });
        expect(insertedLogin()).toMatchObject({
          method: 'kakao',
          providerUserId: '4012345678',
          userId: 'member-1',
        });
      });

      it('spends the ticket only AFTER the join code is found', async () => {
        await service.registerMember(socialMember);

        expect(tx.company.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
          signupTickets.consume.mock.invocationCallOrder[0],
        );
      });

      it('a mistyped join code → 404 and the ticket is NOT spent (the phone token is)', async () => {
        tx.company.findUnique.mockResolvedValue(null);

        await expect(service.registerMember(socialMember)).rejects.toThrow(
          new NotFoundException('Invalid join code'),
        );
        expect(signupTickets.consume).not.toHaveBeenCalled();
        expect(phoneVerification.consume).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('registerMember (join-code self-signup)', () => {
    beforeEach(() => {
      // the member is created inside a transaction
      tx.user.create.mockResolvedValue({
        id: 'member-1',
        status: 'PENDING_APPROVAL',
        companyId: 'company-1',
        roleId: null,
      });
    });

    it('creates a role-less PENDING member in the join-code company, with auto-login', async () => {
      const result = await service.registerMember(memberDto as any);

      expect(tx.company.findUnique).toHaveBeenCalledWith({
        where: { joinCode: '48291307' },
      });
      expect(tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Sam Staff',
          companyId: 'company-1',
          roleId: null,
          status: UserStatus.PENDING_APPROVAL,
        }),
      });
      expect(tx.userLoginMethod.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            method: 'local',
            email: 'sam@acme.com',
            passwordHash: 'hashed-pw',
            userId: 'member-1',
          }),
        ],
        skipDuplicates: true,
      });
      expect(prisma.refreshToken.create).toHaveBeenCalled();
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 'member-1',
          status: 'PENDING_APPROVAL',
          companyId: 'company-1',
          roleId: null,
        },
      });
    });

    it('sets the contact email to the login email (where notifications go)', async () => {
      await service.registerMember(memberDto as any);

      expect(tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ contactEmail: 'sam@acme.com' }),
      });
    });

    it('stores the verified phone on the member', async () => {
      await service.registerMember(memberDto as any);

      expect(tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ phone: '01099998888' }),
      });
    });

    it('emits member.joinRequested after the member row is created', async () => {
      await service.registerMember(memberDto as any);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.MEMBER_JOIN_REQUESTED,
        { companyId: 'company-1', memberUserId: 'member-1' },
      );
      expect(tx.user.create.mock.invocationCallOrder[0]).toBeLessThan(
        eventEmitter.emit.mock.invocationCallOrder[0],
      );
    });

    describe('join codes cannot be probed without a verified phone', () => {
      it('spends the phone token BEFORE looking at the join code', async () => {
        await service.registerMember(memberDto as any);

        expect(phoneVerification.consume).toHaveBeenCalledWith(tx, {
          token: 'member-verification-token',
          phone: '01099998888',
          purpose: PhoneVerificationPurpose.SIGNUP,
        });
        expect(
          phoneVerification.consume.mock.invocationCallOrder[0],
        ).toBeLessThan(tx.company.findUnique.mock.invocationCallOrder[0]);
      });

      it('an invalid token gets 400 and never reveals whether the code exists', async () => {
        phoneVerification.consume.mockRejectedValue(
          new BadRequestException('Invalid or expired verification token'),
        );

        await expect(service.registerMember(memberDto as any)).rejects.toThrow(
          BadRequestException,
        );
        expect(tx.company.findUnique).not.toHaveBeenCalled();
        expect(tx.user.create).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });

      it('an unknown join code gets 404 AND the token stays spent (one probe per verified phone)', async () => {
        tx.company.findUnique.mockResolvedValue(null);

        await expect(service.registerMember(memberDto as any)).rejects.toThrow(
          new NotFoundException('Invalid join code'),
        );
        // the transaction COMMITTED (resolved) — so the consumption is kept;
        // the 404 is thrown only after it
        await expect(
          prisma.$transaction.mock.results[0].value,
        ).resolves.toBeDefined();
        expect(phoneVerification.consume).toHaveBeenCalledTimes(1);
        expect(tx.user.create).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });

      it('a failure while creating the member rolls back, so the token is NOT spent', async () => {
        tx.user.create.mockRejectedValue(new Error('unique violation'));

        await expect(service.registerMember(memberDto as any)).rejects.toThrow(
          'unique violation',
        );
        // the transaction itself rejected → Prisma rolls back the consume
        await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
          'unique violation',
        );
      });
    });

    it('rejects a duplicate email with 409 before any transaction', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({ id: 'lm-1' });

      await expect(service.registerMember(memberDto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a phone another user already has with 409 before any transaction', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'someone-else' });

      await expect(service.registerMember(memberDto as any)).rejects.toThrow(
        new ConflictException('Phone already registered'),
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { phone: '01099998888', deletedAt: null },
        select: { id: true },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    const loginDto = { email: 'jane@acme.com', password: 'password123' };

    const activeLoginMethod = {
      passwordHash: 'stored-hash',
      user: {
        id: 'user-1',
        status: UserStatus.ACTIVE,
        companyId: 'company-1',
        roleId: 2,
        deletedAt: null,
      },
    };

    it('issues a session for valid credentials on an ACTIVE user', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue(activeLoginMethod);

      const result = await service.login(loginDto as any);

      // verify(storedHash, candidate) — argument order matters
      expect(passwordService.verify).toHaveBeenCalledWith(
        'stored-hash',
        'password123',
      );
      expect(prisma.refreshToken.create).toHaveBeenCalled();
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 'user-1',
          status: UserStatus.ACTIVE,
          companyId: 'company-1',
          roleId: 2,
        },
      });
    });

    it('allows a PENDING user to log in (lands on the pending screen)', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({
        ...activeLoginMethod,
        user: {
          ...activeLoginMethod.user,
          status: UserStatus.PENDING_APPROVAL,
        },
      });

      const result = await service.login(loginDto as any);

      expect(result.user.status).toBe(UserStatus.PENDING_APPROVAL);
    });

    it('rejects an unknown email with a generic 401 (no enumeration)', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue(null);

      await expect(service.login(loginDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(passwordService.verify).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with a generic 401', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue(activeLoginMethod);
      passwordService.verify.mockResolvedValue(false);

      await expect(service.login(loginDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects a suspended (terminal-status) user even with valid credentials', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({
        ...activeLoginMethod,
        user: { ...activeLoginMethod.user, status: UserStatus.SUSPENDED },
      });

      await expect(service.login(loginDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('refresh (rotation + reuse detection)', () => {
    const refreshDto = { refreshToken: 'refresh-token-string' };

    const validStored = {
      tokenHash: 'hashed-refresh',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    };

    it('rotates: revokes the old token and issues a new pair', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(validStored);

      const result = await service.refresh(refreshDto as any);

      // old token revoked
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { tokenHash: 'hashed-refresh' },
        data: { revokedAt: expect.any(Date) },
      });
      // new pair issued + stored
      expect(prisma.refreshToken.create).toHaveBeenCalled();
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
    });

    it('rejects an invalid refresh JWT with 401', async () => {
      tokenService.verifyRefresh.mockRejectedValue(new Error('bad'));

      await expect(service.refresh(refreshDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a token that is not in the store with 401', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refresh(refreshDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });

    it("detects reuse: a revoked token revokes ALL the user's tokens and 401s", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...validStored,
        revokedAt: new Date('2027-01-01T00:00:00Z'), // already revoked
      });

      await expect(service.refresh(refreshDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      // whole family revoked
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // and NO new session issued
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the presented refresh token, scoped to the user', async () => {
      await service.logout('user-1', { refreshToken: 'refresh-token-string' });

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: 'hashed-refresh',
          userId: 'user-1',
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('also removes the device token, so the phone stops showing this user’s pushes', async () => {
      await service.logout('user-1', {
        refreshToken: 'refresh-token-string',
        deviceToken: 'phone-token',
      });

      // scoped to the caller: someone else's device is never touched
      expect(devices.unregister).toHaveBeenCalledWith('user-1', 'phone-token');
    });

    it('leaves devices alone when no deviceToken is sent (e.g. the web console)', async () => {
      await service.logout('user-1', { refreshToken: 'refresh-token-string' });

      expect(devices.unregister).not.toHaveBeenCalled();
    });
  });
});
