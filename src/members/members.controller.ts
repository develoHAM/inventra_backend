import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Query,
} from '@nestjs/common';
import { MembersService } from './members.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { ChangeBranchDto } from './dto/change-branch.dto';
import { ApproveMemberDto } from './dto/approve-member.dto';
import { ChangeRoleDto } from './dto/change-role.dto';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { HistoryQueryDto } from '../membership-history/dto/history-query.dto';

/** Company members: who is where, in which role. Shares the /users prefix. */
@Controller('users')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @RequirePermissions('users.read')
  @Get()
  list(@CurrentUser() caller: AuthUser, @Query() query: ListMembersQueryDto) {
    return this.members.list(caller, query);
  }

  @RequirePermissions('users.read')
  @Get(':id/history')
  history(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: HistoryQueryDto,
  ) {
    return this.members.listHistory(caller, id, query);
  }

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

  @RequirePermissions('users.changeRole')
  @Put(':id/role')
  changeRole(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.members.changeRole(caller, id, dto);
  }
}
