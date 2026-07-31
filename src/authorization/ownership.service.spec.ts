import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OwnershipService } from './ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('OwnershipService', () => {
  let service: OwnershipService;

  const member: AuthUser = {
    id: 'u1',
    companyId: 'company-1',
    roleId: 3,
    roleCode: 'MANAGER',
    status: UserStatus.ACTIVE,
  };
  const admin: AuthUser = {
    id: 'admin',
    companyId: null,
    roleId: 1,
    roleCode: 'ADMIN',
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    service = new OwnershipService();
  });

  describe('scopeToCompany', () => {
    it('scopes a regular caller to their own company', () => {
      expect(service.scopeToCompany(member)).toEqual({ companyId: 'company-1' });
    });

    it('returns an empty scope for ADMIN (all companies)', () => {
      expect(service.scopeToCompany(admin)).toEqual({});
    });

    it('throws 403 for a non-admin caller with no company', () => {
      expect(() =>
        service.scopeToCompany({ ...member, companyId: null }),
      ).toThrow(ForbiddenException);
    });
  });

  describe('assertOwns', () => {
    it('passes when the resource is in the caller company', () => {
      expect(() => service.assertOwns(member, 'company-1')).not.toThrow();
    });

    it('throws 404 for a cross-tenant resource', () => {
      expect(() => service.assertOwns(member, 'company-2')).toThrow(
        NotFoundException,
      );
    });

    it('lets ADMIN access any company', () => {
      expect(() => service.assertOwns(admin, 'company-2')).not.toThrow();
    });
  });
});
