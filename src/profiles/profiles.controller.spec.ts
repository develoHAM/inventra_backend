import { ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';
import { LeavingService } from './leaving.service';
import { REQUIRE_PERMISSIONS_KEY } from '../authorization/decorators/require-permissions.decorator';
import { ProfileStatus } from '../generated/prisma/enums';
import type { AuthProfile } from '../auth/types/auth-profile';

/** The removal route. The other routes are covered by the profiles e2e suite. */
describe('ProfilesController', () => {
  let controller: ProfilesController;
  let leaving: { remove: jest.Mock };

  const ownerCaller: AuthProfile = {
    id: 'jisoo',
    accountId: 'account-of-jisoo',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    branchIds: [],
    status: ProfileStatus.ACTIVE,
  };

  const metadata = (key: string, method: keyof ProfilesController): unknown =>
    Reflect.getMetadata(key, ProfilesController.prototype[method]);

  beforeEach(() => {
    leaving = { remove: jest.fn().mockResolvedValue(undefined) };
    controller = new ProfilesController(
      {} as unknown as ProfilesService,
      leaving as unknown as LeavingService,
    );
  });

  it('POST /profiles/:id/remove needs profiles.remove: the owners hold it, and the admin holds every permission', () => {
    expect(metadata(METHOD_METADATA, 'remove')).toBe(RequestMethod.POST);
    expect(metadata(PATH_METADATA, 'remove')).toBe(':id/remove');
    expect(metadata(REQUIRE_PERMISSIONS_KEY, 'remove')).toEqual([
      'profiles.remove',
    ]);
  });

  it('answers 204: a removal has nothing to report (no successor, no closing)', () => {
    expect(metadata(HTTP_CODE_METADATA, 'remove')).toBe(204);
  });

  it('a malformed id is 400 before any query: the id goes through ParseUUIDPipe', () => {
    const routeArguments = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      ProfilesController,
      'remove',
    ) as Record<string, { data?: string; pipes?: unknown[] }>;
    const idArgument = Object.values(routeArguments).find(
      (argument) => argument.data === 'id',
    );

    expect(idArgument?.pipes).toEqual([ParseUUIDPipe]);
  });

  it('passes the caller from the token and the id from the path', async () => {
    await expect(
      controller.remove(ownerCaller, 'lee'),
    ).resolves.toBeUndefined();

    expect(leaving.remove).toHaveBeenCalledWith(ownerCaller, 'lee');
  });
});
