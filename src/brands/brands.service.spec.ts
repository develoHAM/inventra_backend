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
  let storage: {
    putObject: jest.Mock;
    presignPutUrl: jest.Mock;
    presignGetUrl: jest.Mock;
    objectExists: jest.Mock;
    deleteObject: jest.Mock;
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
    storage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      presignPutUrl: jest.fn().mockResolvedValue('https://minio/presigned-put'),
      presignGetUrl: jest.fn().mockResolvedValue('https://minio/presigned-get'),
      objectExists: jest.fn().mockResolvedValue(true),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    // OwnershipService is pure — use a real one; constructor: (prisma, ownership, storage)
    service = new BrandsService(
      prisma as any,
      new OwnershipService(),
      storage as any,
    );
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

  describe('logo upload', () => {
    const brandId = 7;

    it('uploadLogo stores under brands/<id>/<uuid>.<ext>, deletes the old, sets logoUrl', async () => {
      prisma.brand.findFirst.mockResolvedValue({
        id: brandId,
        createdByCompanyId: 'company-1',
        logoUrl: 'brands/old.jpg',
      });
      prisma.brand.update.mockResolvedValue({ id: brandId, logoUrl: 'k' });

      await service.uploadLogo(owner, brandId, {
        buffer: Buffer.from('x'),
        mimetype: 'image/png',
      } as any);

      const putKey = storage.putObject.mock.calls[0][0];
      expect(putKey).toMatch(new RegExp(`^brands/${brandId}/[0-9a-f-]+\\.png$`));
      expect(storage.putObject).toHaveBeenCalledWith(
        putKey,
        expect.any(Buffer),
        'image/png',
      );
      expect(storage.deleteObject).toHaveBeenCalledWith('brands/old.jpg');
      expect(prisma.brand.update).toHaveBeenCalledWith({
        where: { id: brandId },
        data: { logoUrl: putKey },
      });
    });

    it('presignLogoUpload returns an upload URL + key without touching the brand', async () => {
      prisma.brand.findFirst.mockResolvedValue({
        id: brandId,
        createdByCompanyId: 'company-1',
        logoUrl: null,
      });

      const res = await service.presignLogoUpload(owner, brandId, {
        contentType: 'image/jpeg',
      } as any);

      expect(res.key).toMatch(new RegExp(`^brands/${brandId}/[0-9a-f-]+\\.jpg$`));
      expect(res.uploadUrl).toBe('https://minio/presigned-put');
      expect(prisma.brand.update).not.toHaveBeenCalled();
    });

    it('confirmLogo rejects a key not under this brand (400)', async () => {
      prisma.brand.findFirst.mockResolvedValue({
        id: brandId,
        createdByCompanyId: 'company-1',
        logoUrl: null,
      });

      await expect(
        service.confirmLogo(owner, brandId, { key: 'brands/8/x.jpg' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(storage.objectExists).not.toHaveBeenCalled();
    });

    it('confirmLogo rejects a key whose object is missing (400)', async () => {
      prisma.brand.findFirst.mockResolvedValue({
        id: brandId,
        createdByCompanyId: 'company-1',
        logoUrl: null,
      });
      storage.objectExists.mockResolvedValue(false);

      await expect(
        service.confirmLogo(owner, brandId, {
          key: `brands/${brandId}/x.jpg`,
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.brand.update).not.toHaveBeenCalled();
    });

    it('confirmLogo sets logoUrl and returns a presented (presigned) brand', async () => {
      prisma.brand.findFirst.mockResolvedValue({
        id: brandId,
        createdByCompanyId: 'company-1',
        logoUrl: null,
      });
      prisma.brand.update.mockResolvedValue({
        id: brandId,
        logoUrl: `brands/${brandId}/x.jpg`,
      });

      const res = await service.confirmLogo(owner, brandId, {
        key: `brands/${brandId}/x.jpg`,
      } as any);

      expect(prisma.brand.update).toHaveBeenCalledWith({
        where: { id: brandId },
        data: { logoUrl: `brands/${brandId}/x.jpg` },
      });
      expect(res.logoUrl).toBe('https://minio/presigned-get');
    });

    it('findOne presents the stored key as a presigned URL', async () => {
      prisma.brand.findFirst.mockResolvedValue({
        id: brandId,
        createdByCompanyId: 'company-1',
        logoUrl: 'brands/k.jpg',
      });

      const res = await service.findOne(owner, brandId);

      expect(res.logoUrl).toBe('https://minio/presigned-get');
      expect(storage.presignGetUrl).toHaveBeenCalledWith('brands/k.jpg');
    });
  });
});
