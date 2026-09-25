export interface OutgoingMessage {
  to: string; // email address, phone number, or device token
  subject?: string;
  body: string;
}

export interface NotificationSender {
  send(message: OutgoingMessage): Promise<void>;
}
