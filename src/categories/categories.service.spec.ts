import { NotFoundException } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('CategoriesService', () => {
  let service: CategoriesService;
  let prisma: {
    category: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };

  const admin: AuthUser = {
    id: 'admin-1',
    companyId: null,
    roleId: 1,
    roleCode: 'ADMIN',
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      category: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    service = new CategoriesService(prisma as any);
  });

  it('findAll excludes soft-deleted categories', async () => {
    await service.findAll();
    expect(prisma.category.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
    });
  });

  it('findOne returns the category when present', async () => {
    prisma.category.findFirst.mockResolvedValue({ id: 5, name: 'Drinks' });

    await expect(service.findOne(5)).resolves.toEqual({ id: 5, name: 'Drinks' });
    expect(prisma.category.findFirst).toHaveBeenCalledWith({
      where: { id: 5, deletedAt: null },
    });
  });

  it('findOne throws 404 for an absent or deleted id', async () => {
    prisma.category.findFirst.mockResolvedValue(null);
    await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
  });

  it('remove soft-deletes and stamps the deleter', async () => {
    prisma.category.findFirst.mockResolvedValue({ id: 5 });

    await service.remove(admin, 5);

    expect(prisma.category.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { deletedAt: expect.any(Date), deletedByUserId: 'admin-1' },
    });
  });

  it('update 404s an absent id before writing', async () => {
    prisma.category.findFirst.mockResolvedValue(null);

    await expect(
      service.update(999, { name: 'x' } as any),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.category.update).not.toHaveBeenCalled();
  });
});
