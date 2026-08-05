import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OwnershipService } from '../authorization/ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
  ) {}

  async create(caller: AuthUser, dto: CreateBrandDto) {
    if (!caller.companyId) throw new ForbiddenException();
    return this.prisma.brand.create({
      data: { ...dto, createdByCompanyId: caller.companyId },
    });
  }

  async findAll(caller: AuthUser) {
    return this.prisma.brand.findMany({
      where: {
        ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'),
        deletedAt: null,
      },
    });
  }

  async findOne(caller: AuthUser, id: number) {
    const brand = await this.prisma.brand.findFirst({
      where: {
        id,
        ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'),
        deletedAt: null,
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async update(caller: AuthUser, id: number, dto: UpdateBrandDto) {
    await this.findOne(caller, id); // scoped 404
    return this.prisma.brand.update({ where: { id }, data: dto });
  }

  async remove(caller: AuthUser, id: number) {
    await this.findOne(caller, id);
    return this.prisma.brand.update({
      where: { id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }
}
