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
import { CornersService } from './corners.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateCornerDto } from './dto/create-corner.dto';
import { UpdateCornerDto } from './dto/update-corner.dto';

@Controller('corners')
export class CornersController {
  constructor(private readonly corners: CornersService) {}

  @RequirePermissions('corners.read')
  @Get()
  findAll(@CurrentUser() caller: AuthUser) {
    return this.corners.findAll(caller);
  }

  @RequirePermissions('corners.read')
  @Get(':id')
  findOne(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.corners.findOne(caller, id);
  }

  @RequirePermissions('corners.create')
  @Post()
  create(@CurrentUser() caller: AuthUser, @Body() dto: CreateCornerDto) {
    return this.corners.create(caller, dto);
  }

  @RequirePermissions('corners.update')
  @Patch(':id')
  update(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCornerDto,
  ) {
    return this.corners.update(caller, id, dto);
  }

  @RequirePermissions('corners.delete')
  @Delete(':id')
  remove(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.corners.remove(caller, id);
  }
}
