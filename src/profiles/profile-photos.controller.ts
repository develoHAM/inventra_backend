import {
  Body,
  Controller,
  FileTypeValidator,
  MaxFileSizeValidator,
  ParseFilePipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ProfilePhotosService } from './profile-photos.service';
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfirmUploadDto } from '../storage/dto/confirm-upload.dto';
import { PresignUploadDto } from '../storage/dto/presign-upload.dto';

@Controller('profiles')
export class ProfilePhotosController {
  constructor(private profilePhotos: ProfilePhotosService) {}

  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file'))
  uploadAvatar(
    @CurrentProfile() caller: AuthProfile,
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
    return this.profilePhotos.uploadAvatar(caller, file);
  }

  @Post('me/avatar/presign')
  presignAvatar(
    @CurrentProfile() caller: AuthProfile,
    @Body() dto: PresignUploadDto,
  ) {
    return this.profilePhotos.presignAvatarUpload(caller, dto);
  }

  @Post('me/avatar/confirm')
  confirmAvatar(
    @CurrentProfile() caller: AuthProfile,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.profilePhotos.confirmAvatar(caller, dto);
  }
}
