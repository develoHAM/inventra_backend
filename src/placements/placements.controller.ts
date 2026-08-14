import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { PlacementsService } from './placements.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreatePlacementDto } from './dto/create-placement.dto';
import { UpdatePlacementDto } from './dto/update-placement.dto';

@Controller('corners/:cornerId/products')
export class PlacementsController {
  constructor(private readonly placements: PlacementsService) {}

  @RequirePermissions('placements.read')
  @Get()
  findAll(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
  ) {
    return this.placements.findAll(caller, cornerId);
  }

  @RequirePermissions('placements.read')
  @Get(':placementId')
  findOne(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
  ) {
    return this.placements.findOne(caller, cornerId, placementId);
  }

  @RequirePermissions('placements.create')
  @Post()
  create(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Body() dto: CreatePlacementDto,
  ) {
    return this.placements.create(caller, cornerId, dto);
  }

  @RequirePermissions('placements.update')
  @Patch(':placementId')
  update(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
    @Body() dto: UpdatePlacementDto,
  ) {
    return this.placements.update(caller, cornerId, placementId, dto);
  }

  @RequirePermissions('placements.delete')
  @Delete(':placementId')
  remove(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
  ) {
    return this.placements.remove(caller, cornerId, placementId);
  }
}
