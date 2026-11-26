import { RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { ACCOUNT_ROUTE_KEY } from '../auth/decorators/account-route.decorator';
import type { AuthAccount } from '../auth/types/auth-account';

describe('AccountDeletionController', () => {
  let controller: AccountDeletionController;
  let deletion: { deleteAccount: jest.Mock };

  const han: AuthAccount = { accountId: 'account-of-han', profileId: null };

  const metadata = (
    key: string,
    method: keyof AccountDeletionController,
  ): unknown =>
    Reflect.getMetadata(key, AccountDeletionController.prototype[method]);

  beforeEach(() => {
    deletion = { deleteAccount: jest.fn().mockResolvedValue(undefined) };
    controller = new AccountDeletionController(
      deletion as unknown as AccountDeletionService,
    );
  });

  it('DELETE /me', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AccountDeletionController)).toBe(
      'me',
    );
    expect(metadata(METHOD_METADATA, 'deleteAccount')).toBe(
      RequestMethod.DELETE,
    );
    expect(metadata(PATH_METADATA, 'deleteAccount')).toBe('/');
  });

  it('an @AccountRoute(): it is about the sign-in, so it works with no company open', () => {
    expect(
      Reflect.getMetadata(ACCOUNT_ROUTE_KEY, AccountDeletionController),
    ).toBe(true);
  });

  it('answers 204: the account is gone, there is nothing to report', () => {
    expect(metadata(HTTP_CODE_METADATA, 'deleteAccount')).toBe(204);
  });

  it('the body is checked as a DeleteAccountDto (a value import: with `import type`, validation would be skipped)', () => {
    const parameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      AccountDeletionController.prototype,
      'deleteAccount',
    ) as unknown[];

    expect(parameterTypes[1]).toBe(DeleteAccountDto);
  });

  it('passes the account from the token and the body', async () => {
    const dto = { phoneVerificationToken: 'raw-phone-token' };

    await expect(controller.deleteAccount(han, dto)).resolves.toBeUndefined();

    expect(deletion.deleteAccount).toHaveBeenCalledWith(han, dto);
  });
});
