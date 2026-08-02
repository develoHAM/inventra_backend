import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDTO } from './dto/update-category.dto';
import { AuthUser } from '../auth/types/auth-user';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

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

  async update(id: number, dto: UpdateCategoryDTO) {
    await this.findOne(id);
    return this.prisma.category.update({ where: { id: id }, data: dto });
  }

  async remove(caller: AuthUser, id: number) {
    await this.findOne(id);
    return this.prisma.category.update({
      where: { id: id },
      data: {
        deletedAt: new Date(),
        deletedByUserId: caller.id,
      },
    });
  }
}
