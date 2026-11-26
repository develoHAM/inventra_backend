import { Body, Controller, Delete, HttpCode, HttpStatus } from '@nestjs/common';
import { AccountRoute } from '../auth/decorators/account-route.decorator';
import { CurrentAccount } from '../auth/decorators/current-account.decorator';
import type { AuthAccount } from '../auth/types/auth-account';
import { AccountDeletionService } from './account-deletion.service';
import { DeleteAccountDto } from './dto/delete-account.dto';

/**
 * Deleting the sign-in itself: an @AccountRoute(), so it works with or
 * without a company open. Shares the /me prefix with AccountsController.
 */
@AccountRoute()
@Controller('me')
export class AccountDeletionController {
  constructor(private readonly deletion: AccountDeletionService) {}

  /** Every company left, every login, session and device gone. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT) // the account is gone: nothing to report
  deleteAccount(
    @CurrentAccount() account: AuthAccount,
    @Body() dto: DeleteAccountDto,
  ): Promise<void> {
    return this.deletion.deleteAccount(account, dto);
  }
}
