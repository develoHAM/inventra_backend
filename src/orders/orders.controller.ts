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
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
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
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
  ) {
    return this.orders.findAll(caller, cornerId);
  }

  @RequirePermissions('orders.read')
  @Get(':orderId')
  findOne(
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.orders.findOne(caller, cornerId, orderId);
  }

  @RequirePermissions('orders.create')
  @Post()
  create(
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orders.create(caller, cornerId, dto);
  }

  @RequirePermissions('orders.update')
  @Patch(':orderId')
  update(
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.orders.update(caller, cornerId, orderId, dto);
  }

  @RequirePermissions('orders.delete')
  @Delete(':orderId')
  remove(
    @CurrentProfile() caller: AuthProfile,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.orders.remove(caller, cornerId, orderId);
  }

  @RequirePermissions('orders.read')
  @Get(':orderId/export')
  async export(
    @CurrentProfile() caller: AuthProfile,
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
    @CurrentProfile() caller: AuthProfile,
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
    @CurrentProfile() caller: AuthProfile,
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
