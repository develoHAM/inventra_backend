import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CornersService } from './corners.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
import { CreateCornerDto } from './dto/create-corner.dto';
import { UpdateCornerDto } from './dto/update-corner.dto';
import { HistoryQueryDto } from '../membership-history/dto/history-query.dto';

@Controller('corners')
export class CornersController {
  constructor(private readonly corners: CornersService) {}

  @RequirePermissions('corners.read')
  @Get()
  findAll(@CurrentProfile() caller: AuthProfile) {
    return this.corners.findAll(caller);
  }

  @RequirePermissions('corners.read')
  @Get(':id')
  findOne(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.corners.findOne(caller, id);
  }

  @RequirePermissions('corners.read')
  @Get(':id/history')
  history(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: HistoryQueryDto,
  ) {
    return this.corners.listHistory(caller, id, query);
  }

  @RequirePermissions('corners.create')
  @Post()
  create(@CurrentProfile() caller: AuthProfile, @Body() dto: CreateCornerDto) {
    return this.corners.create(caller, dto);
  }

  @RequirePermissions('corners.update')
  @Patch(':id')
  update(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCornerDto,
  ) {
    return this.corners.update(caller, id, dto);
  }

  @RequirePermissions('corners.delete')
  @Delete(':id')
  remove(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.corners.remove(caller, id);
  }
}
