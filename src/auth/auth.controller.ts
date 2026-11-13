import { Body, Controller, Get, Post } from '@nestjs/common';
import { Public } from './decorators/public.decorator';
import { RegisterDto } from './dto/register.dto';
import { AuthService } from './auth.service';
import { CurrentProfile } from './decorators/current-profile.decorator';
import type { AuthProfile } from './types/auth-profile';
import { RegisterMemberDto } from './dto/register-member.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return await this.authService.register(dto);
  }

  @Get('me')
  me(@CurrentProfile() profile: AuthProfile) {
    return profile;
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

  @Post('logout')
  logout(@CurrentProfile() profile: AuthProfile, @Body() dto: LogoutDto) {
    return this.authService.logout(profile.accountId, dto);
  }
}
