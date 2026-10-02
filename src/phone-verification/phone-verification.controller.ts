import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { PhoneVerificationService } from './phone-verification.service';
import { StartVerificationDto } from './dto/start-verification.dto';
import { ConfirmVerificationDto } from './dto/confirm-verification.dto';

@Controller('auth/phone')
export class PhoneVerificationController {
  constructor(private readonly phoneVerification: PhoneVerificationService) {}

  // Public: the user has no account yet while verifying for signup.
  @Public()
  @Post('start')
  @HttpCode(HttpStatus.OK)
  start(@Body() dto: StartVerificationDto) {
    return this.phoneVerification.start(dto.phone, dto.purpose);
  }

  @Public()
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Body() dto: ConfirmVerificationDto) {
    return this.phoneVerification.confirm(dto.verificationId);
  }
}
