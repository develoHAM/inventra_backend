import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CornersModule } from '../corners/corners.module';
import { MembershipHistoryModule } from '../membership-history/membership-history.module';
import { ProfilePhotosController } from './profile-photos.controller';
import { ProfilePhotosService } from './profile-photos.service';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

/** Company profiles: who is where, in which role, and their photo. */
@Module({
  imports: [AuthorizationModule, CornersModule, MembershipHistoryModule],
  controllers: [ProfilesController, ProfilePhotosController],
  providers: [ProfilesService, ProfilePhotosService],
})
export class ProfilesModule {}
