import { Body, Controller, Get, Post } from '@nestjs/common';
import { Public } from './decorators/public.decorator';
import { RegisterDto } from './dto/register.dto';
import { AuthService } from './auth.service';
import { CurrentProfile } from './decorators/current-profile.decorator';
import { CurrentAccount } from './decorators/current-account.decorator';
import { AccountRoute } from './decorators/account-route.decorator';
import type { AuthProfile } from './types/auth-profile';
import type { AuthAccount } from './types/auth-account';
import { RegisterMemberDto } from './dto/register-member.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { SwitchProfileDto } from './dto/switch-profile.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return await this.authService.register(dto);
  }

  // request.profile is undefined when no company is open
  @AccountRoute()
  @Get('me')
  me(
    @CurrentAccount() account: AuthAccount,
    @CurrentProfile() profile: AuthProfile | undefined,
  ) {
    return this.authService.me(account, profile ?? null);
  }

  @Public()
  @Post('register/member')
  async registerMember(@Body() dto: RegisterMemberDto) {
    return await this.authService.registerMember(dto);
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return await this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto);
  }

  @AccountRoute()
  @Post('logout')
  logout(@CurrentAccount() account: AuthAccount, @Body() dto: LogoutDto) {
    return this.authService.logout(account.accountId, dto);
  }

  // Open another of the caller's companies (from the login's `companies`).
  @AccountRoute()
  @Post('switch')
  switchProfile(
    @CurrentAccount() account: AuthAccount,
    @Body() dto: SwitchProfileDto,
  ) {
    return this.authService.switchProfile(account, dto);
  }
}
