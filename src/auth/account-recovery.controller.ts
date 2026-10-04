import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from './decorators/public.decorator';
import { AccountRecoveryService } from './account-recovery.service';
import { FindIdDto } from './dto/find-id.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
export class AccountRecoveryController {
  constructor(private readonly accountRecovery: AccountRecoveryService) {}

  // Public: someone recovering their account cannot log in.
  @Public()
  @Post('find-id')
  @HttpCode(HttpStatus.OK)
  findId(@Body() dto: FindIdDto) {
    return this.accountRecovery.findId(dto.phone, dto.phoneVerificationToken);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.accountRecovery.resetPassword({
      email: dto.email,
      phone: dto.phone,
      token: dto.phoneVerificationToken,
      newPassword: dto.newPassword,
    });
  }
}
