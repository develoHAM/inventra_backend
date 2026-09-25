import nodemailer from 'nodemailer';
import { EmailChannel } from './email.channel';

// Replace nodemailer entirely: no real SMTP connection is ever opened.
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn() },
}));

describe('EmailChannel', () => {
  let sendMail: jest.Mock;
  const createTransport = nodemailer.createTransport as jest.Mock;

  // A fake ConfigService backed by a plain object of env values.
  const configWith = (values: Record<string, unknown>) =>
    ({ get: jest.fn((key: string) => values[key]) }) as any;

  const mailpitEnv = {
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    SMTP_FROM: 'Inventra <no-reply@inventra.local>',
  };

  beforeEach(() => {
    sendMail = jest.fn().mockResolvedValue({ messageId: 'm-1' });
    createTransport.mockReset();
    createTransport.mockReturnValue({ sendMail: sendMail });
  });

  it('builds a plain, unauthenticated transport for Mailpit (port 1025)', () => {
    new EmailChannel(configWith(mailpitEnv));

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      host: 'localhost',
      port: 1025,
      secure: false,
      auth: undefined,
    });
  });

  it('uses implicit TLS on 465 and passes credentials when SMTP_USER is set', () => {
    new EmailChannel(
      configWith({
        ...mailpitEnv,
        SMTP_HOST: 'smtp.provider.test',
        SMTP_PORT: 465,
        SMTP_USER: 'apikey',
        SMTP_PASS: 's3cret',
      }),
    );

    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.provider.test',
      port: 465,
      secure: true,
      auth: { user: 'apikey', pass: 's3cret' },
    });
  });

  it('send() delivers a plain-text mail from SMTP_FROM', async () => {
    const channel = new EmailChannel(configWith(mailpitEnv));

    await channel.send({
      to: 'owner@example.com',
      subject: 'Approved',
      body: 'Your company was approved.',
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'Inventra <no-reply@inventra.local>',
      to: 'owner@example.com',
      subject: 'Approved',
      text: 'Your company was approved.',
    });
  });

  it('send() uses an empty subject when none is given', async () => {
    const channel = new EmailChannel(configWith(mailpitEnv));

    await channel.send({ to: 'owner@example.com', body: 'hi' });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: '' }),
    );
  });

  it('send() propagates transport failures (so the worker can retry)', async () => {
    sendMail.mockRejectedValue(new Error('ECONNREFUSED'));
    const channel = new EmailChannel(configWith(mailpitEnv));

    await expect(
      channel.send({ to: 'owner@example.com', body: 'hi' }),
    ).rejects.toThrow('ECONNREFUSED');
  });
});
