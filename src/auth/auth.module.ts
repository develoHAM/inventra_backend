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
import { DevicesModule } from '../devices/devices.module';
import { SignupTicketsModule } from '../social-auth/signup-tickets/signup-tickets.module';
import { EmailVerificationModule } from '../email-verification/email-verification.module';

@Module({
  imports: [
    JwtModule.register({}),
    PhoneVerificationModule,
    DevicesModule,
    SignupTicketsModule, // social signup spends the ticket
    EmailVerificationModule, // …and, when needed, the contact-email proof
  ],
  controllers: [AuthController, AccountRecoveryController],
  providers: [
    TokenService,
    PasswordService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    AuthService,
    AccountRecoveryService,
  ],
  exports: [TokenService, PasswordService, AuthService], // AuthService: social sign-in issues sessions
})
export class AuthModule {}
