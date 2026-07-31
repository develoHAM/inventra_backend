import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from './guards/permissions.guard';
import { PermissionsService } from './permissions.service';
import { OwnershipService } from './ownership.service';

@Module({
  providers: [
    PermissionsService,
    OwnershipService,
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [PermissionsService, OwnershipService],
})
export class AuthorizationModule {}
