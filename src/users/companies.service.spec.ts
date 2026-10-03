import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('CompaniesService', () => {
  let service: CompaniesService;
  let prisma: {
    company: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  const owner: AuthUser = {
    id: 'owner-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: UserStatus.ACTIVE,
  };
  // the platform admin belongs to no company
  const admin: AuthUser = {
    id: 'admin-1',
    companyId: null,
    roleId: 1,
    roleCode: 'ADMIN',
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      company: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ joinCode: '48291307' }),
        // null = "no company uses this code" (the uniqueness check)
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new CompaniesService(prisma as any);
  });

  describe('getJoinCode', () => {
    it("returns the caller's own company's code", async () => {
      await expect(service.getJoinCode(owner)).resolves.toEqual({
        joinCode: '48291307',
      });
      expect(prisma.company.findFirst).toHaveBeenCalledWith({
        where: { id: 'company-1', deletedAt: null },
        select: { joinCode: true },
      });
    });

    it('refuses a caller with no company (403) without querying', async () => {
      await expect(service.getJoinCode(admin)).rejects.toThrow(
        new ForbiddenException('You do not belong to a company'),
      );
      expect(prisma.company.findFirst).not.toHaveBeenCalled();
    });

    it('404s when the company is gone (deleted)', async () => {
      prisma.company.findFirst.mockResolvedValue(null);

      await expect(service.getJoinCode(owner)).rejects.toThrow(
        new NotFoundException('Company not found'),
      );
    });
  });

  describe('rotateJoinCode', () => {
    it("writes a fresh unused 8-digit code to the caller's own (non-deleted) company and returns it", async () => {
      const result = await service.rotateJoinCode(owner);

      expect(result.joinCode).toMatch(/^\d{8}$/);
      // the new code was checked against existing companies first
      expect(prisma.company.findUnique).toHaveBeenCalledWith({
        where: { joinCode: result.joinCode },
        select: { id: true },
      });
      expect(prisma.company.updateMany).toHaveBeenCalledWith({
        where: { id: 'company-1', deletedAt: null },
        data: { joinCode: result.joinCode }, // the response is exactly what was stored
      });
    });

    it('produces a new code on every rotation', async () => {
      const first = await service.rotateJoinCode(owner);
      const second = await service.rotateJoinCode(owner);

      expect(first.joinCode).not.toBe(second.joinCode);
    });

    it('refuses a caller with no company (403) without writing', async () => {
      await expect(service.rotateJoinCode(admin)).rejects.toThrow(
        new ForbiddenException('You do not belong to a company'),
      );
      expect(prisma.company.updateMany).not.toHaveBeenCalled();
    });

    it('404s when no row was updated (company deleted)', async () => {
      prisma.company.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.rotateJoinCode(owner)).rejects.toThrow(
        new NotFoundException('Company not found'),
      );
    });
  });
});
