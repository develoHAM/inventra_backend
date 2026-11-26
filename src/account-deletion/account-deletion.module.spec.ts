import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationsService } from '../notifications/notifications.service';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionModule } from './account-deletion.module';
import { AccountDeletionService } from './account-deletion.service';

/** Stands in for NotificationsModule, whose BullMQ queue would reach for Redis. */
@Module({
  providers: [
    { provide: NotificationsService, useValue: { dispatch: jest.fn() } },
  ],
  exports: [NotificationsService],
})
class StubNotificationsModule {}

describe('AccountDeletionModule wiring', () => {
  // The REAL modules deletion imports (phone verification, social auth,
  // profiles, accounts), with only the database, storage and the
  // notification queue swapped out. A provider another module doesn't
  // export (the disconnect, the leave procedure) fails here, and so does
  // an import cycle, instead of at app start.
  it('Nest can resolve DELETE /me and everything the deletion uses', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              SOCIAL_VERIFIER: 'fake',
              PHONE_VERIFIER: 'fake',
              PUSH_SENDER: 'fake',
              LOGIN_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString(
                'base64',
              ),
              VERIFICATION_CODE_SECRET: 'v'.repeat(32),
            }),
          ],
        }),
        EventEmitterModule.forRoot(),
        PrismaModule,
        StorageModule, // global in the app; profile photos and AccountsService presign
        AccountDeletionModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(StorageService)
      .useValue({})
      .overrideModule(NotificationsModule)
      .useModule(StubNotificationsModule)
      .compile();

    expect(moduleRef.get(AccountDeletionController)).toBeInstanceOf(
      AccountDeletionController,
    );
    expect(moduleRef.get(AccountDeletionService)).toBeInstanceOf(
      AccountDeletionService,
    );
    await moduleRef.close();
  });
});
