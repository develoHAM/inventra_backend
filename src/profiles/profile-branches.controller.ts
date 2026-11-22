import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ProfileBranchesService } from './profile-branches.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
import { AddBranchDto } from './dto/add-branch.dto';

/** Where a manager or staff member works. Shares the /profiles prefix. */
@Controller('profiles')
export class ProfileBranchesController {
  constructor(private readonly profileBranches: ProfileBranchesService) {}

  @RequirePermissions('profiles.move')
  @Post(':id/branches')
  add(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddBranchDto,
  ) {
    return this.profileBranches.add(caller, id, dto);
  }

  @RequirePermissions('profiles.move')
  @Delete(':id/branches/:cornerId')
  remove(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
  ) {
    return this.profileBranches.remove(caller, id, cornerId);
  }
}
