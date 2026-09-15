import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser } from '../auth/types/auth-user';
import { ApproveMemberDto } from './dto/approve-member.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UserStatus } from '../generated/prisma/enums';
import { OwnershipService } from '../authorization/ownership.service';
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
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly storage: StorageService,
  ) {}

  private avatarKey(userId: string, contentType: string): string {
    const ext = IMAGE_EXT[contentType] ?? 'bin';
    return `users/${userId}/${randomUUID()}.${ext}`;
  }

  private async present<T extends { profileImageUrl: string | null }>(
    user: T,
  ): Promise<T> {
    if (!user.profileImageUrl) return user;
    return {
      ...user,
      profileImageUrl: await this.storage.presignGetUrl(user.profileImageUrl),
    };
  }

  private async findSelf(caller: AuthUser) {
    const user = await this.prisma.user.findFirst({
      where: { id: caller.id, deletedAt: null },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async approveMember(
    caller: AuthUser,
    targetUserId: string,
    dto: ApproveMemberDto,
  ) {
    const target = await this.prisma.user.findFirst({
      where: {
        id: targetUserId,
        ...this.ownership.scopeToCompany(caller),
      },
    });
    if (!target) throw new NotFoundException('Member not found');

    if (target.status !== UserStatus.PENDING_APPROVAL)
      throw new BadRequestException('Member is not pending approval');

    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role || !['MANAGER', 'STAFF'].includes(role.code))
      throw new BadRequestException('Invalid role for a member');

    return this.prisma.user.update({
      where: { id: target.id },
      data: { roleId: dto.roleId, status: UserStatus.ACTIVE },
    });
  }

  async approveCompany(companyId: string) {
    const owner = await this.prisma.user.findFirst({
      where: { companyId: companyId, role: { code: 'OWNER' } },
    });

    if (!owner) throw new NotFoundException('Company owner not found');

    if (owner.status !== UserStatus.PENDING_APPROVAL)
      throw new BadRequestException('Owner is not pending approval');

    return this.prisma.user.update({
      where: { id: owner.id },
      data: { status: UserStatus.ACTIVE },
    });
  }

  async findActiveMember(userId: string, companyId: string) {
    return this.prisma.user.findFirst({
      where: {
        id: userId,
        companyId: companyId,
        deletedAt: null,
        status: UserStatus.ACTIVE,
      },
      include: {
        role: true,
      },
    });
  }

  async uploadAvatar(caller: AuthUser, file: Express.Multer.File) {
    const user = await this.findSelf(caller);
    const key = this.avatarKey(caller.id, file.mimetype);
    await this.storage.putObject(key, file.buffer, file.mimetype);
    if (user.profileImageUrl)
      await this.storage.deleteObject(user.profileImageUrl);
    const updated = await this.prisma.user.update({
      where: { id: caller.id },
      data: { profileImageUrl: key },
    });
    return this.present(updated);
  }

  async presignAvatarUpload(caller: AuthUser, dto: PresignUploadDto) {
    await this.findSelf(caller);
    const key = this.avatarKey(caller.id, dto.contentType);
    const uploadUrl = await this.storage.presignPutUrl(key, dto.contentType);
    return { uploadUrl, key };
  }

  async confirmAvatar(caller: AuthUser, dto: ConfirmUploadDto) {
    const user = await this.findSelf(caller);
    if (!dto.key.startsWith(`users/${caller.id}/`))
      throw new BadRequestException('Key does not belong to you');
    if (!(await this.storage.objectExists(dto.key)))
      throw new BadRequestException('Uploaded object not found');
    if (user.profileImageUrl)
      await this.storage.deleteObject(user.profileImageUrl);
    const updated = await this.prisma.user.update({
      where: { id: caller.id },
      data: { profileImageUrl: dto.key },
    });
    return this.present(updated);
  }
}
