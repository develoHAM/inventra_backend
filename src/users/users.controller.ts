import { Body, Controller, Param, Patch } from '@nestjs/common';
import { UsersService } from './users.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { ApproveMemberDto } from './dto/approve-member.dto';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @RequirePermissions('users.approve')
  @Patch(':id/approve')
  approveMember(
    @CurrentUser() caller: AuthUser,
    @Param('id') id: string,
    @Body() dto: ApproveMemberDto,
  ) {
    return this.usersService.approveMember(caller, id, dto);
  }
}
