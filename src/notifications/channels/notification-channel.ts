export interface OutgoingMessage {
  to: string; // email address, phone number, or device token
  subject?: string;
  body: string;
  data?: Record<string, string>; // push only: deep-link payload for the app
}

export interface NotificationSender {
  send(message: OutgoingMessage): Promise<void>;
}
