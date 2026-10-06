import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DevicePlatform } from '../generated/prisma/enums';
import { PUSH_SENDER } from '../notifications/notifications.constants';
import type { PushSender } from '../notifications/channels/push-sender';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  /**
   * Remember (or refresh) the caller's device. The token is checked with the
   * push provider first, so garbage never enters the table. A token
   * re-registered by another user — a shared or handed-over device — moves
   * to them.
   */
  async register(
    userId: string,
    input: { token: string; platform: DevicePlatform },
  ): Promise<void> {
    // Fail open: if the provider can't answer, store the token anyway —
    // missing every push until the next launch would be worse.
    let isValid = true;
    try {
      isValid = await this.push.isValidToken(input.token);
    } catch {
      this.logger.warn(
        'Could not validate a device token (push provider unreachable); storing it anyway',
      );
    }
    if (!isValid) throw new BadRequestException('Invalid device token');

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
