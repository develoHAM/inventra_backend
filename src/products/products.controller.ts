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
  FileTypeValidator,
  MaxFileSizeValidator,
  ParseFilePipe,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfirmImageDto } from './dto/confirm-image.dto';
import { PresignImageDto } from './dto/presign-image.dto';

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

  @RequirePermissions('products.update')
  @Post(':id/image')
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.products.uploadImage(caller, id, file);
  }

  @RequirePermissions('products.update')
  @Post(':id/image/presign')
  presignImage(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignImageDto,
  ) {
    return this.products.presignImageUpload(caller, id, dto);
  }

  @RequirePermissions('products.update')
  @Post(':id/image/confirm')
  confirmImage(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmImageDto,
  ) {
    return this.products.confirmImage(caller, id, dto);
  }
}
