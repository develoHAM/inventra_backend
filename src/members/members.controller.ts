import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
} from '@nestjs/common';
import { MembersService } from './members.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { ChangeBranchDto } from './dto/change-branch.dto';
import { ApproveMemberDto } from './dto/approve-member.dto';

/** Company members: who is where, in which role. Shares the /users prefix. */
@Controller('users')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @RequirePermissions('users.approve')
  @Patch(':id/approve')
  approve(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveMemberDto,
  ) {
    return this.members.approve(caller, id, dto);
  }

  @RequirePermissions('users.move')
  @Put(':id/branch')
  changeBranch(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeBranchDto,
  ) {
    return this.members.changeBranch(caller, id, dto);
  }
}
