import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { AccountCompaniesService } from './account-companies.service';
import { AccountsController } from './accounts.controller';
import { AccountsModule } from './accounts.module';
import { AccountsService } from './accounts.service';

describe('AccountsModule wiring', () => {
  // The real module with only the database and storage swapped out: a
  // missing provider (e.g. the event emitter) fails here, not at app start.
  it('Nest can resolve the company routes and both services', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        EventEmitterModule.forRoot(),
        PrismaModule,
        StorageModule, // global in the app; AccountsService presigns photos
        AccountsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(StorageService)
      .useValue({})
      .compile();

    expect(moduleRef.get(AccountsController)).toBeInstanceOf(
      AccountsController,
    );
    expect(moduleRef.get(AccountCompaniesService)).toBeInstanceOf(
      AccountCompaniesService,
    );
    // still exported: auth and social login look accounts up through it
    expect(moduleRef.get(AccountsService)).toBeInstanceOf(AccountsService);
    await moduleRef.close();
  });
});
