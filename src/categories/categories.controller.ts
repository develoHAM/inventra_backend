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
import { CategoriesService } from './categories.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDTO } from './dto/update-category.dto';
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';

@Controller('categories')
export class CategoriesController {
  constructor(private categories: CategoriesService) {}

  @RequirePermissions('categories.read')
  @Get()
  findAll() {
    return this.categories.findAll();
  }

  @RequirePermissions('categories.read')
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.categories.findOne(id);
  }

  @RequirePermissions('categories.create')
  @Post()
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @RequirePermissions('categories.update')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDTO,
  ) {
    return this.categories.update(id, dto);
  }

  @RequirePermissions('categories.delete')
  @Delete(':id')
  remove(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.categories.remove(caller, id);
  }
}
