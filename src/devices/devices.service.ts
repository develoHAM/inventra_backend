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
   * Remember (or refresh) the caller's device, on their account: every
   * company's notifications reach it, whichever company is open. The token is
   * checked with the push provider first, so garbage never enters the table.
   * A token re-registered by another account — a shared or handed-over
   * device — moves to it.
   */
  async register(
    accountId: string,
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
        accountId: accountId,
        token: input.token,
        platform: input.platform,
        lastSeenAt: new Date(),
      },
      update: {
        accountId: accountId,
        platform: input.platform,
        lastSeenAt: new Date(),
      },
    });
  }

  /** Forget the caller's device. Another account's token is never touched. */
  async unregister(accountId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({
      where: { token: token, accountId: accountId },
    });
  }

  /** Every registered device of these accounts (for push fan-out). */
  async findTokens(
    accountIds: string[],
  ): Promise<{ accountId: string; token: string }[]> {
    if (accountIds.length === 0) return [];
    return this.prisma.deviceToken.findMany({
      where: { accountId: { in: accountIds } },
      select: { accountId: true, token: true },
    });
  }
}
