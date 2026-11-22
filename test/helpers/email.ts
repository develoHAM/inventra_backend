import { INestApplication } from '@nestjs/common';
import request from 'supertest';

/** Nest types its HTTP server as `any`; supertest wants its own type. */
type HttpServer = Parameters<typeof request>[0];

/** Mailpit's API: every email the app sends in the e2e lands here. */
export const MAILPIT_API = `http://localhost:${process.env.MAILPIT_UI_PORT ?? 8025}/api/v1`;

/** Delivery is asynchronous (event → queue → worker → SMTP): poll for it. */
export async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Every message Mailpit holds for `address`, newest first. */
export async function inbox(
  address: string,
): Promise<{ ID: string; Subject: string }[]> {
  const response = await fetch(
    `${MAILPIT_API}/search?query=${encodeURIComponent(`to:${address}`)}`,
  );
  const body = (await response.json()) as {
    messages: { ID: string; Subject: string }[];
  };
  return body.messages;
}

/** Empty `address`'s inbox, so an earlier run can't make a check pass. */
export async function clearInbox(address: string): Promise<void> {
  await fetch(
    `${MAILPIT_API}/search?query=${encodeURIComponent(`to:${address}`)}`,
    { method: 'DELETE' },
  );
}

/**
 * The real proof of an address: POST /auth/email/start → the 6-digit code
 * from the email Mailpit received → POST /auth/email/confirm. Returns the
 * single-use emailVerificationToken. Waits for a NEW message, so older
 * mail in the inbox can't be mistaken for the code.
 */
export async function emailProof(
  app: INestApplication,
  address: string,
): Promise<string> {
  const http = app.getHttpServer() as HttpServer;
  const seen = new Set((await inbox(address)).map((message) => message.ID));

  await request(http)
    .post('/auth/email/start')
    .send({ email: address })
    .expect(200);
  const messageId = await waitFor(async () => {
    const fresh = (await inbox(address)).find(
      (message) => !seen.has(message.ID),
    );
    return fresh?.ID ?? null;
  });
  const message = (await (
    await fetch(`${MAILPIT_API}/message/${messageId}`)
  ).json()) as { Text: string };
  const code = message.Text.match(/\[(\d{6})\]/)?.[1];
  if (!code) {
    throw new Error(`no code in the email to ${address}`);
  }

  const confirmed = await request(http)
    .post('/auth/email/confirm')
    .send({ email: address, code: code })
    .expect(200);
  return (confirmed.body as { emailVerificationToken: string })
    .emailVerificationToken;
}
