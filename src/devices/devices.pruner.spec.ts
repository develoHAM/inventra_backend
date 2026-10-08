import { Logger } from '@nestjs/common';
import { DevicesPruner, STALE_DEVICE_DAYS } from './devices.pruner';

describe('DevicesPruner', () => {
  let pruner: DevicesPruner;
  let prisma: { deviceToken: { deleteMany: jest.Mock } };

  // Freeze "now" so the 60-day cutoff is an exact, assertable Date.
  const now = new Date('2026-10-09T03:00:00.000Z');
  const sixtyDaysAgo = new Date('2026-08-10T03:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers({ now: now });
    prisma = {
      deviceToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    pruner = new DevicesPruner(prisma as any);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('the staleness window is 60 days', () => {
    expect(STALE_DEVICE_DAYS).toBe(60);
  });

  it('deletes devices whose app has not re-registered in 60 days', async () => {
    await pruner.pruneStaleDevices();

    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { lastSeenAt: { lt: sixtyDaysAgo } },
    });
  });

  it('returns how many were pruned and logs it', async () => {
    prisma.deviceToken.deleteMany.mockResolvedValue({ count: 3 });

    await expect(pruner.pruneStaleDevices()).resolves.toBe(3);
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Pruned 3 stale device(s)',
    );
  });

  it('stays quiet when nothing is stale', async () => {
    await expect(pruner.pruneStaleDevices()).resolves.toBe(0);
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('runs once a day at 3 AM', () => {
    // @Cron stores its schedule as metadata on the method; read it back.
    const cronOptions = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      DevicesPruner.prototype.pruneStaleDevices,
    );

    expect(cronOptions.cronTime).toBe('0 03 * * *');
  });
});
