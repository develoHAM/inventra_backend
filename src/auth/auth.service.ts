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
import { UserStatus } from '../generated/prisma/enums';
import { LoginDto } from './dto/login.dto';
import { CAN_AUTHENTICATE } from './auth.constants';
import { RefreshDto } from './dto/refresh.dto';

@Injectable()
export class AuthService {
  constructor(
    private prismaService: PrismaService,
    private passwordService: PasswordService,
    private tokenService: TokenService,
  ) {}

  private generateJoinCode(): string {
    return 'INV-' + randomBytes(6).toString('hex').toUpperCase();
  }

  private async issueTokens(userId: string) {
    const accessToken = await this.tokenService.signAccess(userId);
    const { token: refreshToken, expiresAt } =
      await this.tokenService.signRefresh(userId);

    await this.prismaService.refreshToken.create({
      data: {
        userId,
        tokenHash: this.tokenService.hashToken(refreshToken),
        expiresAt,
      },
    });

    return { accessToken, refreshToken };
  }

  async register(dto: RegisterDto): Promise<{
    accessToken: string;
    refreshToken: string;
    user: Partial<UserModel>;
  }> {
    const { companyName, taxId, ownerName, ownerEmail, ownerPassword } = dto;

    const emailTakenPromise = this.prismaService.userLoginMethod.findFirst({
      where: { email: ownerEmail },
    });
    const taxIdTakenPromise = this.prismaService.company.findUnique({
      where: { taxId: taxId },
    });

    const [emailTaken, taxIdTaken] = await Promise.all([
      emailTakenPromise,
      taxIdTakenPromise,
    ]);

    if (emailTaken) throw new ConflictException('Email already registered');
    if (taxIdTaken) throw new ConflictException('Tax ID already registered');

    const passwordHash = await this.passwordService.hash(ownerPassword);

    const role = await this.prismaService.role.findUniqueOrThrow({
      where: {
        code: 'OWNER',
      },
    });

    const companyJoinCode = this.generateJoinCode();

    const { user, company } = await this.prismaService.$transaction(
      async (transaction) => {
        const newUser = await transaction.user.create({
          data: {
            name: ownerName,
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
    const { joinCode, email, password, name } = dto;

    const emailTaken = await this.prismaService.userLoginMethod.findFirst({
      where: {
        email: email,
      },
    });

    if (emailTaken) throw new ConflictException('Email already registered');

    const company = await this.prismaService.company.findUnique({
      where: { joinCode },
    });
    if (!company) throw new NotFoundException('Invalid join code');

    const passwordHash = await this.passwordService.hash(password);

    const user = await this.prismaService.user.create({
      data: {
        name,
        companyId: company.id,
        roleId: null, // role assigned by the owner at approval
        status: UserStatus.PENDING_APPROVAL,
        loginMethods: {
          create: { method: 'local', email: email, passwordHash: passwordHash },
        },
      },
    });

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

    const loginMethod = await this.prismaService.userLoginMethod.findFirst({
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

    if (!loginMethod?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await this.passwordService.verify(
      loginMethod.passwordHash,
      password,
    );
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const user = loginMethod.user;

    if (user.deletedAt || !CAN_AUTHENTICATE.includes(user.status)) {
      throw new UnauthorizedException('Account cannot sign in');
    }

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
    const stored = await this.prismaService.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    if (stored.revokedAt) {
      await this.prismaService.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    await this.prismaService.refreshToken.update({
      where: { tokenHash },
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
    await this.prismaService.refreshToken.updateMany({
      where: { tokenHash, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
