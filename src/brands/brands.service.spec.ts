import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BrandsService } from './brands.service';
import { OwnershipService } from '../authorization/ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('BrandsService', () => {
  let service: BrandsService;
  let prisma: {
    brand: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };

  const owner: AuthUser = {
    id: 'owner-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: UserStatus.ACTIVE,
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
      brand: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    // OwnershipService is pure — use a real one
    service = new BrandsService(prisma as any, new OwnershipService());
  });

  it('create sets createdByCompanyId to the caller company', async () => {
    await service.create(owner, { name: 'Acme' } as any);
    expect(prisma.brand.create).toHaveBeenCalledWith({
      data: { name: 'Acme', createdByCompanyId: 'company-1' },
    });
  });

  it('lets ADMIN create a brand for a supplied companyId', async () => {
    await service.create(admin, { name: 'Acme', companyId: 'company-9' } as any);
    expect(prisma.brand.create).toHaveBeenCalledWith({
      data: { name: 'Acme', createdByCompanyId: 'company-9' },
    });
  });

  it('rejects ADMIN create without a companyId (400)', async () => {
    await expect(
      service.create(admin, { name: 'Acme' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.brand.create).not.toHaveBeenCalled();
  });

  it('findAll scopes to the caller company', async () => {
    await service.findAll(owner);
    expect(prisma.brand.findMany).toHaveBeenCalledWith({
      where: { createdByCompanyId: 'company-1', deletedAt: null },
    });
  });

  it('findAll for ADMIN spans all companies (no company filter)', async () => {
    await service.findAll(admin);
    expect(prisma.brand.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
    });
  });

  it('findOne 404s an absent / cross-tenant brand and scopes the lookup', async () => {
    prisma.brand.findFirst.mockResolvedValue(null);

    await expect(service.findOne(owner, 99)).rejects.toThrow(NotFoundException);
    expect(prisma.brand.findFirst).toHaveBeenCalledWith({
      where: { id: 99, createdByCompanyId: 'company-1', deletedAt: null },
    });
  });

  it('remove soft-deletes and stamps the deleter', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 5 });

    await service.remove(owner, 5);

    expect(prisma.brand.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { deletedAt: expect.any(Date), deletedByUserId: 'owner-1' },
    });
  });
});
