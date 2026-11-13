import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
import { HistoryQueryDto } from '../membership-history/dto/history-query.dto';

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
  getJoinCode(@CurrentProfile() caller: AuthProfile) {
    return this.companiesService.getJoinCode(caller);
  }

  @RequirePermissions('companies.rotateJoinCode')
  @Post('me/join-code/rotate')
  @HttpCode(HttpStatus.OK)
  rotateJoinCode(@CurrentProfile() caller: AuthProfile) {
    return this.companiesService.rotateJoinCode(caller);
  }

  @RequirePermissions('companies.read')
  @Get(':id/history')
  history(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: HistoryQueryDto,
  ) {
    return this.companiesService.listHistory(caller, id, query);
  }
}
