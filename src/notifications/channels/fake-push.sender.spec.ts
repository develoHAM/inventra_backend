import { Logger } from '@nestjs/common';
import { FakePushSender } from './fake-push.sender';
import { DeadDeviceTokenError } from './push-sender';

describe('FakePushSender', () => {
  let sender: FakePushSender;

  beforeEach(() => {
    sender = new FakePushSender();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('records every push in its outbox and logs it', async () => {
    await sender.send({ to: 'phone-token', subject: 'Title', body: 'Body' });

    expect(sender.sent).toEqual([
      { to: 'phone-token', subject: 'Title', body: 'Body' },
    ]);
    expect(Logger.prototype.log).toHaveBeenCalled();
  });

  it('lastMessageTo returns the newest push for a token', async () => {
    await sender.send({ to: 'phone-token', subject: 'First', body: '1' });
    await sender.send({ to: 'other-token', subject: 'Other', body: 'x' });
    await sender.send({ to: 'phone-token', subject: 'Second', body: '2' });

    expect(sender.lastMessageTo('phone-token')?.subject).toBe('Second');
    expect(sender.lastMessageTo('unknown-token')).toBeUndefined();
  });

  it('a token marked dead fails like FCM would, and nothing is recorded', async () => {
    sender.markDead('stale-token');

    await expect(
      sender.send({ to: 'stale-token', subject: 'Title', body: 'Body' }),
    ).rejects.toBeInstanceOf(DeadDeviceTokenError);
    expect(sender.sent).toEqual([]);
  });

  it('DeadDeviceTokenError carries the token', () => {
    const error = new DeadDeviceTokenError('stale-token');

    expect(error.token).toBe('stale-token');
    expect(error.message).toBe('device token unregistered');
    expect(error).toBeInstanceOf(Error);
  });
});
