import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RegisterDto } from './dto/register.dto';
import { ProfileModel } from '../generated/prisma/models';
import { RegisterMemberDto } from './dto/register-member.dto';
import {
  PhoneVerificationPurpose,
  ProfileStatus,
} from '../generated/prisma/enums';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationEvent } from '../notifications/notification-events';
import type {
  CompanyRegisteredEvent,
  MemberJoinRequestedEvent,
} from '../notifications/notification-events';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service';
import { generateUniqueJoinCode } from '../companies/join-code';
import { DevicesService } from '../devices/devices.service';
import { LogoutDto } from './dto/logout.dto';
import { Prisma } from '../generated/prisma/client';
import type {
  SignupCredentials,
  SocialCredentialsDto,
} from './dto/credentials.dto';
import { SignupTicketService } from '../social-auth/signup-tickets/signup-ticket.service';
import type { SpentSignupTicket } from '../social-auth/signup-tickets/signup-ticket.service';
import { EmailVerificationService } from '../email-verification/email-verification.service';
import { normalizeEmail } from '../common/email';
import { AccountsService } from '../accounts/accounts.service';
import type { OpenProfileSummary } from '../accounts/company-profile-view';
import type { SessionResponse } from './types/session-response';
import type { AuthAccount } from './types/auth-account';
import type { AuthProfile } from './types/auth-profile';
import { SwitchProfileDto } from './dto/switch-profile.dto';

