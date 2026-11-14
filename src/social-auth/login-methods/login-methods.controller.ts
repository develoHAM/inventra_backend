import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentAccount } from '../../auth/decorators/current-account.decorator';
import { AccountRoute } from '../../auth/decorators/account-route.decorator';
import type { AuthAccount } from '../../auth/types/auth-account';
import { SocialSignInDto } from '../dto/social-sign-in.dto';
import { LinkPasswordDto } from './dto/link-password.dto';
import { LoginMethodsService } from './login-methods.service';

/**
 * The signed-in person's own login methods, on their account (no permission
 * needed, and no company needs to be open).
 */
@AccountRoute()
@Controller('accounts/me/login-methods')
export class LoginMethodsController {
  constructor(private readonly loginMethods: LoginMethodsService) {}

  @Get()
  list(@CurrentAccount() account: AuthAccount) {
    return this.loginMethods.list(account.accountId);
  }

  // Same body as social sign-in: { provider, credential, nonce? }
  @Post()
  linkProvider(
    @CurrentAccount() account: AuthAccount,
    @Body() body: SocialSignInDto,
  ) {
    return this.loginMethods.linkProvider(account.accountId, body);
  }

  @Post('local')
  linkPassword(
    @CurrentAccount() account: AuthAccount,
    @Body() dto: LinkPasswordDto,
  ) {
    return this.loginMethods.linkPassword(account.accountId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  unlink(
    @CurrentAccount() account: AuthAccount,
    @Param('id', ParseUUIDPipe) loginMethodId: string,
  ) {
    return this.loginMethods.unlink(account.accountId, loginMethodId);
  }
}
