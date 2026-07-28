import { Controller, Param, Patch } from '@nestjs/common';
import { UsersService } from './users.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';

@Controller('companies')
export class CompaniesController {
  constructor(private usersService: UsersService) {}

  @RequirePermissions('companies.approve')
  @Patch(':id/approve')
  approveCompany(@Param('id') id: string) {
    return this.usersService.approveCompany(id);
  }
}
