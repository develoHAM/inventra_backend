import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateTransactionDto } from './dto/create-transaction.dto';

@Controller('corners/:cornerId/products/:placementId/transactions')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermissions('transactions.read')
  @Get()
  findAll(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
  ) {
    return this.inventory.findForPlacement(caller, cornerId, placementId);
  }

  @RequirePermissions('transactions.create')
  @Post()
  create(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
    @Body() dto: CreateTransactionDto,
  ) {
    return this.inventory.record(caller, cornerId, placementId, dto);
  }
}
