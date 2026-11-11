import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { CompaniesController } from './companies.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../authorization/decorators/require-permissions.decorator';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('CompaniesController', () => {
  let controller: CompaniesController;
  let companiesService: {
    approveCompany: jest.Mock;
    getJoinCode: jest.Mock;
    rotateJoinCode: jest.Mock;
    listHistory: jest.Mock;
  };

  const manager: AuthUser = {
    id: 'manager-1',
    companyId: 'company-1',
    roleId: 3,
    roleCode: 'MANAGER',
    status: UserStatus.ACTIVE,
  };

  // The permission on each route IS the security boundary: read it back
  // from the metadata @RequirePermissions stored on the method.
  const permissionsOf = (method: keyof CompaniesController) =>
    Reflect.getMetadata(
      REQUIRE_PERMISSIONS_KEY,
      CompaniesController.prototype[method],
    );

  beforeEach(() => {
    companiesService = {
      approveCompany: jest.fn().mockResolvedValue({ id: 'owner-1' }),
      getJoinCode: jest.fn().mockResolvedValue({ joinCode: '48291307' }),
      rotateJoinCode: jest.fn().mockResolvedValue({ joinCode: '73014289' }),
      listHistory: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    controller = new CompaniesController(companiesService as any);
  });

  it('viewing requires companies.invite (owner + manager)', () => {
    expect(permissionsOf('getJoinCode')).toEqual(['companies.invite']);
  });

  it('rotating requires companies.rotateJoinCode (owner only)', () => {
    expect(permissionsOf('rotateJoinCode')).toEqual([
      'companies.rotateJoinCode',
    ]);
  });

  it('rotate answers 200, not POST’s default 201', () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        CompaniesController.prototype.rotateJoinCode,
      ),
    ).toBe(HttpStatus.OK);
  });

  it('passes the caller through to the service', async () => {
    await expect(controller.getJoinCode(manager)).resolves.toEqual({
      joinCode: '48291307',
    });
    expect(companiesService.getJoinCode).toHaveBeenCalledWith(manager);

    await expect(controller.rotateJoinCode(manager)).resolves.toEqual({
      joinCode: '73014289',
    });
    expect(companiesService.rotateJoinCode).toHaveBeenCalledWith(manager);
  });

  it('approving a company requires companies.approve and delegates to CompaniesService', async () => {
    expect(permissionsOf('approveCompany')).toEqual(['companies.approve']);

    await expect(controller.approveCompany('company-1')).resolves.toEqual({
      id: 'owner-1',
    });
    expect(companiesService.approveCompany).toHaveBeenCalledWith('company-1');
  });

  it('the company history requires companies.read and passes caller, id and query through', async () => {
    expect(permissionsOf('history')).toEqual(['companies.read']);
    const query = { limit: 20 };

    await expect(
      controller.history(manager, 'company-1', query),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(companiesService.listHistory).toHaveBeenCalledWith(
      manager,
      'company-1',
      query,
    );
  });
});
