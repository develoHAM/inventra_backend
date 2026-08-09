import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import { AuthUser } from '../auth/types/auth-user';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateStoreDto) {
    return this.prisma.store.create({
      data: dto,
    });
  }

  async findAll() {
    return this.prisma.store.findMany({
      where: {
        deletedAt: null,
      },
    });
  }

  async findOne(id: string) {
    const store = await this.findActive(id);
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async findActive(id: string) {
    return this.prisma.store.findFirst({ where: { id, deletedAt: null } });
  }

  async update(id: string, dto: UpdateStoreDto) {
    await this.findOne(id);
    return this.prisma.store.update({ where: { id }, data: dto });
  }

  async remove(caller: AuthUser, id: string) {
    await this.findOne(id);
    return this.prisma.store.update({
      where: { id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }
}
