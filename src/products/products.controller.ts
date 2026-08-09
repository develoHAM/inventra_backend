import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Get,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @RequirePermissions('products.read')
  @Get()
  findAll(@CurrentUser() caller: AuthUser) {
    return this.products.findAll(caller);
  }

  @RequirePermissions('products.read')
  @Get(':id')
  findOne(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.findOne(caller, id);
  }

  @RequirePermissions('products.create')
  @Post()
  create(@CurrentUser() caller: AuthUser, @Body() dto: CreateProductDto) {
    return this.products.create(caller, dto);
  }

  @RequirePermissions('products.update')
  @Patch(':id')
  update(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(caller, id, dto);
  }

  @RequirePermissions('products.delete')
  @Delete(':id')
  remove(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.remove(caller, id);
  }
}
