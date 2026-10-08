import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/** A device whose app hasn't launched (re-registered) in this long is presumed abandoned. */
export const STALE_DEVICE_DAYS = 60;

@Injectable()
export class DevicesPruner {
  private readonly logger = new Logger(DevicesPruner.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dead-token cleanup only happens when we push to a token; a device nobody
   * uses any more would be pushed to (and fail) until FCM expires it. If one
   * was still in use, its app simply re-registers on next launch.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneStaleDevices(): Promise<number> {
    const cutoff = new Date(
      Date.now() - STALE_DEVICE_DAYS * 24 * 60 * 60 * 1000,
    );
    const result = await this.prisma.deviceToken.deleteMany({
      where: { lastSeenAt: { lt: cutoff } },
    });
    if (result.count > 0) {
      this.logger.log(`Pruned ${result.count} stale device(s)`);
    }
    return result.count;
  }
}
