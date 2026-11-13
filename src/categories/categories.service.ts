import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDTO } from './dto/update-category.dto';
import { AuthProfile } from '../auth/types/auth-profile';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCategoryDto) {
    return this.prisma.category.create({
      data: dto,
    });
  }

  async findAll() {
    return this.prisma.category.findMany({
      where: {
        deletedAt: null,
      },
    });
  }

  async findOne(id: number) {
    const category = await this.prisma.category.findFirst({
      where: {
        id: id,
        deletedAt: null,
      },
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  async findActive(id: number) {
    const category = await this.prisma.category.findFirst({
      where: {
        id: id,
        deletedAt: null,
      },
    });

    return category;
  }

  async update(id: number, dto: UpdateCategoryDTO) {
    await this.findOne(id);
    return this.prisma.category.update({ where: { id: id }, data: dto });
  }

  async remove(caller: AuthProfile, id: number) {
    await this.findOne(id);
    return this.prisma.category.update({
      where: { id: id },
      data: {
        deletedAt: new Date(),
        deletedByProfileId: caller.id,
      },
    });
  }
}
