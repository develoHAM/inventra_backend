import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FakePhoneVerifier } from '../../src/phone-verification/verifiers/fake.verifier';

/**
 * Unique phone numbers per suite. Every e2e suite shares one database (one
 * reset per run) and users.phone is unique, so each suite gets its own
 * block: 010 + 2-digit suite number + 6-digit counter.
 *
 *   const nextPhone = testPhones(7);
 *   nextPhone(); // → '01007000001'
 *   nextPhone(); // → '01007000002'
 */
export function testPhones(suiteNumber: number): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `010${String(suiteNumber).padStart(2, '0')}${String(counter).padStart(6, '0')}`;
  };
}

/**
 * The whole OCTOMO flow for one phone, as a test: start → "the user texts
 * the code" (the fake verifier records it) → confirm. Returns the token
 * that signup consumes.
 */
export async function verifiedPhoneToken(
  app: INestApplication,
  phone: string,
): Promise<string> {
  const http = app.getHttpServer();
  const started = await request(http)
    .post('/auth/phone/start')
    .send({ phone: phone, purpose: 'SIGNUP' })
    .expect(200);

  app
    .get(FakePhoneVerifier)
    .receive(normalizedDigits(phone), started.body.code as string);

  const confirmed = await request(http)
    .post('/auth/phone/confirm')
    .send({ verificationId: started.body.verificationId })
    .expect(200);
  return confirmed.body.verificationToken as string;
}

/** A fresh unique phone plus a valid SIGNUP token for it. */
export async function verifiedPhone(
  app: INestApplication,
  nextPhone: () => string,
): Promise<{ phone: string; token: string }> {
  const phone = nextPhone();
  return { phone: phone, token: await verifiedPhoneToken(app, phone) };
}

// The API stores digits only; the fake is keyed by what the service sees.
function normalizedDigits(phone: string): string {
  return phone.replace(/[-\s]/g, '');
}
