import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';

@Controller('companies')
export class CompaniesController {
  constructor(private companiesService: CompaniesService) {}

  @RequirePermissions('companies.approve')
  @Patch(':id/approve')
  approveCompany(@Param('id') id: string) {
    return this.companiesService.approveCompany(id);
  }

  // "me" = the caller's own company, taken from the JWT, never from the URL.
  @RequirePermissions('companies.invite')
  @Get('me/join-code')
  getJoinCode(@CurrentUser() caller: AuthUser) {
    return this.companiesService.getJoinCode(caller);
  }

  @RequirePermissions('companies.rotateJoinCode')
  @Post('me/join-code/rotate')
  @HttpCode(HttpStatus.OK)
  rotateJoinCode(@CurrentUser() caller: AuthUser) {
    return this.companiesService.rotateJoinCode(caller);
  }
}
