import {
  BadRequestException,
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
}
