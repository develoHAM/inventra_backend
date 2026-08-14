import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CornersService } from '../corners/corners.service';
import { ProductsService } from '../products/products.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreatePlacementDto } from './dto/create-placement.dto';
import { UpdatePlacementDto } from './dto/update-placement.dto';

@Injectable()
export class PlacementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
    private readonly products: ProductsService,
  ) {}

  private async getPlacement(cornerId: string, placementId: number) {
    const placement = await this.prisma.companyStoreProduct.findFirst({
      where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
    });
    if (!placement) throw new NotFoundException('Placement not found');
    return placement;
  }

  async create(caller: AuthUser, cornerId: string, dto: CreatePlacementDto) {
    const corner = await this.corners.assertWorksCorner(caller, cornerId); // 404/403
    const { productId, ...fields } = dto;

    const product = await this.products.findInCompany(
      productId,
      corner.companyId,
    );
    if (!product) throw new BadRequestException('Invalid product');

    const existing = await this.prisma.companyStoreProduct.findFirst({
      where: { productId: productId, companyStoreId: cornerId }, // includes soft-deleted
    });
    if (existing && !existing.deletedAt)
      throw new ConflictException('Product already placed on this corner');
    if (existing)
      return this.prisma.companyStoreProduct.update({
        where: { id: existing.id },
        data: { ...fields, deletedAt: null, deletedByUserId: null },
      });

    return this.prisma.companyStoreProduct.create({
      data: { ...fields, companyStoreId: cornerId, productId: productId },
    });
  }

  async findAll(caller: AuthUser, cornerId: string) {
    await this.corners.findOne(caller, cornerId); // read scope → 404
    return this.prisma.companyStoreProduct.findMany({
      where: { companyStoreId: cornerId, deletedAt: null },
    });
  }

  async findOne(caller: AuthUser, cornerId: string, placementId: number) {
    await this.corners.findOne(caller, cornerId); // read scope → 404
    return this.getPlacement(cornerId, placementId);
  }

  async update(
    caller: AuthUser,
    cornerId: string,
    placementId: number,
    dto: UpdatePlacementDto,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId); // write scope → 404/403
    await this.getPlacement(cornerId, placementId);
    return this.prisma.companyStoreProduct.update({
      where: { id: placementId },
      data: dto,
    });
  }

  async remove(caller: AuthUser, cornerId: string, placementId: number) {
    await this.corners.assertWorksCorner(caller, cornerId);
    await this.getPlacement(cornerId, placementId);
    return this.prisma.companyStoreProduct.update({
      where: { id: placementId },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }
}
