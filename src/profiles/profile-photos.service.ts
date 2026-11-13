import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthProfile } from '../auth/types/auth-profile';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { randomUUID } from 'node:crypto';
import { ConfirmUploadDto } from '../storage/dto/confirm-upload.dto';
import { PresignUploadDto } from '../storage/dto/presign-upload.dto';

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class ProfilePhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  private avatarKey(profileId: string, contentType: string): string {
    const ext = IMAGE_EXT[contentType] ?? 'bin';
    return `profiles/${profileId}/${randomUUID()}.${ext}`;
  }

  private async present<T extends { profileImageUrl: string | null }>(
    profile: T,
  ): Promise<T> {
    if (!profile.profileImageUrl) return profile;
    return {
      ...profile,
      profileImageUrl: await this.storage.presignGetUrl(
        profile.profileImageUrl,
      ),
    };
  }

  private async findSelf(caller: AuthProfile) {
    const profile = await this.prisma.profile.findFirst({
      where: { id: caller.id, deletedAt: null },
    });
    if (!profile) throw new NotFoundException('User not found');
    return profile;
  }

  async uploadAvatar(caller: AuthProfile, file: Express.Multer.File) {
    const profile = await this.findSelf(caller);
    const key = this.avatarKey(caller.id, file.mimetype);
    await this.storage.putObject(key, file.buffer, file.mimetype);
    if (profile.profileImageUrl)
      await this.storage.deleteObject(profile.profileImageUrl);
    const updated = await this.prisma.profile.update({
      where: { id: caller.id },
      data: { profileImageUrl: key },
    });
    return this.present(updated);
  }

  async presignAvatarUpload(caller: AuthProfile, dto: PresignUploadDto) {
    await this.findSelf(caller);
    const key = this.avatarKey(caller.id, dto.contentType);
    const uploadUrl = await this.storage.presignPutUrl(key, dto.contentType);
    return { uploadUrl: uploadUrl, key: key };
  }

  async confirmAvatar(caller: AuthProfile, dto: ConfirmUploadDto) {
    const profile = await this.findSelf(caller);
    if (!dto.key.startsWith(`profiles/${caller.id}/`))
      throw new BadRequestException('Key does not belong to you');
    if (!(await this.storage.objectExists(dto.key)))
      throw new BadRequestException('Uploaded object not found');
    if (profile.profileImageUrl)
      await this.storage.deleteObject(profile.profileImageUrl);
    const updated = await this.prisma.profile.update({
      where: { id: caller.id },
      data: { profileImageUrl: dto.key },
    });
    return this.present(updated);
  }
}
