import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { PhoneVerificationController } from './phone-verification.controller';
import { PhoneVerificationService } from './phone-verification.service';
import { PHONE_VERIFIER } from './phone-verification.constants';
import { OctomoPhoneVerifier } from './verifiers/octomo.verifier';
import { FakePhoneVerifier } from './verifiers/fake.verifier';

@Module({
  controllers: [PhoneVerificationController],
  providers: [
    PhoneVerificationService,
    OctomoPhoneVerifier,
    FakePhoneVerifier,
    {
      // Which verifier this environment uses, chosen once at startup.
      provide: PHONE_VERIFIER,
      inject: [ConfigService, OctomoPhoneVerifier, FakePhoneVerifier],
      useFactory: (
        config: ConfigService<Env, true>,
        octomo: OctomoPhoneVerifier,
        fake: FakePhoneVerifier,
      ) =>
        config.get('PHONE_VERIFIER', { infer: true }) === 'octomo'
          ? octomo
          : fake,
    },
  ],
  exports: [PhoneVerificationService],
})
export class PhoneVerificationModule {}
