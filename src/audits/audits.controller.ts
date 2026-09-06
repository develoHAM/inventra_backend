import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { AuditsService } from './audits.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateAuditDto } from './dto/create-audit.dto';
import { UpdateAuditDto } from './dto/update-audit.dto';

@Controller('corners/:cornerId/audits')
export class AuditsController {
  constructor(private readonly audits: AuditsService) {}

  @RequirePermissions('audits.read')
  @Get()
  findAll(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
  ) {
    return this.audits.findAll(caller, cornerId);
  }

  @RequirePermissions('audits.read')
  @Get(':auditId')
  findOne(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
  ) {
    return this.audits.findOne(caller, cornerId, auditId);
  }

  @RequirePermissions('audits.create')
  @Post()
  create(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Body() dto: CreateAuditDto,
  ) {
    return this.audits.create(caller, cornerId, dto);
  }

  @RequirePermissions('audits.update')
  @Patch(':auditId')
  update(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Body() dto: UpdateAuditDto,
  ) {
    return this.audits.update(caller, cornerId, auditId, dto);
  }

  @RequirePermissions('audits.delete')
  @Delete(':auditId')
  remove(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
  ) {
    return this.audits.remove(caller, cornerId, auditId);
  }

  @RequirePermissions('audits.apply')
  @Post(':auditId/apply')
  apply(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
  ) {
    return this.audits.apply(caller, cornerId, auditId);
  }
}
