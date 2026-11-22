import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { CornersModule } from '../corners/corners.module';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { MembershipHistoryModule } from '../membership-history/membership-history.module';
import { MyProfileController } from './my-profile.controller';
import { MyProfileService } from './my-profile.service';
import { ProfileBranchesController } from './profile-branches.controller';
import { ProfileBranchesService } from './profile-branches.service';
import { ProfilePhotosController } from './profile-photos.controller';
import { ProfilePhotosService } from './profile-photos.service';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

/** Company profiles: who is where, in which role, their name, email and photo. */
@Module({
  imports: [
    AuthorizationModule,
    CornersModule,
    EmailVerificationModule, // consume() proves a contact email
    MembershipHistoryModule,
  ],
  // Order matters: routes match in registration order, and ':id' matches
  // 'me' too. The /profiles/me routes go first so they always win.
  controllers: [
    MyProfileController,
    ProfilesController,
    ProfileBranchesController,
    ProfilePhotosController,
  ],
  providers: [
    ProfilesService,
    ProfileBranchesService,
    ProfilePhotosService,
    MyProfileService,
  ],
})
export class ProfilesModule {}
