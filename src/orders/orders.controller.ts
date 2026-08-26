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
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';

@Controller('corners/:cornerId/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @RequirePermissions('orders.read')
  @Get()
  findAll(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
  ) {
    return this.orders.findAll(caller, cornerId);
  }

  @RequirePermissions('orders.read')
  @Get(':orderId')
  findOne(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.orders.findOne(caller, cornerId, orderId);
  }

  @RequirePermissions('orders.create')
  @Post()
  create(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orders.create(caller, cornerId, dto);
  }

  @RequirePermissions('orders.update')
  @Patch(':orderId')
  update(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.orders.update(caller, cornerId, orderId, dto);
  }

  @RequirePermissions('orders.delete')
  @Delete(':orderId')
  remove(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.orders.remove(caller, cornerId, orderId);
  }
}
