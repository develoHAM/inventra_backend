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
import { StorageService } from '../storage/storage.service';
import { randomUUID } from 'node:crypto';
import { ConfirmImageDto } from './dto/confirm-image.dto';
import { PresignImageDto } from './dto/presign-image.dto';

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly categories: CategoriesService,
    private readonly brands: BrandsService,
    private readonly storage: StorageService,
  ) {}

  private async assertBarcodeAvailable(barcode: string, excludeId?: string) {
    const dup = await this.prisma.product.findFirst({
      where: {
        barcode: barcode,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });

    if (dup) throw new ConflictException('Barcode already exists');
  }

  private imageKey(productId: string, contentType: string): string {
    const ext = IMAGE_EXT[contentType] ?? 'bin';
    return `products/${productId}/${randomUUID()}.${ext}`;
  }

  private async present<T extends { imageUrl: string | null }>(
    product: T,
  ): Promise<T> {
    if (!product.imageUrl) return product;
    return {
      ...product,
      imageUrl: await this.storage.presignGetUrl(product.imageUrl),
    };
  }

  private async findOneRaw(caller: AuthUser, id: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        id: id,
        ...this.ownership.scopeToCompany(caller),
        deletedAt: null,
      },
    });

    if (!product) throw new NotFoundException('Product not found');
    return product;
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

  async findAll(caller: AuthUser) {
    const products = await this.prisma.product.findMany({
      where: { ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
    return Promise.all(products.map((p) => this.present(p)));
  }

  async findOne(caller: AuthUser, id: string) {
    return this.present(await this.findOneRaw(caller, id));
  }

  findInCompany(productId: string, companyId: string) {
    return this.prisma.product.findFirst({
      where: { id: productId, companyId: companyId, deletedAt: null },
    });
  }

  async update(caller: AuthUser, id: string, dto: UpdateProductDto) {
    const product = await this.findOneRaw(caller, id);

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

    return this.prisma.product.update({ where: { id: id }, data: dto });
  }

  async remove(caller: AuthUser, id: string) {
    const product = await this.findOneRaw(caller, id);
    if (
      caller.roleCode === 'MANAGER' &&
      product.createdByUserId !== caller.id
    ) {
      throw new ForbiddenException('You can only delete products you created');
    }
    return this.prisma.product.update({
      where: { id: id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }

  async uploadImage(caller: AuthUser, id: string, file: Express.Multer.File) {
    const product = await this.findOneRaw(caller, id);
    const key = this.imageKey(id, file.mimetype);
    await this.storage.putObject(key, file.buffer, file.mimetype);
    if (product.imageUrl) await this.storage.deleteObject(product.imageUrl);
    const updated = await this.prisma.product.update({
      where: { id: id },
      data: { imageUrl: key },
    });
    return this.present(updated);
  }

  async presignImageUpload(caller: AuthUser, id: string, dto: PresignImageDto) {
    await this.findOneRaw(caller, id);
    const key = this.imageKey(id, dto.contentType);
    const uploadUrl = await this.storage.presignPutUrl(key, dto.contentType);
    return { uploadUrl: uploadUrl, key: key };
  }

  async confirmImage(caller: AuthUser, id: string, dto: ConfirmImageDto) {
    const product = await this.findOneRaw(caller, id);
    if (!dto.key.startsWith(`products/${id}/`))
      throw new BadRequestException('Key does not belong to this product');
    if (!(await this.storage.objectExists(dto.key)))
      throw new BadRequestException('Uploaded object not found');
    if (product.imageUrl) await this.storage.deleteObject(product.imageUrl);
    const updated = await this.prisma.product.update({
      where: { id: id },
      data: { imageUrl: dto.key },
    });
    return this.present(updated);
  }
}
