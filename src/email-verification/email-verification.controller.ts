import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { EmailVerificationService } from './email-verification.service';
import { StartEmailVerificationDto } from './dto/start-email-verification.dto';
import { ConfirmEmailVerificationDto } from './dto/confirm-email-verification.dto';

@Controller('auth/email')
export class EmailVerificationController {
  constructor(private readonly emailVerification: EmailVerificationService) {}

  // Public: used during signup, before the account exists.
  @Public()
  @Post('start')
  @HttpCode(HttpStatus.OK)
  start(@Body() dto: StartEmailVerificationDto) {
    return this.emailVerification.start(dto.email);
  }

  @Public()
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Body() dto: ConfirmEmailVerificationDto) {
    return this.emailVerification.confirm(dto.email, dto.code);
  }
}
