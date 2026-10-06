import { Injectable, Logger } from '@nestjs/common';
import { NotificationSender, OutgoingMessage } from './notification-channel';
import { DeadDeviceTokenError, PushSender } from './push-sender';

/** Dev/e2e push: nothing leaves the machine. Keeps an outbox for tests. */
@Injectable()
export class FakePushSender implements PushSender {
  private readonly logger = new Logger(FakePushSender.name);
  private readonly deadTokens = new Set<string>();
  readonly sent: OutgoingMessage[] = [];

  async send(message: OutgoingMessage): Promise<void> {
    if (this.deadTokens.has(message.to)) {
      throw new DeadDeviceTokenError(message.to);
    }
    this.sent.push(message);
    this.logger.log(
      `PUSH to ${message.to}: ${message.subject} — ${message.body}`,
    );
  }

  lastMessageTo(token: string): OutgoingMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === token);
  }

  /** Tests: make this token fail the way FCM fails an uninstalled app. */
  markDead(token: string): void {
    this.deadTokens.add(token);
  }

  async isValidToken(token: string): Promise<boolean> {
    return !this.deadTokens.has(token);
  }
}
