import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { CompaniesController } from './companies.controller';
import { REQUIRE_PERMISSIONS_KEY } from '../authorization/decorators/require-permissions.decorator';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('CompaniesController — join code routes', () => {
  let controller: CompaniesController;
  let companiesService: { getJoinCode: jest.Mock; rotateJoinCode: jest.Mock };

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
      getJoinCode: jest
        .fn()
        .mockResolvedValue({ joinCode: '48291307' }),
      rotateJoinCode: jest
        .fn()
        .mockResolvedValue({ joinCode: '73014289' }),
    };
    controller = new CompaniesController({} as any, companiesService as any);
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
});