/** What a signup creates for its credentials, decided inside the transaction. */
interface SignupLogin {
  contactEmail: string; // where notifications go
  loginMethod: Omit<Prisma.AccountLoginMethodCreateManyInput, 'accountId'>; // the account doesn't exist yet
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly eventEmitter: EventEmitter2,
    private readonly phoneVerification: PhoneVerificationService,
    private readonly devices: DevicesService,
    private readonly signupTickets: SignupTicketService,
    private readonly emailVerification: EmailVerificationService,
    private readonly accounts: AccountsService,
  ) {}

  /**
   * Our access + refresh tokens: a new session of the account, with this
   * company profile open (null = none). The refresh row remembers which.
   */
  private async issueSessionFor(accountId: string, profileId: string | null) {
    const accessToken = await this.tokenService.signAccess({
      accountId: accountId,
      profileId: profileId,
    });
    const { token: refreshToken, expiresAt } =
      await this.tokenService.signRefresh(accountId);

    await this.prisma.refreshToken.create({
      data: {
        accountId: accountId,
        profileId: profileId,
        tokenHash: this.tokenService.hashToken(refreshToken),
        expiresAt: expiresAt,
      },
    });

    return { accessToken: accessToken, refreshToken: refreshToken };
  }

  /**
   * Every way of signing in ends here (password and social login, refresh,
   * switch): a new session with this profile open (or none), plus the
   * company dropdown. The caller has already decided WHICH profile.
   */
  async startSession(
    accountId: string,
    profile: OpenProfileSummary | null,
  ): Promise<SessionResponse> {
    const tokens = await this.issueSessionFor(accountId, profile?.id ?? null);
    const companies = await this.accounts.listCompanies(accountId);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      profile: profile,
      companies: companies,
    };
  }

  /** null = no live account has this phone yet (a fast pre-check; the insert decides). */
  private findPhoneOwner(phone: string) {
    return this.prisma.account.findFirst({
      where: { phone: phone, deletedAt: null },
      select: { id: true },
    });
  }

  /** Password signups only: the login email must not be any login method's email. */
  private async isLoginEmailTaken(
    credentials: SignupCredentials,
  ): Promise<boolean> {
    if (credentials.type !== 'password') return false;
    const existing = await this.prisma.accountLoginMethod.findFirst({
      where: { email: credentials.email },
    });
    return existing !== null;
  }

  /** Hashed BEFORE the transaction (argon2 is slow); social signups have no password. */
  private passwordHashFor(
    credentials: SignupCredentials,
  ): Promise<string | null> {
    return credentials.type === 'password'
      ? this.passwordService.hash(credentials.password)
      : Promise.resolve(null);
  }

  /**
   * Inside the signup transaction: spend whatever proves the credentials and
   * return the login method to create, plus where notifications go.
   */
  private async signupLogin(
    transaction: Prisma.TransactionClient,
    credentials: SignupCredentials,
    passwordHash: string | null,
  ): Promise<SignupLogin> {
    if (credentials.type === 'password') {
      return {
        contactEmail: credentials.email, // notifications go to the login email
        loginMethod: {
          method: 'local',
          email: credentials.email,
          passwordHash: passwordHash!, // hashed by passwordHashFor for password credentials
        },
      };
    }

    const ticket = await this.signupTickets.consume(
      transaction,
      credentials.signupToken,
    );
    return {
      contactEmail: await this.contactEmailFor(
        transaction,
        ticket,
        credentials,
      ),
      loginMethod: {
        method: ticket.provider,
        providerUserId: ticket.providerUserId,
        email: ticket.email,
        emailVerified: ticket.emailVerified,
        refreshToken: ticket.providerRefreshToken, // already encrypted
      },
    };
  }

  /**
   * Where a social signup's notifications go: an address the user typed and
   * proved with an emailed code (their explicit choice wins), else the
   * provider's verified email, else 400. Never an unverified address.
   */
  private async contactEmailFor(
    transaction: Prisma.TransactionClient,
    ticket: SpentSignupTicket,
    credentials: SocialCredentialsDto,
  ): Promise<string> {
    const { contactEmail, emailVerificationToken } = credentials;
    if (contactEmail !== undefined && emailVerificationToken !== undefined) {
      await this.emailVerification.consume(transaction, {
        token: emailVerificationToken,
        email: contactEmail,
      });
      return normalizeEmail(contactEmail) as string;
    }
    const neitherSent =
      contactEmail === undefined && emailVerificationToken === undefined;
    if (neitherSent && ticket.emailVerified && ticket.email !== null) {
      return ticket.email;
    }
    throw new BadRequestException('A verified contact email is required');
  }

  /**
   * The new account's first login method — unless the database already has it:
   * the same provider identity (UQ_login_methods_identity) or, for a password
   * login, the same email (UQ_login_methods_local_email), registered by a
   * signup that got there first. skipDuplicates makes it INSERT … ON CONFLICT
   * DO NOTHING: a duplicate comes back as count 0 instead of an error. The
   * throw rolls the whole signup back, the new account and profile included.
   */
  private async addFirstLoginMethod(
    transaction: Prisma.TransactionClient,
    accountId: string,
    loginMethod: SignupLogin['loginMethod'],
  ): Promise<void> {
    const inserted = await transaction.accountLoginMethod.createMany({
      data: [{ ...loginMethod, accountId: accountId }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      // a brand-new account can't collide on (accountId, method): it's the other rule
      throw new ConflictException(
        loginMethod.method === 'local'
          ? 'Email already registered'
          : 'This account is already registered',
      );
    }
  }

  async register(dto: RegisterDto): Promise<{
    accessToken: string;
    refreshToken: string;
    profile: Partial<ProfileModel>;
  }> {
    const {
      companyName,
      taxId,
      ownerName,
      ownerPhone,
      ownerPhoneVerificationToken,
      credentials,
    } = dto;

    const [emailTaken, taxIdTaken, phoneTaken] = await Promise.all([
      this.isLoginEmailTaken(credentials),
      this.prisma.company.findUnique({ where: { taxId: taxId } }),
      this.findPhoneOwner(ownerPhone),
    ]);

    if (emailTaken) throw new ConflictException('Email already registered');
    if (taxIdTaken) throw new ConflictException('Tax ID already registered');
    if (phoneTaken) throw new ConflictException('Phone already registered');

    const passwordHash = await this.passwordHashFor(credentials);

    const role = await this.prisma.role.findUniqueOrThrow({
      where: {
        code: 'OWNER',
      },
    });

    const companyJoinCode = await generateUniqueJoinCode(this.prisma);

    const { profile, company, accountId } = await this.prisma.$transaction(
      async (transaction) => {
        // Spend the proofs first: if anything below fails, they roll back too.
        await this.phoneVerification.consume(transaction, {
          token: ownerPhoneVerificationToken,
          phone: ownerPhone,
          purpose: PhoneVerificationPurpose.SIGNUP,
        });
        const login = await this.signupLogin(
          transaction,
          credentials,
          passwordHash,
        );

        // The sign-in (phone + logins), then the owner's profile in the new company.
        const newAccountId = await this.accounts.createAccount(
          transaction,
          ownerPhone,
        );
        if (newAccountId === null) {
          throw new ConflictException('Phone already registered'); // taken meanwhile
        }
        const newProfile = await transaction.profile.create({
          data: {
            accountId: newAccountId,
            name: ownerName,
            contactEmail: login.contactEmail,
            companyId: null,
            status: 'PENDING_APPROVAL',
            roleId: role.id,
          },
        });
        await this.addFirstLoginMethod(
          transaction,
          newAccountId,
          login.loginMethod,
        );

        const newCompany = await transaction.company.create({
          data: {
            name: companyName,
            taxId: taxId,
            joinCode: companyJoinCode,
            createdByProfileId: newProfile.id,
          },
        });

        const updatedProfile = await transaction.profile.update({
          where: { id: newProfile.id },
          data: {
            companyId: newCompany.id,
          },
        });

        return {
          profile: updatedProfile,
          company: newCompany,
          accountId: newAccountId,
        };
      },
    );

    const registeredEvent: CompanyRegisteredEvent = {
      companyId: company.id,
    };
    this.eventEmitter.emit(
      NotificationEvent.COMPANY_REGISTERED,
      registeredEvent,
    );

    const tokens = await this.issueSessionFor(accountId, profile.id);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      profile: {
        id: profile.id,
        status: profile.status, // PENDING_APPROVAL
        companyId: profile.companyId,
        roleId: profile.roleId,
      },
    };
  }

  async registerMember(dto: RegisterMemberDto): Promise<{
    accessToken: string;
    refreshToken: string;
    profile: Partial<ProfileModel>;
  }> {
    const { joinCode, name, phone, phoneVerificationToken, credentials } = dto;

    const [emailTaken, phoneTaken] = await Promise.all([
      this.isLoginEmailTaken(credentials),
      this.findPhoneOwner(phone),
    ]);

    if (emailTaken) throw new ConflictException('Email already registered');
    if (phoneTaken) throw new ConflictException('Phone already registered');

    const passwordHash = await this.passwordHashFor(credentials);

    // The phone token is spent BEFORE the join code is looked at, so learning
    // whether a code exists costs a real phone verification. An unknown code
    // RETURNS (commit → the token stays spent) instead of throwing (rollback).
    const created = await this.prisma.$transaction(async (transaction) => {
      await this.phoneVerification.consume(transaction, {
        token: phoneVerificationToken,
        phone: phone,
        purpose: PhoneVerificationPurpose.SIGNUP,
      });

      const company = await transaction.company.findUnique({
        where: { joinCode: joinCode },
      });
      if (!company) return null;

      // Only now: a mistyped join code must not burn the user's signup ticket.
      const login = await this.signupLogin(
        transaction,
        credentials,
        passwordHash,
      );

      // The sign-in (phone + logins), then the member's profile in that company.
      const accountId = await this.accounts.createAccount(transaction, phone);
      if (accountId === null) {
        throw new ConflictException('Phone already registered'); // taken meanwhile
      }
      const profile = await transaction.profile.create({
        data: {
          accountId: accountId,
          name: name,
          contactEmail: login.contactEmail,
          companyId: company.id,
          roleId: null, // role assigned by the owner at approval
          status: ProfileStatus.PENDING_APPROVAL,
        },
      });
      await this.addFirstLoginMethod(transaction, accountId, login.loginMethod);
      return { profile: profile, companyId: company.id, accountId: accountId };
    });

    if (!created) throw new NotFoundException('Invalid join code');
    const { profile, companyId, accountId } = created;

    const joinRequestedEvent: MemberJoinRequestedEvent = {
      companyId: companyId,
      memberProfileId: profile.id,
    };
    this.eventEmitter.emit(
      NotificationEvent.MEMBER_JOIN_REQUESTED,
      joinRequestedEvent,
    );

    const tokens = await this.issueSessionFor(accountId, profile.id);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      profile: {
        id: profile.id,
        status: profile.status, // PENDING_APPROVAL
        companyId: profile.companyId,
        roleId: profile.roleId, // null
      },
    };
  }

  async login(dto: LoginDto): Promise<SessionResponse> {
    const { email, password } = dto;

    const loginMethod = await this.prisma.accountLoginMethod.findFirst({
      where: { email: email, method: 'local' },
      include: {
        account: { select: { id: true, deletedAt: true, lastProfileId: true } },
      },
    });

    if (!loginMethod?.passwordHash)
      throw new UnauthorizedException('Invalid credentials');

    const valid = await this.passwordService.verify(
      loginMethod.passwordHash,
      password,
    );
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const account = loginMethod.account;
    if (account.deletedAt)
      throw new UnauthorizedException('Account cannot sign in');

    // Which company opens: the last one used, if it can still be opened.
    // None at all (no company yet, or every one left) still signs in: the
    // app shows join-or-create.
    const profile = await this.accounts.findProfileToOpen(
      account.id,
      account.lastProfileId,
    );
    return this.startSession(account.id, profile);
  }

  /**
   * The live session behind a refresh token, with its account. 401 for a
   * bad, unknown or deleted-account token. A token that was ALREADY revoked
   * means someone kept a copy (rotation hands out a new one each time): we
   * can't tell the thief from the owner, so every session of the account
   * ends.
   */
  private async findLiveSession(refreshToken: string) {
    try {
      await this.tokenService.verifyRefresh(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.tokenService.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: tokenHash },
      include: {
        account: { select: { deletedAt: true, lastProfileId: true } },
      },
    });
    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    if (stored.revokedAt) {
      // every session of the person, whichever company each had open
      await this.prisma.refreshToken.updateMany({
        where: { accountId: stored.accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (stored.account.deletedAt) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return stored;
  }

  /** Rotation: a refresh token works once; the next session gets a new one. */
  private async revokeSession(tokenHash: string) {
    await this.prisma.refreshToken.update({
      where: { tokenHash: tokenHash },
      data: { revokedAt: new Date() },
    });
  }

  async refresh(dto: RefreshDto): Promise<SessionResponse> {
    const session = await this.findLiveSession(dto.refreshToken);

    // Keep the session's company while it can still be opened. If it can't
    // (left, suspended, deleted) — or none was open — choose the way sign-in
    // does. Never a token for a profile that stopped being openable.
    const kept =
      session.profileId === null
        ? null
        : await this.accounts.findOpenableProfile(
            session.accountId,
            session.profileId,
          );
    const profile =
      kept ??
      (await this.accounts.findProfileToOpen(
        session.accountId,
        session.account.lastProfileId,
      ));

    await this.revokeSession(session.tokenHash);
    return this.startSession(session.accountId, profile);
  }

  /**
   * Open another of the caller's companies, without a password. Rotates the
   * session (so a later refresh stays in the new company) and remembers the
   * choice for the next sign-in.
   */
  async switchProfile(
    account: AuthAccount,
    dto: SwitchProfileDto,
  ): Promise<SessionResponse> {
    const session = await this.findLiveSession(dto.refreshToken);
    if (session.accountId !== account.accountId) {
      throw new UnauthorizedException('Invalid refresh token'); // not the caller's session
    }

    const profile = await this.accounts.findOpenableProfile(
      account.accountId,
      dto.profileId,
    );
    // checked BEFORE anything is revoked: a wrong id leaves the session as it was
    if (!profile) throw new NotFoundException('Company profile not found');

    await this.revokeSession(session.tokenHash);
    // Only switching writes this: a refresh that had to fall back must not
    // overwrite the company the person last CHOSE.
    await this.prisma.account.update({
      where: { id: account.accountId },
      data: { lastProfileId: profile.id },
    });
    return this.startSession(account.accountId, profile);
  }

  /** GET /auth/me: the sign-in, and the company profile open (null = none). */
  async me(account: AuthAccount, profile: AuthProfile | null) {
    const { phone } = await this.prisma.account.findUniqueOrThrow({
      where: { id: account.accountId },
      select: { phone: true },
    });
    return { accountId: account.accountId, phone: phone, profile: profile };
  }

  async logout(accountId: string, dto: LogoutDto) {
    const tokenHash = this.tokenService.hashToken(dto.refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: tokenHash, accountId: accountId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Stop this device showing pushes from every company (only the caller's
    // own token).
    if (dto.deviceToken) {
      await this.devices.unregister(accountId, dto.deviceToken);
    }
  }
}
