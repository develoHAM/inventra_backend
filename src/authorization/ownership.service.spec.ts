import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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

    it('scopes to a custom owner column when a field is given', () => {
      expect(service.scopeToCompany(member, 'createdByCompanyId')).toEqual({
        createdByCompanyId: 'company-1',
      });
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

  describe('resolveCompanyForCreate', () => {
    it('uses the caller company for a company user', () => {
      expect(service.resolveCompanyForCreate(member)).toBe('company-1');
    });

    it('uses the requested company for ADMIN', () => {
      expect(service.resolveCompanyForCreate(admin, 'company-9')).toBe(
        'company-9',
      );
    });

    it('throws 400 when ADMIN supplies no company', () => {
      expect(() => service.resolveCompanyForCreate(admin)).toThrow(
        BadRequestException,
      );
    });
  });
});
