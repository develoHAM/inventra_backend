import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { BrandsService } from './brands.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@Controller('brands')
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @RequirePermissions('brands.read')
  @Get()
  findAll(@CurrentUser() caller: AuthUser) {
    return this.brands.findAll(caller);
  }

  @RequirePermissions('brands.read')
  @Get(':id')
  findOne(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.brands.findOne(caller, id);
  }

  @RequirePermissions('brands.create')
  @Post()
  create(@CurrentUser() caller: AuthUser, @Body() dto: CreateBrandDto) {
    return this.brands.create(caller, dto);
  }

  @RequirePermissions('brands.update')
  @Patch(':id')
  update(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.brands.update(caller, id, dto);
  }

  @RequirePermissions('brands.delete')
  @Delete(':id')
  remove(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.brands.remove(caller, id);
  }
}
