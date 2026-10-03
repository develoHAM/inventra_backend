import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PhoneVerificationModule } from '../phone-verification/phone-verification.module';
import { AccountRecoveryController } from './account-recovery.controller';
import { AccountRecoveryService } from './account-recovery.service';

@Module({
  imports: [JwtModule.register({}), PhoneVerificationModule],
  controllers: [AuthController, AccountRecoveryController],
  providers: [
    TokenService,
    PasswordService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    AuthService,
    AccountRecoveryService,
  ],
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
