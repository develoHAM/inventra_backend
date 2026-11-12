import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeSocialVerifier } from '../src/social-auth/verifiers/fake.verifier';
import type {
  SocialIdentity,
  SocialProvider,
} from '../src/social-auth/verifiers/social-identity-verifier';
import { testPhones, verifiedPhone, verifiedPhoneToken } from './helpers/phone';

// Emailed codes travel through the queue to Mailpit: allow polling.
jest.setTimeout(30_000);

/**
 * Social login end to end, with SOCIAL_VERIFIER=fake standing in for the
 * providers: sign-in (SIGNUP_REQUIRED → signup with the ticket → LOGGED_IN),
 * nonces, a member whose contact email is proven by an emailed code read
 * from Mailpit, login methods (link, add a password, unlink), find-my-ID,
 * lowercase emails and one account per password email.
 */
describe('Social login (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fake: FakeSocialVerifier;
  let http: any;

  const mailpitApi = `http://localhost:${process.env.MAILPIT_UI_PORT ?? 8025}/api/v1`;
  // users.phone is unique across the shared DB: suite 15's own block
  const nextPhone = testPhones(15);

  /** A provider identity the fake will vouch for, behind `credentialToken`. */
  const vouchFor = (
    credentialToken: string,
    identity: Partial<SocialIdentity> & {
      provider: SocialProvider;
      providerUserId: string;
    },
  ) =>
    fake.register(credentialToken, {
      email: null,
      emailVerified: false,
      name: null,
      refreshToken: null,
      ...identity,
    });

  const newNonce = async (): Promise<string> =>
    (await request(http).post('/auth/social/nonce').expect(200)).body.nonce;

  const socialLogin = (
    provider: SocialProvider,
    credentialToken: string,
    nonce?: string,
  ) =>
    request(http)
      .post('/auth/social/login')
      .send({
        provider: provider,
        credential: { token: credentialToken },
        ...(nonce === undefined ? {} : { nonce: nonce }),
      });

  /** Sign in with an identity we have never seen: its signup ticket. */
  const signupTicketFor = async (
    provider: SocialProvider,
    credentialToken: string,
  ): Promise<string> => {
    const response = await socialLogin(
      provider,
      credentialToken,
      await newNonce(),
    ).expect(200);
    expect(response.body.status).toBe('SIGNUP_REQUIRED');
    return response.body.signupToken;
  };

  const authed = (accessToken: string) => ({
    get: (path: string) =>
      request(http).get(path).set('Authorization', `Bearer ${accessToken}`),
    post: (path: string) =>
      request(http).post(path).set('Authorization', `Bearer ${accessToken}`),
    delete: (path: string) =>
      request(http).delete(path).set('Authorization', `Bearer ${accessToken}`),
  });

  // Delivery is asynchronous, so poll instead of asserting once.
  const waitFor = async <T>(
    probe: () => Promise<T | null>,
    timeoutMs = 10_000,
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  };

  /** The 6-digit code in the newest email Mailpit received for `address`. */
  const emailedCode = async (address: string): Promise<string> => {
    const messageId = await waitFor(async () => {
      const search = (await (
        await fetch(
          `${mailpitApi}/search?query=${encodeURIComponent(`to:${address}`)}`,
        )
      ).json()) as { messages: { ID: string }[] };
      return search.messages[0]?.ID ?? null;
    });
    const message = (await (
      await fetch(`${mailpitApi}/message/${messageId}`)
    ).json()) as { Text: string };
    const code = message.Text.match(/\[(\d{6})\]/)?.[1];
    if (!code) throw new Error(`no code in the email to ${address}`);
    return code;
  };

  /** POST /auth/email/start → the code from Mailpit → POST /auth/email/confirm. */
  const emailProofFor = async (typed: string): Promise<string> => {
    await request(http)
      .post('/auth/email/start')
      .send({ email: typed })
      .expect(200);
    const code = await emailedCode(typed.trim().toLowerCase());
    const confirmed = await request(http)
      .post('/auth/email/confirm')
      .send({ email: typed, code: code })
      .expect(200);
    return confirmed.body.emailVerificationToken;
  };

  const clearMailbox = (address: string) =>
    fetch(`${mailpitApi}/search?query=${encodeURIComponent(`to:${address}`)}`, {
      method: 'DELETE',
    });

  // shared across the steps below (run in order, --runInBand)
  let ownerPhone: string;
  let ownerUserId: string;
  let ownerAccess: string;
  let joinCode: string;
  let memberUserId: string;
  let memberAccess: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    fake = app.get(FakeSocialVerifier);
    http = app.getHttpServer();

    // an earlier run must not make the Mailpit checks pass
    await clearMailbox('member@social.test');
    await clearMailbox('owner-pw@social.test');

    // the identities "the providers" will vouch for in this suite
    vouchFor('kakao-owner', {
      provider: 'kakao',
      providerUserId: 'e2e-kakao-owner',
      email: 'Owner@Social.TEST', // mixed case: stored lowercase
      emailVerified: true,
      name: 'Social Owner',
    });
    vouchFor('apple-member', {
      provider: 'apple',
      providerUserId: 'e2e-apple-member',
      email: null, // Apple, a later sign-in: no email at all
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('sign-in and signup', () => {
    let ownerTicket: string;

    it('an unknown identity → SIGNUP_REQUIRED, with a ticket and the profile (email lowercased)', async () => {
      const response = await socialLogin(
        'kakao',
        'kakao-owner',
        await newNonce(),
      ).expect(200);

      expect(response.body).toEqual({
        status: 'SIGNUP_REQUIRED',
        signupToken: expect.any(String),
        expiresInSeconds: 900,
        profile: {
          email: 'owner@social.test',
          emailVerified: true,
          name: 'Social Owner',
        },
      });
      ownerTicket = response.body.signupToken;
    });

    it('the owner signs up with the ticket: a Kakao login, no password; the verified email becomes the contact email', async () => {
      const phone = await verifiedPhone(app, nextPhone);
      ownerPhone = phone.phone;

      const response = await request(http)
        .post('/auth/register')
        .send({
          companyName: 'Social Co',
          taxId: '815-00-00001',
          ownerName: 'Social Owner',
          ownerPhone: phone.phone,
          ownerPhoneVerificationToken: phone.token,
          credentials: { type: 'social', signupToken: ownerTicket },
        })
        .expect(201);
      ownerUserId = response.body.user.id;

      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: ownerUserId },
        include: { account: { include: { loginMethods: true } } },
      });
      expect(owner.contactEmail).toBe('owner@social.test');
      // the logins belong to the sign-in (the account)
      expect(owner.account.loginMethods).toEqual([
        expect.objectContaining({
          method: 'kakao',
          providerUserId: 'e2e-kakao-owner',
          email: 'owner@social.test',
          passwordHash: null,
        }),
      ]);
      joinCode = (await prisma.company.findFirstOrThrow({
        where: { createdByUserId: ownerUserId },
      }))!.joinCode;
    });

    it('the same ticket cannot be spent twice → 400', async () => {
      const phone = await verifiedPhone(app, nextPhone);

      const response = await request(http)
        .post('/auth/register')
        .send({
          companyName: 'Social Co Again',
          taxId: '815-00-00002',
          ownerName: 'Social Owner',
          ownerPhone: phone.phone,
          ownerPhoneVerificationToken: phone.token,
          credentials: { type: 'social', signupToken: ownerTicket },
        })
        .expect(400);
      expect(response.body.message).toBe('Invalid or expired signup token');
    });

    it('signing in again → LOGGED_IN with OUR tokens (the same shape as password login)', async () => {
      const response = await socialLogin(
        'kakao',
        'kakao-owner',
        await newNonce(),
      ).expect(200);

      expect(response.body).toEqual({
        status: 'LOGGED_IN',
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        user: expect.objectContaining({ id: ownerUserId }),
      });
      ownerAccess = response.body.accessToken;
      const me = await authed(ownerAccess).get('/auth/me').expect(200);
      expect(me.body.id).toBe(ownerUserId);
    });

    it('a nonce works once: replaying it → 401', async () => {
      const nonce = await newNonce();
      await socialLogin('kakao', 'kakao-owner', nonce).expect(200);

      const replay = await socialLogin('kakao', 'kakao-owner', nonce).expect(
        401,
      );
      expect(replay.body.message).toBe('Invalid social credential');
    });

    it('a credential no provider vouches for → 401', async () => {
      await socialLogin('kakao', 'made-up-token', await newNonce()).expect(401);
    });

    it('a Kakao credential on the Google route → 401', async () => {
      await socialLogin('google', 'kakao-owner', await newNonce()).expect(401);
    });

    it('an unknown provider → 400', async () => {
      await request(http)
        .post('/auth/social/login')
        .send({ provider: 'twitter', credential: { token: 'kakao-owner' } })
        .expect(400);
    });
  });

  describe('a member whose provider shared no email', () => {
    const registerMember = (body: Record<string, unknown>) =>
      request(http)
        .post('/auth/register/member')
        .send({ joinCode: joinCode, name: 'Social Member', ...body });
    let memberTicket: string;
    let memberPhone: { phone: string; token: string };

    it('without a proven contact email → 400, and nothing is spent (the transaction rolls back)', async () => {
      memberTicket = await signupTicketFor('apple', 'apple-member');
      memberPhone = await verifiedPhone(app, nextPhone);

      const response = await registerMember({
        phone: memberPhone.phone,
        phoneVerificationToken: memberPhone.token,
        credentials: { type: 'social', signupToken: memberTicket },
      }).expect(400);
      expect(response.body.message).toBe(
        'A verified contact email is required',
      );
    });

    it('the code goes out as a REDACTED email: the notifications table never holds it', async () => {
      await request(http)
        .post('/auth/email/start')
        .send({ email: 'member@social.test' })
        .expect(200);
      const code = await emailedCode('member@social.test');

      const row = await prisma.notification.findFirstOrThrow({
        where: {
          eventType: 'email.verificationCode',
          recipientAddress: 'member@social.test',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.redacted).toBe(true);
      expect(row.body).toContain('******');
      expect(row.body).not.toContain(code);
    });

    it('with the code proven, the SAME ticket and phone token now sign the member up', async () => {
      const code = await emailedCode('member@social.test');
      const confirmed = await request(http)
        .post('/auth/email/confirm')
        .send({ email: 'Member@Social.test', code: code })
        .expect(200);

      const response = await registerMember({
        phone: memberPhone.phone,
        phoneVerificationToken: memberPhone.token,
        credentials: {
          type: 'social',
          signupToken: memberTicket,
          contactEmail: 'Member@Social.TEST', // stored lowercase
          emailVerificationToken: confirmed.body.emailVerificationToken,
        },
      }).expect(201);
      memberUserId = response.body.user.id;

      const member = await prisma.user.findUniqueOrThrow({
        where: { id: memberUserId },
        include: { account: { include: { loginMethods: true } } },
      });
      expect(member.contactEmail).toBe('member@social.test');
      // the logins belong to the sign-in (the account)
      expect(member.account.loginMethods).toEqual([
        expect.objectContaining({
          method: 'apple',
          providerUserId: 'e2e-apple-member',
          email: null,
        }),
      ]);
      memberAccess = (
        await socialLogin('apple', 'apple-member', await newNonce()).expect(200)
      ).body.accessToken;
    });

    it('find-my-ID tells a social-only member HOW they sign in', async () => {
      const token = await verifiedPhoneToken(app, memberPhone.phone, 'FIND_ID');

      const response = await request(http)
        .post('/auth/find-id')
        .send({ phone: memberPhone.phone, phoneVerificationToken: token })
        .expect(200);
      expect(response.body).toEqual({ email: null, providers: ['apple'] });
    });
  });

  describe('the same identity signing up twice at once (two tickets)', () => {
    it('exactly one account; the other request gets 409', async () => {
      vouchFor('google-twice', {
        provider: 'google',
        providerUserId: 'e2e-google-twice',
        email: 'twice@social.test',
        emailVerified: true,
      });
      const tickets = [
        await signupTicketFor('google', 'google-twice'),
        await signupTicketFor('google', 'google-twice'),
      ];
      const phones = [
        await verifiedPhone(app, nextPhone),
        await verifiedPhone(app, nextPhone),
      ];

      const responses = await Promise.all(
        tickets.map((ticket, index) =>
          request(http)
            .post('/auth/register/member')
            .send({
              joinCode: joinCode,
              name: `Twice ${index}`,
              phone: phones[index].phone,
              phoneVerificationToken: phones[index].token,
              credentials: { type: 'social', signupToken: ticket },
            }),
        ),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409,
      ]);
      expect(
        responses.find((response) => response.status === 409)!.body.message,
      ).toBe('This account is already registered');
      expect(
        await prisma.userLoginMethod.count({
          where: { method: 'google', providerUserId: 'e2e-google-twice' },
        }),
      ).toBe(1);
    });
  });

  describe('login methods', () => {
    it("lists the owner's logins (a provider's email is not shown)", async () => {
      const response = await authed(ownerAccess)
        .get('/users/me/login-methods')
        .expect(200);

      expect(response.body).toEqual([
        { id: expect.any(String), method: 'kakao', email: null },
      ]);
    });

    it('links Apple (proven like a sign-in, nonce included)', async () => {
      vouchFor('apple-owner', {
        provider: 'apple',
        providerUserId: 'e2e-apple-owner',
        refreshToken: 'apple-refresh-for-revoke',
      });

      const response = await authed(ownerAccess)
        .post('/users/me/login-methods')
        .send({
          provider: 'apple',
          credential: { token: 'apple-owner' },
          nonce: await newNonce(),
        })
        .expect(201);
      expect(response.body).toEqual({
        id: expect.any(String),
        method: 'apple',
        email: null,
      });

      const stored = await prisma.userLoginMethod.findFirstOrThrow({
        where: {
          account: { profiles: { some: { id: ownerUserId } } },
          method: 'apple',
        },
      });
      expect(stored.refreshToken).not.toBe('apple-refresh-for-revoke'); // encrypted
    });

    it("relinking an identity you already have → 409 'already linked to you'", async () => {
      vouchFor('apple-member-again', {
        provider: 'apple',
        providerUserId: 'e2e-apple-member', // the member's own Apple account
      });

      const response = await authed(memberAccess)
        .post('/users/me/login-methods')
        .send({
          provider: 'apple',
          credential: { token: 'apple-member-again' },
        })
        .expect(409);
      expect(response.body.message).toBe(
        'This account is already linked to you',
      );
    });

    it("an identity linked to someone else → 409 'linked to another user', nothing changes", async () => {
      vouchFor('kakao-owner-for-member', {
        provider: 'kakao',
        providerUserId: 'e2e-kakao-owner', // the OWNER's Kakao account
      });

      const response = await authed(memberAccess)
        .post('/users/me/login-methods')
        .send({
          provider: 'kakao',
          credential: { token: 'kakao-owner-for-member' },
        })
        .expect(409);
      expect(response.body.message).toBe(
        'This account is linked to another user',
      );
      expect(
        await prisma.userLoginMethod.count({
          where: { account: { profiles: { some: { id: memberUserId } } } },
        }),
      ).toBe(1);
    });

    it("a second login from a provider you already have → 409 'unlink it first'", async () => {
      vouchFor('apple-owner-second', {
        provider: 'apple',
        providerUserId: 'e2e-apple-owner-2', // a different Apple account, held by nobody
      });

      const response = await authed(ownerAccess)
        .post('/users/me/login-methods')
        .send({
          provider: 'apple',
          credential: { token: 'apple-owner-second' },
        })
        .expect(409);
      expect(response.body.message).toBe(
        'You already have a login with this provider; unlink it first',
      );
    });

    it('adds a password (email proven by code); then password login works in ANY letter case', async () => {
      const proof = await emailProofFor('owner-pw@social.test');

      const response = await authed(ownerAccess)
        .post('/users/me/login-methods/local')
        .send({
          email: 'Owner-PW@Social.test',
          password: 'social-owner-password',
          emailVerificationToken: proof,
        })
        .expect(201);
      expect(response.body).toEqual({
        id: expect.any(String),
        method: 'local',
        email: 'ow***@social.test',
      });

      await request(http)
        .post('/auth/login')
        .send({
          email: 'OWNER-PW@SOCIAL.TEST',
          password: 'social-owner-password',
        })
        .expect(201);
    });

    it('nobody else can take that password email, whatever the letter case → 409', async () => {
      const phone = await verifiedPhone(app, nextPhone);

      const response = await request(http)
        .post('/auth/register/member')
        .send({
          joinCode: joinCode,
          name: 'Copycat',
          phone: phone.phone,
          phoneVerificationToken: phone.token,
          credentials: {
            type: 'password',
            email: 'Owner-Pw@SOCIAL.test',
            password: 'password123',
          },
        })
        .expect(409);
      expect(response.body.message).toBe('Email already registered');
    });

    it('find-my-ID shows the password email (masked) AND the providers', async () => {
      const token = await verifiedPhoneToken(app, ownerPhone, 'FIND_ID');

      const response = await request(http)
        .post('/auth/find-id')
        .send({ phone: ownerPhone, phoneVerificationToken: token })
        .expect(200);
      expect(response.body).toEqual({
        email: 'ow***@social.test',
        providers: ['kakao', 'apple'],
      });
    });

    it('unlinks Apple: gone from the list, and Apple is asked to forget us (with the decrypted token)', async () => {
      const apple = await prisma.userLoginMethod.findFirstOrThrow({
        where: {
          account: { profiles: { some: { id: ownerUserId } } },
          method: 'apple',
        },
      });

      await authed(ownerAccess)
        .delete(`/users/me/login-methods/${apple.id}`)
        .expect(204);

      const list = await authed(ownerAccess)
        .get('/users/me/login-methods')
        .expect(200);
      expect(
        list.body.map((login: { method: string }) => login.method),
      ).toEqual(['kakao', 'local']);
      expect(fake.disconnected).toContainEqual({
        provider: 'apple',
        providerUserId: 'e2e-apple-owner',
        refreshToken: 'apple-refresh-for-revoke',
      });
    });

    it("someone else's login id → 404; a malformed id → 400", async () => {
      const membersLogin = await prisma.userLoginMethod.findFirstOrThrow({
        where: { account: { profiles: { some: { id: memberUserId } } } },
      });

      await authed(ownerAccess)
        .delete(`/users/me/login-methods/${membersLogin.id}`)
        .expect(404);
      await authed(ownerAccess)
        .delete('/users/me/login-methods/not-a-uuid')
        .expect(400);
    });

    it('unlinks down to one login; the last one → 409', async () => {
      const local = await prisma.userLoginMethod.findFirstOrThrow({
        where: {
          account: { profiles: { some: { id: ownerUserId } } },
          method: 'local',
        },
      });
      await authed(ownerAccess)
        .delete(`/users/me/login-methods/${local.id}`)
        .expect(204);

      const kakao = await prisma.userLoginMethod.findFirstOrThrow({
        where: {
          account: { profiles: { some: { id: ownerUserId } } },
          method: 'kakao',
        },
      });
      const response = await authed(ownerAccess)
        .delete(`/users/me/login-methods/${kakao.id}`)
        .expect(409);
      expect(response.body.message).toBe(
        'An account needs at least one way to sign in',
      );
    });
  });
});
