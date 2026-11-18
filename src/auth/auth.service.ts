import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { PhoneVerificationPurpose } from '../generated/prisma/enums';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service';
import { DevicesService } from '../devices/devices.service';
import { LogoutDto } from './dto/logout.dto';
import { Prisma } from '../generated/prisma/client';
import type { AccountSignupCredentials } from './dto/credentials.dto';
import { SignupDto } from './dto/signup.dto';
import { SignupTicketService } from '../social-auth/signup-tickets/signup-ticket.service';
import type { SpentSignupTicket } from '../social-auth/signup-tickets/signup-ticket.service';
import { AccountsService } from '../accounts/accounts.service';
import type { OpenProfileSummary } from '../accounts/company-profile-view';
import type { SessionResponse } from './types/session-response';
import type { AuthAccount } from './types/auth-account';
import type { AuthProfile } from './types/auth-profile';
import { SwitchProfileDto } from './dto/switch-profile.dto';

/** A login method about to be created: the account doesn't exist yet. */
type NewLoginMethod = Omit<
  Prisma.AccountLoginMethodCreateManyInput,
  'accountId'
>;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly phoneVerification: PhoneVerificationService,
    private readonly devices: DevicesService,
    private readonly signupTickets: SignupTicketService,
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
    credentials: AccountSignupCredentials,
  ): Promise<boolean> {
    if (credentials.type !== 'password') return false;
    const existing = await this.prisma.accountLoginMethod.findFirst({
      where: { email: credentials.email },
    });
    return existing !== null;
  }

  /** Hashed BEFORE the transaction (argon2 is slow); social signups have no password. */
  private passwordHashFor(
    credentials: AccountSignupCredentials,
  ): Promise<string | null> {
    return credentials.type === 'password'
      ? this.passwordService.hash(credentials.password)
      : Promise.resolve(null);
  }

  /** The login method a spent social signup ticket becomes. */
  private loginMethodFromTicket(ticket: SpentSignupTicket): NewLoginMethod {
    return {
      method: ticket.provider,
      providerUserId: ticket.providerUserId,
      email: ticket.email,
      emailVerified: ticket.emailVerified,
      refreshToken: ticket.providerRefreshToken, // already encrypted
    };
  }

  /**
   * Inside the signup transaction: spend whatever proves the credentials
   * (a social signup ticket; a password has nothing to spend) and return
   * the login method to create. No contact email: signup makes no profile.
   */
  private async spendLoginProof(
    transaction: Prisma.TransactionClient,
    credentials: AccountSignupCredentials,
    passwordHash: string | null,
  ): Promise<NewLoginMethod> {
    if (credentials.type === 'password') {
      return {
        method: 'local',
        email: credentials.email,
        passwordHash: passwordHash!, // hashed by passwordHashFor for password credentials
      };
    }
    const ticket = await this.signupTickets.consume(
      transaction,
      credentials.signupToken,
    );
    return this.loginMethodFromTicket(ticket);
  }

  /**
   * The new account's first login method — unless the database already has it:
   * the same provider identity (UQ_login_methods_identity) or, for a password
   * login, the same email (UQ_login_methods_local_email), registered by a
   * signup that got there first. skipDuplicates makes it INSERT … ON CONFLICT
   * DO NOTHING: a duplicate comes back as count 0 instead of an error. The
   * throw rolls the whole signup back, the new account included.
   */
  private async addFirstLoginMethod(
    transaction: Prisma.TransactionClient,
    accountId: string,
    loginMethod: NewLoginMethod,
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

  /**
   * POST /auth/signup: the sign-in only — an account (the verified phone)
   * and its first login method. No profile, no company, no event: the app
   * lands on join-or-create. Every failure inside the transaction THROWS,
   * so the whole signup rolls back and the phone token and ticket stay
   * unspent (nothing secret to probe here, unlike a join code).
   */
  async signup(dto: SignupDto): Promise<SessionResponse> {
    const { phone, phoneVerificationToken, credentials } = dto;

    // Fast 409s before anything is spent; the inserts below decide races.
    const [emailTaken, phoneTaken] = await Promise.all([
      this.isLoginEmailTaken(credentials),
      this.findPhoneOwner(phone),
    ]);
    if (emailTaken) throw new ConflictException('Email already registered');
    if (phoneTaken) throw new ConflictException('Phone already registered');

    const passwordHash = await this.passwordHashFor(credentials); // outside: argon2 is slow

    const accountId = await this.prisma.$transaction(async (transaction) => {
      // Spend the proofs first: if anything below fails, they roll back too.
      await this.phoneVerification.consume(transaction, {
        token: phoneVerificationToken,
        phone: phone,
        purpose: PhoneVerificationPurpose.SIGNUP,
      });
      const loginMethod = await this.spendLoginProof(
        transaction,
        credentials,
        passwordHash,
      );

      const newAccountId = await this.accounts.createAccount(
        transaction,
        phone,
      );
      if (newAccountId === null) {
        throw new ConflictException('Phone already registered'); // taken meanwhile
      }
      await this.addFirstLoginMethod(transaction, newAccountId, loginMethod);
      return newAccountId;
    });

    // After the commit: only now can the session's own insert see the account.
    return this.startSession(accountId, null);
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
