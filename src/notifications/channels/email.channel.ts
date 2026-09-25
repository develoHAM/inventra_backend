import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import { Env } from '../../config/env.schema';
import { NotificationSender, OutgoingMessage } from './notification-channel';

@Injectable()
export class EmailChannel implements NotificationSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    const port = config.get('SMTP_PORT', { infer: true });
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASS', { infer: true });
    this.transporter = nodemailer.createTransport({
      host: config.get('SMTP_HOST', { infer: true }),
      port: port,
      secure: port === 465, // implicit TLS on 465; STARTTLS/plain otherwise
      auth: user ? { user: user, pass: pass } : undefined,
    });
    this.from = config.get('SMTP_FROM', { infer: true });
  }

  async send(message: OutgoingMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject ?? '',
      text: message.body,
    });
  }
}
