import {
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  Get,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  ParseIntPipe,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { BrandsService } from './brands.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfirmUploadDto } from '../storage/dto/confirm-upload.dto';
import { PresignUploadDto } from '../storage/dto/presign-upload.dto';

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

  @RequirePermissions('brands.update')
  @Post(':id/logo')
  @UseInterceptors(FileInterceptor('file'))
  uploadLogo(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseIntPipe) id: number,
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
    return this.brands.uploadLogo(caller, id, file);
  }

  @RequirePermissions('brands.update')
  @Post(':id/logo/presign')
  presignLogo(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PresignUploadDto,
  ) {
    return this.brands.presignLogoUpload(caller, id, dto);
  }

  @RequirePermissions('brands.update')
  @Post(':id/logo/confirm')
  confirmLogo(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.brands.confirmLogo(caller, id, dto);
  }
}
