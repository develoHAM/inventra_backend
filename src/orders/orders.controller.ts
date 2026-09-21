import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { ExportQueryDto } from '../spreadsheet/dto/export-query.dto';
import { FileInterceptor } from '@nestjs/platform-express';

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

  @RequirePermissions('orders.read')
  @Get(':orderId/export')
  async export(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Query() query: ExportQueryDto,
  ): Promise<StreamableFile> {
    const { buffer, filename, contentType } = await this.orders.exportOrder(
      caller,
      cornerId,
      orderId,
      query.format,
      query.lang,
    );
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @RequirePermissions('orders.create')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  importCreate(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.orders.importCreate(caller, cornerId, file);
  }

  @RequirePermissions('orders.update')
  @Post(':orderId/import')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  importUpdate(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.orders.importUpdate(caller, cornerId, orderId, file);
  }
}
