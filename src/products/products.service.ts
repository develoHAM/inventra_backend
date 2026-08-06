import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OwnershipService } from '../authorization/ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { CategoriesService } from '../categories/categories.service';
import { BrandsService } from '../brands/brands.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly categories: CategoriesService,
    private readonly brands: BrandsService,
  ) {}

  private async assertBarcodeAvailable(barcode: string, excludeId?: string) {
    const dup = await this.prisma.product.findFirst({
      where: { barcode, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });

    if (dup) throw new ConflictException('Barcode already exists');
  }

  async create(caller: AuthUser, dto: CreateProductDto) {
    const { companyId: requested, ...data } = dto;
    const companyId = this.ownership.resolveCompanyForCreate(caller, requested);

    const brand = await this.brands.findInCompany(data.brandId, companyId);
    if (!brand) throw new BadRequestException('Invalid brand');

    const category = await this.categories.findActive(data.categoryId);
    if (!category) throw new BadRequestException('Invalid category');

    await this.assertBarcodeAvailable(data.barcode); // barcode stays here — products' own table

    return this.prisma.product.create({
      data: {
        ...data,
        companyId: companyId,
        createdByUserId: caller.id,
      },
    });
  }

  findAll(caller: AuthUser) {
    return this.prisma.product.findMany({
      where: { ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
  }

  async findOne(caller: AuthUser, id: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async update(caller: AuthUser, id: string, dto: UpdateProductDto) {
    const product = await this.findOne(caller, id);

    if (dto.brandId !== undefined) {
      const brand = await this.brands.findInCompany(
        dto.brandId,
        product.companyId,
      );
      if (!brand) throw new BadRequestException('Invalid brand');
    }
    if (dto.categoryId !== undefined) {
      const category = await this.categories.findActive(dto.categoryId);
      if (!category) throw new BadRequestException('Invalid category');
    }
    if (dto.barcode !== undefined)
      await this.assertBarcodeAvailable(dto.barcode, id);

    return this.prisma.product.update({ where: { id }, data: dto });
  }

  async remove(caller: AuthUser, id: string) {
    const product = await this.findOne(caller, id);
    if (
      caller.roleCode === 'MANAGER' &&
      product.createdByUserId !== caller.id
    ) {
      throw new ForbiddenException('You can only delete products you created');
    }
    return this.prisma.product.update({
      where: { id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }
}
