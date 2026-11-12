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
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthUser } from '../../auth/types/auth-user';
import { SocialSignInDto } from '../dto/social-sign-in.dto';
import { LinkPasswordDto } from './dto/link-password.dto';
import { LoginMethodsService } from './login-methods.service';

/** The signed-in person's own login methods, on their account (no permission needed). */
@Controller('users/me/login-methods')
export class LoginMethodsController {
  constructor(private readonly loginMethods: LoginMethodsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.loginMethods.list(user.accountId);
  }

  // Same body as social sign-in: { provider, credential, nonce? }
  @Post()
  linkProvider(@CurrentUser() user: AuthUser, @Body() body: SocialSignInDto) {
    return this.loginMethods.linkProvider(user.accountId, body);
  }

  @Post('local')
  linkPassword(@CurrentUser() user: AuthUser, @Body() dto: LinkPasswordDto) {
    return this.loginMethods.linkPassword(user.accountId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  unlink(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) loginMethodId: string,
  ) {
    return this.loginMethods.unlink(user.accountId, loginMethodId);
  }
}
