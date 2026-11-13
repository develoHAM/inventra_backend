import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
  Delete,
} from '@nestjs/common';
import { StoresService } from './stores.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CreateStoreDto } from './dto/create-store.dto';
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
import { UpdateStoreDto } from './dto/update-store.dto';

@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @RequirePermissions('stores.read')
  @Get()
  findAll() {
    return this.stores.findAll();
  }

  @RequirePermissions('stores.read')
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.stores.findOne(id);
  }

  @RequirePermissions('stores.create')
  @Post()
  create(@Body() dto: CreateStoreDto) {
    return this.stores.create(dto);
  }

  @RequirePermissions('stores.update')
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStoreDto) {
    return this.stores.update(id, dto);
  }

  @RequirePermissions('stores.delete')
  @Delete(':id')
  remove(
    @CurrentProfile() caller: AuthProfile,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.stores.remove(caller, id);
  }
}
