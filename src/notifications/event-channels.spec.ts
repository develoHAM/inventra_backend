import { EVENT_CHANNELS } from './event-channels';
import { NotificationEvent } from './notification-events';
import { NotificationChannel } from '../generated/prisma/enums';

describe('EVENT_CHANNELS', () => {
  it('has an entry for every notification event', () => {
    expect(Object.keys(EVENT_CHANNELS).sort()).toEqual(
      Object.values(NotificationEvent).sort(),
    );
  });

  it.each(Object.values(NotificationEvent))(
    '%s goes out by email AND push (decision 2026-09-27)',
    (event) => {
      expect(EVENT_CHANNELS[event]).toEqual([
        NotificationChannel.EMAIL,
        NotificationChannel.PUSH,
      ]);
    },
  );
});
