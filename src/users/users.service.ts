import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser } from '../auth/types/auth-user';
import { ApproveMemberDto } from './dto/approve-member.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UserStatus } from '../generated/prisma/enums';
import { OwnershipService } from '../authorization/ownership.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
  ) {}

  async approveMember(
    caller: AuthUser,
    targetUserId: string,
    dto: ApproveMemberDto,
  ) {
    const target = await this.prisma.user.findFirst({
      where: {
        id: targetUserId,
        ...this.ownership.scopeToCompany(caller),
      },
    });
    if (!target) throw new NotFoundException('Member not found');

    if (target.status !== UserStatus.PENDING_APPROVAL)
      throw new BadRequestException('Member is not pending approval');

    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role || !['MANAGER', 'STAFF'].includes(role.code))
      throw new BadRequestException('Invalid role for a member');

    return this.prisma.user.update({
      where: { id: target.id },
      data: { roleId: dto.roleId, status: UserStatus.ACTIVE },
    });
  }

  async approveCompany(companyId: string) {
    const owner = await this.prisma.user.findFirst({
      where: { companyId: companyId, role: { code: 'OWNER' } },
    });

    if (!owner) throw new NotFoundException('Company owner not found');

    if (owner.status !== UserStatus.PENDING_APPROVAL)
      throw new BadRequestException('Owner is not pending approval');

    return this.prisma.user.update({
      where: { id: owner.id },
      data: { status: UserStatus.ACTIVE },
    });
  }

  async findActiveMember(userId: string, companyId: string) {
    return this.prisma.user.findFirst({
      where: {
        id: userId,
        companyId: companyId,
        deletedAt: null,
        status: UserStatus.ACTIVE,
      },
      include: {
        role: true,
      },
    });
  }
}
