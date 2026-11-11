import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

describe('CompaniesService', () => {
  let service: CompaniesService;
  let prisma: {
    company: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    user: { findFirst: jest.Mock; update: jest.Mock };
  };
  let history: { page: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

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
        findFirst: jest.fn().mockResolvedValue({ joinCode: '48291307' }),
        // null = "no company uses this code" (the uniqueness check)
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    history = {
      page: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    eventEmitter = { emit: jest.fn().mockReturnValue(true) };
    // constructor order: (prisma, history, eventEmitter)
    service = new CompaniesService(
      prisma as any,
      history as any,
      eventEmitter as any,
    );
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

  // moved unchanged from users.service.spec.ts (2026-10-03)
  describe('approveCompany', () => {
    it('activates the company owner', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.PENDING_APPROVAL,
      });

      await service.approveCompany('company-1');

      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { companyId: 'company-1', role: { code: 'OWNER' } },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'owner-1' },
        data: { status: UserStatus.ACTIVE },
      });
    });

    it('emits company.approved with the ids, only after the owner is activated', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.PENDING_APPROVAL,
      });
      prisma.user.update.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.ACTIVE,
      });

      const result = await service.approveCompany('company-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.COMPANY_APPROVED,
        { companyId: 'company-1', ownerUserId: 'owner-1' },
      );
      // emit-after-commit: never announce an approval before it's written
      expect(prisma.user.update.mock.invocationCallOrder[0]).toBeLessThan(
        eventEmitter.emit.mock.invocationCallOrder[0],
      );
      // the caller still gets the updated owner back, unchanged by the emit
      expect(result).toEqual({ id: 'owner-1', status: UserStatus.ACTIVE });
    });

    it('does not emit when the owner update fails', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.PENDING_APPROVAL,
      });
      prisma.user.update.mockRejectedValue(new Error('db down'));

      await expect(service.approveCompany('company-1')).rejects.toThrow(
        'db down',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('returns 404 when the company has no owner', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.approveCompany('company-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rejects approving an owner who is not PENDING (and emits nothing)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'owner-1',
        status: UserStatus.ACTIVE,
      });

      await expect(service.approveCompany('company-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('listHistory', () => {
    const QUERY = { limit: 20 };
    const PAGE = { items: [], nextCursor: null };
    const manager: AuthUser = {
      id: 'manager-1',
      companyId: 'company-1',
      companyStoreId: 'corner-a',
      roleId: 3,
      roleCode: 'MANAGER',
      status: UserStatus.ACTIVE,
    };
    const staff: AuthUser = {
      id: 'staff-1',
      companyId: 'company-1',
      companyStoreId: 'corner-a',
      roleId: 4,
      roleCode: 'STAFF',
      status: UserStatus.ACTIVE,
    };

    beforeEach(() => {
      prisma.company.findFirst.mockResolvedValue({ id: 'company-1' });
      history.page.mockResolvedValue(PAGE);
    });

    it("an owner reads their own company's feed", async () => {
      await expect(
        service.listHistory(owner, 'company-1', QUERY),
      ).resolves.toBe(PAGE);

      expect(prisma.company.findFirst).toHaveBeenCalledWith({
        where: { id: 'company-1', deletedAt: null },
        select: { id: true },
      });
      expect(history.page).toHaveBeenCalledWith(
        { companyId: 'company-1' },
        QUERY,
      );
    });

    it("another company is 404 for an owner, not 403: we don't confirm it exists", async () => {
      await expect(
        service.listHistory(owner, 'company-2', QUERY),
      ).rejects.toThrow(NotFoundException);
      expect(history.page).not.toHaveBeenCalled();
    });

    it('the admin reads any company that exists', async () => {
      prisma.company.findFirst.mockResolvedValue({ id: 'company-2' });

      await service.listHistory(admin, 'company-2', QUERY);

      expect(prisma.company.findFirst).toHaveBeenCalledWith({
        where: { id: 'company-2', deletedAt: null },
        select: { id: true },
      });
      expect(history.page).toHaveBeenCalledWith(
        { companyId: 'company-2' },
        QUERY,
      );
    });

    it('a company that does not exist, or was closed, is 404 even for the admin', async () => {
      prisma.company.findFirst.mockResolvedValue(null);

      await expect(
        service.listHistory(admin, 'company-9', QUERY),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.listHistory(owner, 'company-1', QUERY),
      ).rejects.toThrow(NotFoundException);
      expect(history.page).not.toHaveBeenCalled();
    });

    it("managers and staff cannot read their own company's feed (403)", async () => {
      await expect(
        service.listHistory(manager, 'company-1', QUERY),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.listHistory(staff, 'company-1', QUERY),
      ).rejects.toThrow(ForbiddenException);
      expect(history.page).not.toHaveBeenCalled();
    });

    it('a manager asking about another company gets 404: the 404 comes before the 403', async () => {
      await expect(
        service.listHistory(manager, 'company-2', QUERY),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
