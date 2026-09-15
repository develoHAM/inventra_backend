import {
  Body,
  Controller,
  FileTypeValidator,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { ApproveMemberDto } from './dto/approve-member.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConfirmUploadDto } from '../storage/dto/confirm-upload.dto';
import { PresignUploadDto } from '../storage/dto/presign-upload.dto';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @RequirePermissions('users.approve')
  @Patch(':id/approve')
  approveMember(
    @CurrentUser() caller: AuthUser,
    @Param('id') id: string,
    @Body() dto: ApproveMemberDto,
  ) {
    return this.usersService.approveMember(caller, id, dto);
  }

  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file'))
  uploadAvatar(
    @CurrentUser() caller: AuthUser,
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
    return this.usersService.uploadAvatar(caller, file);
  }

  @Post('me/avatar/presign')
  presignAvatar(
    @CurrentUser() caller: AuthUser,
    @Body() dto: PresignUploadDto,
  ) {
    return this.usersService.presignAvatarUpload(caller, dto);
  }

  @Post('me/avatar/confirm')
  confirmAvatar(
    @CurrentUser() caller: AuthUser,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.usersService.confirmAvatar(caller, dto);
  }
}
