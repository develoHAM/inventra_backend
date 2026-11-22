import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
import { MyProfileService } from './my-profile.service';
import type { ProfileSummary } from './my-profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SetContactEmailDto } from './dto/set-contact-email.dto';
import { LeavingService } from './leaving.service';
import type { LeavePreview, LeaveSummary } from './leaving.service';
import { LeaveCompanyDto } from './dto/leave-company.dto';

/**
 * /profiles/me: the open profile edits itself. Not an @AccountRoute() (a
 * company must be open: "me" is that company's profile), and no permission
 * decorator, so a profile still waiting for approval can use it too.
 * Registered before ProfilesController (see ProfilesModule).
 */
@Controller('profiles/me')
export class MyProfileController {
  constructor(
    private readonly myProfile: MyProfileService,
    private readonly leaving: LeavingService,
  ) {}

  /** Your name in this company. */
  @Patch()
  updateMyProfile(
    @CurrentProfile() caller: AuthProfile,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileSummary> {
    return this.myProfile.updateMyProfile(caller, dto);
  }

  /** This company's contact email, proven by an emailed code. */
  @Put('contact-email')
  setMyContactEmail(
    @CurrentProfile() caller: AuthProfile,
    @Body() dto: SetContactEmailDto,
  ): Promise<ProfileSummary> {
    return this.myProfile.setMyContactEmail(caller, dto);
  }

  /** What leaving would need: a successor? would the company close? */
  @Get('leave-preview')
  leavePreview(@CurrentProfile() caller: AuthProfile): Promise<LeavePreview> {
    return this.leaving.preview(caller);
  }

  /** Leave this company (a waiting profile withdraws its request). */
  @Post('leave')
  @HttpCode(HttpStatus.OK) // a summary of what happened; nothing is created
  leave(
    @CurrentProfile() caller: AuthProfile,
    @Body() dto: LeaveCompanyDto,
  ): Promise<LeaveSummary> {
    return this.leaving.leave(caller, dto);
  }
}
