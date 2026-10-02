import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RegisterDto } from './dto/register.dto';
import { randomBytes } from 'node:crypto';
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly eventEmitter: EventEmitter2,
    private readonly phoneVerification: PhoneVerificationService,
  ) {}

  private generateJoinCode(): string {
    return 'INV-' + randomBytes(6).toString('hex').toUpperCase();
  }

  private async issueTokens(userId: string) {
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

  async register(dto: RegisterDto): Promise<{
    accessToken: string;
    refreshToken: string;
    user: Partial<UserModel>;
  }> {
    const {
      companyName,
      taxId,
      ownerName,
      ownerEmail,
      ownerPassword,
      ownerPhone,
      ownerPhoneVerificationToken,
    } = dto;

    const [emailTaken, taxIdTaken, phoneTaken] = await Promise.all([
      this.prisma.userLoginMethod.findFirst({ where: { email: ownerEmail } }),
      this.prisma.company.findUnique({ where: { taxId: taxId } }),
      this.findPhoneOwner(ownerPhone),
    ]);

    if (emailTaken) throw new ConflictException('Email already registered');
    if (taxIdTaken) throw new ConflictException('Tax ID already registered');
    if (phoneTaken) throw new ConflictException('Phone already registered');

    const passwordHash = await this.passwordService.hash(ownerPassword);

    const role = await this.prisma.role.findUniqueOrThrow({
      where: {
        code: 'OWNER',
      },
    });

    const companyJoinCode = this.generateJoinCode();

    const { user, company } = await this.prisma.$transaction(
      async (transaction) => {
        // Spend the proof first: if anything below fails, this rolls back too.
        await this.phoneVerification.consume(transaction, {
          token: ownerPhoneVerificationToken,
          phone: ownerPhone,
          purpose: PhoneVerificationPurpose.SIGNUP,
        });

        const newUser = await transaction.user.create({
          data: {
            name: ownerName,
            phone: ownerPhone,
            companyId: null,
            status: 'PENDING_APPROVAL',
            roleId: role.id,
            loginMethods: {
              create: {
                method: 'local',
                email: ownerEmail,
                passwordHash: passwordHash,
              },
            },
          },
        });

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

    const tokens = await this.issueTokens(user.id);

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
    const { joinCode, email, password, name, phone, phoneVerificationToken } =
      dto;

    const [emailTaken, phoneTaken] = await Promise.all([
      this.prisma.userLoginMethod.findFirst({ where: { email: email } }),
      this.findPhoneOwner(phone),
    ]);

    if (emailTaken) throw new ConflictException('Email already registered');
    if (phoneTaken) throw new ConflictException('Phone already registered');

    const company = await this.prisma.company.findUnique({
      where: { joinCode: joinCode },
    });
    if (!company) throw new NotFoundException('Invalid join code');

    const passwordHash = await this.passwordService.hash(password);

    // Two writes that must succeed or fail together: spend the proof, create the member.
    const user = await this.prisma.$transaction(async (transaction) => {
      await this.phoneVerification.consume(transaction, {
        token: phoneVerificationToken,
        phone: phone,
        purpose: PhoneVerificationPurpose.SIGNUP,
      });

      return transaction.user.create({
        data: {
          name: name,
          phone: phone,
          companyId: company.id,
          roleId: null, // role assigned by the owner at approval
          status: UserStatus.PENDING_APPROVAL,
          loginMethods: {
            create: {
              method: 'local',
              email: email,
              passwordHash: passwordHash,
            },
          },
        },
      });
    });

    const joinRequestedEvent: MemberJoinRequestedEvent = {
      companyId: company.id,
      memberUserId: user.id,
    };
    this.eventEmitter.emit(
      NotificationEvent.MEMBER_JOIN_REQUESTED,
      joinRequestedEvent,
    );

    const tokens = await this.issueTokens(user.id);

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

    const tokens = await this.issueTokens(user.id);

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
    const tokens = await this.issueTokens(stored.userId);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async logout(userId: string, dto: RefreshDto) {
    const tokenHash = this.tokenService.hashToken(dto.refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: tokenHash, userId: userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
