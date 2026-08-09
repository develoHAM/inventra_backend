import { NotFoundException } from '@nestjs/common';
import { StoresService } from './stores.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('StoresService', () => {
  let service: StoresService;
  let prisma: {
    store: {
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
      store: {
        create: jest.fn().mockResolvedValue({ id: 's1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    service = new StoresService(prisma as any);
  });

  it('create passes the dto straight through', async () => {
    await service.create({ name: 'Lotte' } as any);
    expect(prisma.store.create).toHaveBeenCalledWith({ data: { name: 'Lotte' } });
  });

  it('findAll filters out soft-deleted rows', async () => {
    await service.findAll();
    expect(prisma.store.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
    });
  });

  it('findOne 404s an absent / deleted store and scopes to non-deleted', async () => {
    prisma.store.findFirst.mockResolvedValue(null);
    await expect(service.findOne('s9')).rejects.toThrow(NotFoundException);
    expect(prisma.store.findFirst).toHaveBeenCalledWith({
      where: { id: 's9', deletedAt: null },
    });
  });

  it('findActive returns the row or null without throwing', async () => {
    prisma.store.findFirst.mockResolvedValue(null);
    expect(await service.findActive('s9')).toBeNull();
  });

  it('remove soft-deletes and stamps the deleter', async () => {
    prisma.store.findFirst.mockResolvedValue({ id: 's1' });

    await service.remove(admin, 's1');

    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { deletedAt: expect.any(Date), deletedByUserId: 'admin-1' },
    });
  });
});
