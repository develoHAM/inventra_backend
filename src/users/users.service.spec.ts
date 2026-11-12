import { BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: { findFirst: jest.Mock; update: jest.Mock };
  };
  let storage: {
    putObject: jest.Mock;
    presignPutUrl: jest.Mock;
    presignGetUrl: jest.Mock;
    objectExists: jest.Mock;
    deleteObject: jest.Mock;
  };

  const caller: AuthUser = {
    id: 'manager-1',
    accountId: 'account-of-manager-1',
    companyId: 'company-1',
    roleId: 3,
    roleCode: 'MANAGER',
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    storage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      presignPutUrl: jest.fn().mockResolvedValue('https://minio/presigned-put'),
      presignGetUrl: jest.fn().mockResolvedValue('https://minio/presigned-get'),
      objectExists: jest.fn().mockResolvedValue(true),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    // constructor: (prisma, storage)
    service = new UsersService(prisma as any, storage as any);
  });

  describe('avatar (self-service)', () => {
    it('uploadAvatar targets the caller, stores under users/<caller.id>/<uuid>.<ext>, deletes old', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: 'users/old.jpg',
      });
      prisma.user.update.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: 'k',
      });

      await service.uploadAvatar(caller, {
        buffer: Buffer.from('x'),
        mimetype: 'image/png',
      } as any);

      // the self row is looked up by the caller's own id (never a param)
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'manager-1', deletedAt: null },
      });
      const putKey = storage.putObject.mock.calls[0][0];
      expect(putKey).toMatch(/^users\/manager-1\/[0-9a-f-]+\.png$/);
      expect(storage.putObject).toHaveBeenCalledWith(
        putKey,
        expect.any(Buffer),
        'image/png',
      );
      expect(storage.deleteObject).toHaveBeenCalledWith('users/old.jpg');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'manager-1' },
        data: { profileImageUrl: putKey },
      });
    });

    it('presignAvatarUpload returns an upload URL + key without touching the user', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: null,
      });

      const res = await service.presignAvatarUpload(caller, {
        contentType: 'image/jpeg',
      } as any);

      expect(res.key).toMatch(/^users\/manager-1\/[0-9a-f-]+\.jpg$/);
      expect(res.uploadUrl).toBe('https://minio/presigned-put');
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('confirmAvatar rejects a key not under the caller prefix (400)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: null,
      });

      await expect(
        service.confirmAvatar(caller, {
          key: 'users/other-user/x.jpg',
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(storage.objectExists).not.toHaveBeenCalled();
    });

    it('confirmAvatar rejects a key whose object is missing (400)', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: null,
      });
      storage.objectExists.mockResolvedValue(false);

      await expect(
        service.confirmAvatar(caller, {
          key: 'users/manager-1/x.jpg',
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('confirmAvatar sets profileImageUrl and returns a presented (presigned) user', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: null,
      });
      prisma.user.update.mockResolvedValue({
        id: 'manager-1',
        profileImageUrl: 'users/manager-1/x.jpg',
      });

      const res = await service.confirmAvatar(caller, {
        key: 'users/manager-1/x.jpg',
      } as any);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'manager-1' },
        data: { profileImageUrl: 'users/manager-1/x.jpg' },
      });
      expect(res.profileImageUrl).toBe('https://minio/presigned-get');
    });
  });
});
