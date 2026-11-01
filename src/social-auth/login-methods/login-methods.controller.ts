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

/** The signed-in user's own login methods (no permission: it's their account). */
@Controller('users/me/login-methods')
export class LoginMethodsController {
  constructor(private readonly loginMethods: LoginMethodsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.loginMethods.list(user.id);
  }

  // Same body as social sign-in: { provider, credential, nonce? }
  @Post()
  linkProvider(@CurrentUser() user: AuthUser, @Body() body: SocialSignInDto) {
    return this.loginMethods.linkProvider(user.id, body);
  }

  @Post('local')
  linkPassword(@CurrentUser() user: AuthUser, @Body() dto: LinkPasswordDto) {
    return this.loginMethods.linkPassword(user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  unlink(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) loginMethodId: string,
  ) {
    return this.loginMethods.unlink(user.id, loginMethodId);
  }
}
