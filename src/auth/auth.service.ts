import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { RegisterDto } from './dto/register.dto';
import { randomBytes } from 'node:crypto';
import { UserModel } from '../generated/prisma/models';

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
}
