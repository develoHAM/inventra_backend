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
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
import { CreatePlacementDto } from './dto/create-placement.dto';
import { UpdatePlacementDto } from './dto/update-placement.dto';

@Controller('corners/:cornerId/products')
export class PlacementsController {
  constructor(private readonly placements: PlacementsService) {}

  @RequirePermissions('placements.read')
  @Get()
  findAll(
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
  ) {
    return this.placements.findAll(caller, cornerId);
  }

  @RequirePermissions('placements.read')
  @Get(':placementId')
  findOne(
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
  ) {
    return this.placements.findOne(caller, cornerId, placementId);
  }

  @RequirePermissions('placements.create')
  @Post()
  create(
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Body() dto: CreatePlacementDto,
  ) {
    return this.placements.create(caller, cornerId, dto);
  }

  @RequirePermissions('placements.update')
  @Patch(':placementId')
  update(
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
    @Body() dto: UpdatePlacementDto,
  ) {
    return this.placements.update(caller, cornerId, placementId, dto);
  }

  @RequirePermissions('placements.delete')
  @Delete(':placementId')
  remove(
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
  ) {
    return this.placements.remove(caller, cornerId, placementId);
  }
}
