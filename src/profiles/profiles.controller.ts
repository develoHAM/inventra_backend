import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import { LeavingService } from './leaving.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
import { ApproveProfileDto } from './dto/approve-profile.dto';
import { ChangeRoleDto } from './dto/change-role.dto';
import { ListProfilesQueryDto } from './dto/list-profiles-query.dto';
import { HistoryQueryDto } from '../membership-history/dto/history-query.dto';

/** Company profiles: who is where, in which role. Shares the /profiles prefix. */
@Controller('profiles')
export class ProfilesController {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly leaving: LeavingService,
  ) {}

  @RequirePermissions('profiles.read')
  @Get()
  list(
    @CurrentProfile() caller: AuthProfile,
    @Query() query: ListProfilesQueryDto,
  ) {
    return this.profiles.list(caller, query);
  }

  @RequirePermissions('profiles.read')
  @Get(':id/history')
  history(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: HistoryQueryDto,
  ) {
    return this.profiles.listHistory(caller, id, query);
  }

  @RequirePermissions('profiles.approve')
  @Patch(':id/approve')
  approve(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveProfileDto,
  ) {
    return this.profiles.approve(caller, id, dto);
  }

  @RequirePermissions('profiles.changeRole')
  @Put(':id/role')
  changeRole(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.profiles.changeRole(caller, id, dto);
  }

  /** Take someone out of the company: the leave procedure, run by the remover. */
  @RequirePermissions('profiles.remove')
  @Post(':id/remove')
  @HttpCode(HttpStatus.NO_CONTENT) // nothing to report: no successor, no closing
  remove(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.leaving.remove(caller, id);
  }
}
