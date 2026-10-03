import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { AccountRecoveryController } from './account-recovery.controller';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

describe('AccountRecoveryController', () => {
  let controller: AccountRecoveryController;
  let accountRecovery: { findId: jest.Mock };

  const metadata = (key: string, method: keyof AccountRecoveryController) =>
    Reflect.getMetadata(key, AccountRecoveryController.prototype[method]);

  beforeEach(() => {
    accountRecovery = {
      findId: jest.fn().mockResolvedValue({ email: 'ow***@example.com' }),
    };
    controller = new AccountRecoveryController(accountRecovery as any);
  });

  describe('POST /auth/find-id', () => {
    it('is public (the user cannot log in — that is the point) and answers 200', () => {
      expect(metadata(IS_PUBLIC_KEY, 'findId')).toBe(true);
      expect(metadata(HTTP_CODE_METADATA, 'findId')).toBe(HttpStatus.OK);
    });

    it('passes the phone and token to the service', async () => {
      await expect(
        controller.findId({
          phone: '01012345678',
          phoneVerificationToken: 'find-token',
        }),
      ).resolves.toEqual({ email: 'ow***@example.com' });
      expect(accountRecovery.findId).toHaveBeenCalledWith(
        '01012345678',
        'find-token',
      );
    });
  });
});
