import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DevicePlatform } from '../generated/prisma/enums';

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Remember (or refresh) the caller's device. A token re-registered by
   * another user — a shared or handed-over device — moves to them.
   */
  async register(
    userId: string,
    input: { token: string; platform: DevicePlatform },
  ): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token: input.token },
      create: {
        userId: userId,
        token: input.token,
        platform: input.platform,
        lastSeenAt: new Date(),
      },
      update: {
        userId: userId,
        platform: input.platform,
        lastSeenAt: new Date(),
      },
    });
  }

  /** Forget the caller's device. Someone else's token is never touched. */
  async unregister(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({
      where: { token: token, userId: userId },
    });
  }

  /** Every registered device of these users (for push fan-out). */
  async findTokens(
    userIds: string[],
  ): Promise<{ userId: string; token: string }[]> {
    if (userIds.length === 0) return [];
    return this.prisma.deviceToken.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, token: true },
    });
  }
}
