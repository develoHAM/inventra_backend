import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OwnershipService } from '../authorization/ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { StorageService } from '../storage/storage.service';
import { randomUUID } from 'crypto';
import { PresignUploadDto } from '../storage/dto/presign-upload.dto';
import { ConfirmUploadDto } from '../storage/dto/confirm-upload.dto';

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly storage: StorageService,
  ) {}

  private logoKey(brandId: number, contentType: string): string {
    const ext = IMAGE_EXT[contentType] ?? 'bin';
    return `brands/${brandId}/${randomUUID()}.${ext}`;
  }

  private async present<T extends { logoUrl: string | null }>(
    brand: T,
  ): Promise<T> {
    if (!brand.logoUrl) return brand;
    return {
      ...brand,
      logoUrl: await this.storage.presignGetUrl(brand.logoUrl),
    };
  }

  private async findOneRaw(caller: AuthUser, id: number) {
    const brand = await this.prisma.brand.findFirst({
      where: {
        id: id,
        ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'),
        deletedAt: null,
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async create(caller: AuthUser, dto: CreateBrandDto) {
    const { companyId: requested, ...data } = dto;
    const createdByCompanyId = this.ownership.resolveCompanyForCreate(
      caller,
      requested,
    );
    return this.prisma.brand.create({
      data: { ...data, createdByCompanyId: createdByCompanyId },
    });
  }

  async findAll(caller: AuthUser) {
    const brands = await this.prisma.brand.findMany({
      where: {
        ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'),
        deletedAt: null,
      },
    });
    return Promise.all(brands.map((brand) => this.present(brand)));
  }

  async findOne(caller: AuthUser, id: number) {
    return this.present(await this.findOneRaw(caller, id));
  }

  findInCompany(brandId: number, companyId: string) {
    return this.prisma.brand.findFirst({
      where: { id: brandId, createdByCompanyId: companyId, deletedAt: null },
    });
  }

  async update(caller: AuthUser, id: number, dto: UpdateBrandDto) {
    await this.findOne(caller, id); // scoped 404
    return this.prisma.brand.update({ where: { id: id }, data: dto });
  }

  async remove(caller: AuthUser, id: number) {
    await this.findOneRaw(caller, id);
    return this.prisma.brand.update({
      where: { id: id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }

  async uploadLogo(caller: AuthUser, id: number, file: Express.Multer.File) {
    const brand = await this.findOneRaw(caller, id);
    const key = this.logoKey(id, file.mimetype);
    await this.storage.putObject(key, file.buffer, file.mimetype);
    if (brand.logoUrl) await this.storage.deleteObject(brand.logoUrl);
    const updated = await this.prisma.brand.update({
      where: {
        id: id,
      },
      data: {
        logoUrl: key,
      },
    });
    return this.present(updated);
  }

  async presignLogoUpload(caller: AuthUser, id: number, dto: PresignUploadDto) {
    await this.findOneRaw(caller, id);
    const key = this.logoKey(id, dto.contentType);
    const uploadUrl = await this.storage.presignPutUrl(key, dto.contentType);
    return { uploadUrl: uploadUrl, key: key };
  }

  async confirmLogo(caller: AuthUser, id: number, dto: ConfirmUploadDto) {
    const brand = await this.findOneRaw(caller, id);
    if (!dto.key.startsWith(`brands/${id}/`))
      throw new BadRequestException('Key does not belong to this brand');
    if (!(await this.storage.objectExists(dto.key)))
      throw new BadRequestException('Uploaded object not found');
    if (brand.logoUrl) await this.storage.deleteObject(brand.logoUrl);
    const updated = await this.prisma.brand.update({
      where: { id: id },
      data: { logoUrl: dto.key },
    });
    return this.present(updated);
  }
}
