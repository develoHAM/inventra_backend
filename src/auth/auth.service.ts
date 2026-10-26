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
import { UserModel } from '../generated/prisma/models';
import { RegisterMemberDto } from './dto/register-member.dto';
import {
  PhoneVerificationPurpose,
  UserStatus,
} from '../generated/prisma/enums';
import { LoginDto } from './dto/login.dto';
import { CAN_AUTHENTICATE } from './auth.constants';
import { RefreshDto } from './dto/refresh.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationEvent } from '../notifications/notification-events';
import type {
  CompanyRegisteredEvent,
  MemberJoinRequestedEvent,
} from '../notifications/notification-events';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service';
import { generateUniqueJoinCode } from '../users/join-code';
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
import { normalizeEmail } from '../email-verification/email';

/** What a signup creates for its credentials, decided inside the transaction. */
interface SignupLogin {
  contactEmail: string; // where notifications go
  loginMethod: Omit<Prisma.UserLoginMethodCreateManyInput, 'userId'>; // the user doesn't exist yet
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
  ) {}

  /** Our access + refresh tokens for a signed-in user: every way of signing in ends here. */
  async issueSessionFor(userId: string) {
    const accessToken = await this.tokenService.signAccess(userId);
    const { token: refreshToken, expiresAt } =
      await this.tokenService.signRefresh(userId);

    await this.prisma.refreshToken.create({
      data: {
        userId: userId,
        tokenHash: this.tokenService.hashToken(refreshToken),
        expiresAt: expiresAt,
      },
    });

    return { accessToken: accessToken, refreshToken: refreshToken };
  }

  /** null = nobody (non-deleted) has this phone yet. */
  private findPhoneOwner(phone: string) {
    return this.prisma.user.findFirst({
      where: { phone: phone, deletedAt: null },
      select: { id: true },
    });
  }

  /** Password signups only: the login email must not be any login method's email. */
  private async isLoginEmailTaken(
    credentials: SignupCredentials,
  ): Promise<boolean> {
    if (credentials.type !== 'password') return false;
    const existing = await this.prisma.userLoginMethod.findFirst({
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
   * The new user's first login method — unless that provider identity is
   * already registered (two tickets for the same person, signed up at once).
   * skipDuplicates makes it INSERT … ON CONFLICT DO NOTHING: a duplicate comes
   * back as count 0 instead of an error. The throw rolls the whole signup back,
   * the new user row included.
   */
  private async addFirstLoginMethod(
    transaction: Prisma.TransactionClient,
    userId: string,
    loginMethod: SignupLogin['loginMethod'],
  ): Promise<void> {
    const inserted = await transaction.userLoginMethod.createMany({
      data: [{ ...loginMethod, userId: userId }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      throw new ConflictException('This account is already registered');
    }
  }

  async register(dto: RegisterDto): Promise<{
    accessToken: string;
    refreshToken: string;
    user: Partial<UserModel>;
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

    const { user, company } = await this.prisma.$transaction(
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

        const newUser = await transaction.user.create({
          data: {
            name: ownerName,
            phone: ownerPhone,
            contactEmail: login.contactEmail,
            companyId: null,
            status: 'PENDING_APPROVAL',
            roleId: role.id,
          },
        });
        await this.addFirstLoginMethod(
          transaction,
          newUser.id,
          login.loginMethod,
        );

        const newCompany = await transaction.company.create({
          data: {
            name: companyName,
            taxId: taxId,
            joinCode: companyJoinCode,
            createdByUserId: newUser.id,
          },
        });

        const updatedUser = await transaction.user.update({
          where: { id: newUser.id },
          data: {
            companyId: newCompany.id,
          },
        });

        return { user: updatedUser, company: newCompany };
      },
    );

    const registeredEvent: CompanyRegisteredEvent = {
      companyId: company.id,
    };
    this.eventEmitter.emit(
      NotificationEvent.COMPANY_REGISTERED,
      registeredEvent,
    );

    const tokens = await this.issueSessionFor(user.id);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        status: user.status, // PENDING_APPROVAL
        companyId: user.companyId,
        roleId: user.roleId,
      },
    };
  }

  async registerMember(dto: RegisterMemberDto): Promise<{
    accessToken: string;
    refreshToken: string;
    user: Partial<UserModel>;
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

      const user = await transaction.user.create({
        data: {
          name: name,
          phone: phone,
          contactEmail: login.contactEmail,
          companyId: company.id,
          roleId: null, // role assigned by the owner at approval
          status: UserStatus.PENDING_APPROVAL,
        },
      });
      await this.addFirstLoginMethod(transaction, user.id, login.loginMethod);
      return { user: user, companyId: company.id };
    });

    if (!created) throw new NotFoundException('Invalid join code');
    const { user, companyId } = created;

    const joinRequestedEvent: MemberJoinRequestedEvent = {
      companyId: companyId,
      memberUserId: user.id,
    };
    this.eventEmitter.emit(
      NotificationEvent.MEMBER_JOIN_REQUESTED,
      joinRequestedEvent,
    );

    const tokens = await this.issueSessionFor(user.id);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        status: user.status, // PENDING_APPROVAL
        companyId: user.companyId,
        roleId: user.roleId, // null
      },
    };
  }

  async login(dto: LoginDto) {
    const { email, password } = dto;

    const loginMethod = await this.prisma.userLoginMethod.findFirst({
      where: { email: email, method: 'local' },
      include: {
        user: {
          select: {
            id: true,
            status: true,
            companyId: true,
            roleId: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!loginMethod?.passwordHash)
      throw new UnauthorizedException('Invalid credentials');

    const valid = await this.passwordService.verify(
      loginMethod.passwordHash,
      password,
    );
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const user = loginMethod.user;

    if (user.deletedAt || !CAN_AUTHENTICATE.includes(user.status))
      throw new UnauthorizedException('Account cannot sign in');

    const tokens = await this.issueSessionFor(user.id);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        status: user.status,
        companyId: user.companyId,
        roleId: user.roleId,
      },
    };
  }

  async refresh(dto: RefreshDto) {
    let payload;
    try {
      payload = await this.tokenService.verifyRefresh(dto.refreshToken);
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.tokenService.hashToken(dto.refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: tokenHash },
    });
    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    await this.prisma.refreshToken.update({
      where: { tokenHash: tokenHash },
      data: { revokedAt: new Date() },
    });
    const tokens = await this.issueSessionFor(stored.userId);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async logout(userId: string, dto: LogoutDto) {
    const tokenHash = this.tokenService.hashToken(dto.refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: tokenHash, userId: userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Stop this device showing the user's pushes (only the caller's own token).
    if (dto.deviceToken) {
      await this.devices.unregister(userId, dto.deviceToken);
    }
  }
}
