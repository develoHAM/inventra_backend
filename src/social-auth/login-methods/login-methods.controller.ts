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
import { CurrentProfile } from '../../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../../auth/types/auth-profile';
import { SocialSignInDto } from '../dto/social-sign-in.dto';
import { LinkPasswordDto } from './dto/link-password.dto';
import { LoginMethodsService } from './login-methods.service';

/** The signed-in person's own login methods, on their account (no permission needed). */
@Controller('accounts/me/login-methods')
export class LoginMethodsController {
  constructor(private readonly loginMethods: LoginMethodsService) {}

  @Get()
  list(@CurrentProfile() profile: AuthProfile) {
    return this.loginMethods.list(profile.accountId);
  }

  // Same body as social sign-in: { provider, credential, nonce? }
  @Post()
  linkProvider(
    @CurrentProfile() profile: AuthProfile,
    @Body() body: SocialSignInDto,
  ) {
    return this.loginMethods.linkProvider(profile.accountId, body);
  }

  @Post('local')
  linkPassword(
    @CurrentProfile() profile: AuthProfile,
    @Body() dto: LinkPasswordDto,
  ) {
    return this.loginMethods.linkPassword(profile.accountId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  unlink(
    @CurrentProfile() profile: AuthProfile,
    @Param('id', ParseUUIDPipe) loginMethodId: string,
  ) {
    return this.loginMethods.unlink(profile.accountId, loginMethodId);
  }
}
