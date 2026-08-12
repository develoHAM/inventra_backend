import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OwnershipService } from '../authorization/ownership.service';
import { StoresService } from '../stores/stores.service';
import { UsersService } from '../users/users.service';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateCornerDto } from './dto/create-corner.dto';
import { UpdateCornerDto } from './dto/update-corner.dto';
import { AssignUserDto } from './dto/assign-user.dto';

@Injectable()
export class CornersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly stores: StoresService,
    private readonly users: UsersService,
  ) {}

  private async resolveManager(userId: string, companyId: string) {
    const user = await this.users.findActiveMember(userId, companyId);
    if (!user || user.role?.code !== 'MANAGER')
      throw new BadRequestException(
        'Manager must be an active MANAGER in the company',
      );
    return user;
  }

  private assertCanManageStaff(
    caller: AuthUser,
    corner: { managerUserId: string | null },
  ) {
    if (caller.roleCode === 'MANAGER' && corner.managerUserId !== caller.id)
      throw new ForbiddenException(
        'You can only manage staff of corners you manage',
      );
    // OWNER / ADMIN pass through
  }

  async create(caller: AuthUser, dto: CreateCornerDto) {
    const { companyId: requested, managerUserId, ...data } = dto;
    const companyId = this.ownership.resolveCompanyForCreate(caller, requested);

    const store = await this.stores.findActive(data.storeId);
    if (!store) throw new BadRequestException('Invalid store');

    if (managerUserId) await this.resolveManager(managerUserId, companyId);

    return this.prisma.companyStore.create({
      data: { ...data, companyId, managerUserId: managerUserId ?? null },
    });
  }

  async findAll(caller: AuthUser) {
    return this.prisma.companyStore.findMany({
      where: { ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
  }

  async findOne(caller: AuthUser, id: string) {
    const corner = await this.prisma.companyStore.findFirst({
      where: { id, ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
    if (!corner) throw new NotFoundException('Corner not found');
    return corner;
  }

  async update(caller: AuthUser, id: string, dto: UpdateCornerDto) {
    await this.findOne(caller, id);
    return this.prisma.companyStore.update({ where: { id }, data: dto });
  }

  async remove(caller: AuthUser, id: string) {
    await this.findOne(caller, id);
    return this.prisma.companyStore.update({
      where: { id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }

  async assignManager(caller: AuthUser, cornerId: string, dto: AssignUserDto) {
    const corner = await this.findOne(caller, cornerId); // scoped → 404
    if (caller.roleCode === 'MANAGER')
      throw new ForbiddenException('Only an owner can appoint a manager');
    await this.resolveManager(dto.userId, corner.companyId); // 400 if ineligible
    return this.prisma.companyStore.update({
      where: { id: cornerId },
      data: { managerUserId: dto.userId },
    });
  }

  async addStaff(caller: AuthUser, cornerId: string, dto: AssignUserDto) {
    const corner = await this.findOne(caller, cornerId);
    this.assertCanManageStaff(caller, corner);
    const member = await this.users.findActiveMember(
      dto.userId,
      corner.companyId,
    );
    if (!member)
      throw new BadRequestException(
        'Staff must be an active member of the company',
      );
    return this.prisma.user.update({
      where: { id: dto.userId },
      data: { companyStoreId: cornerId },
    });
  }

  async removeStaff(caller: AuthUser, cornerId: string, userId: string) {
    const corner = await this.findOne(caller, cornerId);
    this.assertCanManageStaff(caller, corner);
    const staff = await this.prisma.user.findFirst({
      where: { id: userId, companyStoreId: cornerId },
    });
    if (!staff) throw new NotFoundException('User is not staff of this corner');
    return this.prisma.user.update({
      where: { id: userId },
      data: { companyStoreId: null },
    });
  }
}
