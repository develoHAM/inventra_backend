import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [JwtModule.register({})],
  providers: [
    TokenService,
    PasswordService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
