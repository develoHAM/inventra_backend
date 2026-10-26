import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { SocialAuthService } from './social-auth.service';
import { SocialSignInDto } from './dto/social-sign-in.dto';

@Controller('auth/social')
export class SocialAuthController {
  constructor(private readonly socialAuth: SocialAuthService) {}

  @Public()
  @Post('nonce')
  @HttpCode(HttpStatus.OK)
  issueNonce() {
    return this.socialAuth.issueNonce();
  }

  // Always 200: LOGGED_IN and SIGNUP_REQUIRED are both successful answers.
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  signIn(@Body() body: SocialSignInDto) {
    return this.socialAuth.signIn(body);
  }
}
