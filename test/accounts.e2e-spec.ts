import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { notificationTemplates } from '../src/notifications/notification-templates';
import { testPhones, verifiedPhone } from './helpers/phone';
import { joinCompany, suiteAccounts, switchTo } from './helpers/accounts';
import type { OwnerSetup, Session } from './helpers/accounts';
import { waitFor } from './helpers/email';

/**
 * GET /me/companies, POST /me/companies/join and POST /me/companies: an
 * account made by POST /auth/signup (no company yet) joins or creates
 * companies, then opens one with POST /auth/switch. Then (Task 5) each
 * company profile gets its own name and a code-proven contact email.
 * Requires Postgres, Redis and Mailpit running.
 */
// Emails go through the queue to Mailpit and pushes through the worker:
// tests poll (up to 10 s), so Jest's 5 s default would cut a wait short.
jest.setTimeout(30_000);

describe('Join or create a company from a sign-in (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;
  let adminAccess: string;

  const password = 'password123';
  // accounts.phone is unique across the shared DB: suite 17's own block
  const nextPhone = testPhones(17);
  // tax IDs are unique too: this suite's own prefix
  const taxIdOf = (n: number) => `017-17-${String(n).padStart(5, '0')}`;

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  /** POST /auth/signup with a password: a session with no company open. */
  const signUp = async (email: string) => {
    const { phone, token } = await verifiedPhone(app, nextPhone);
    const res = await request(http)
      .post('/auth/signup')
      .send({
        phone: phone,
        phoneVerificationToken: token,
        credentials: { type: 'password', email: email, password: password },
      })
      .expect(201);
    return {
      accessToken: res.body.accessToken as string,
      refreshToken: res.body.refreshToken as string,
    };
  };

  const createCompany = (
    accessToken: string,
    taxIdNumber: number,
    companyName: string,
  ) =>
    request(http)
      .post('/me/companies')
      .set(...auth(accessToken))
      .send({
        companyName: companyName,
        taxId: taxIdOf(taxIdNumber),
        ownerName: 'Owner One',
      });

  const join = (accessToken: string, joinCode: string, name = 'Joiner Lee') =>
    request(http)
      .post('/me/companies/join')
      .set(...auth(accessToken))
      .send({ joinCode: joinCode, name: name });

  const myCompanies = async (accessToken: string) =>
    (
      await request(http)
        .get('/me/companies')
        .set(...auth(accessToken))
        .expect(200)
    ).body as Array<{ profileId: string; status: string; name: string }>;

  // no endpoint for a pending owner shows the code: read it from the DB
  const joinCodeOf = async (companyId: string) =>
    (await prisma.company.findUniqueOrThrow({ where: { id: companyId } }))
      .joinCode;

  let companyOneId: string;
  let companyTwoId: string;
  // company one's creator; Task 5 has them approve a member
  let owner: { accessToken: string; refreshToken: string };
  let ownerProfileId: string;

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
    http = app.getHttpServer();

    adminAccess = (
      await request(http)
        .post('/auth/login')
        .send({
          email: process.env.SEED_ADMIN_EMAIL,
          password: process.env.SEED_ADMIN_PASSWORD,
        })
        .expect(201)
    ).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('creating a company', () => {
    beforeAll(async () => {
      owner = await signUp('owner@accounts.e2e.test');
    });

    it('1. a new sign-in has no companies yet', async () => {
      await expect(myCompanies(owner.accessToken)).resolves.toEqual([]);
    });

    it('2. creating a company → 201: the company and its waiting OWNER profile', async () => {
      const res = await createCompany(owner.accessToken, 1, 'Accounts Co One');

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        profileId: expect.any(String),
        status: 'PENDING_APPROVAL',
        name: 'Owner One',
        profileImageUrl: null,
        role: { code: 'OWNER', name: expect.any(String) },
        company: { id: expect.any(String), name: 'Accounts Co One' },
      });
      companyOneId = res.body.company.id;
      ownerProfileId = res.body.profileId;
    });

    it('3. GET /me/companies lists it', async () => {
      const companies = await myCompanies(owner.accessToken);

      expect(companies).toHaveLength(1);
      expect(companies[0]).toMatchObject({
        status: 'PENDING_APPROVAL',
        company: { id: companyOneId },
      });
    });

    it('4. a second create while the first waits → 409, and no company is made', async () => {
      const res = await createCompany(owner.accessToken, 2, 'Accounts Co Two');

      expect(res.status).toBe(409);
      expect(res.body.message).toBe(
        'You already have a company waiting for approval',
      );
      await expect(
        prisma.company.count({ where: { taxId: taxIdOf(2) } }),
      ).resolves.toBe(0);
    });

    it('5. once the admin approves the first, a second create → 201', async () => {
      await request(http)
        .patch(`/companies/${companyOneId}/approve`)
        .set(...auth(adminAccess))
        .expect(200);

      const res = await createCompany(owner.accessToken, 2, 'Accounts Co Two');

      expect(res.status).toBe(201);
      companyTwoId = res.body.company.id;
      // oldest first: the approved one, then the new waiting one
      const companies = await myCompanies(owner.accessToken);
      expect(companies.map((company) => company.status)).toEqual([
        'ACTIVE',
        'PENDING_APPROVAL',
      ]);
    });

    it('6. a taken tax ID → 409, and the owner profile is rolled back with it', async () => {
      const latecomer = await signUp('latecomer@accounts.e2e.test');

      const res = await createCompany(latecomer.accessToken, 1, 'Copycat Co');

      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Tax ID already registered');
      await expect(myCompanies(latecomer.accessToken)).resolves.toEqual([]);
    });

    it('7. two creates at once by one account → one 201, one 409 (Review Focus 5)', async () => {
      const racer = await signUp('racer@accounts.e2e.test');

      const responses = await Promise.all([
        createCompany(racer.accessToken, 3, 'Race Co A'),
        createCompany(racer.accessToken, 4, 'Race Co B'),
      ]);

      expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
      const refused = responses.find((res) => res.status === 409)!;
      expect(refused.body.message).toBe(
        'You already have a company waiting for approval',
      );
      await expect(
        prisma.company.count({
          where: { taxId: { in: [taxIdOf(3), taxIdOf(4)] } },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('joining a company', () => {
    let joiner: { accessToken: string; refreshToken: string };
    let joinedProfileId: string;

    beforeAll(async () => {
      joiner = await signUp('joiner@accounts.e2e.test');
    });

    it('8. a code that is not 8 digits → 400 (validated like signup)', async () => {
      const res = await join(joiner.accessToken, '1234');

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(['joinCode must be 8 digits']);
    });

    it('9. joining with the code (typed with a dash) → 201: a waiting profile with no role', async () => {
      const code = await joinCodeOf(companyOneId);

      const res = await join(
        joiner.accessToken,
        `${code.slice(0, 4)}-${code.slice(4)}`,
      );

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        profileId: expect.any(String),
        status: 'PENDING_APPROVAL',
        name: 'Joiner Lee',
        profileImageUrl: null,
        role: null,
        company: { id: companyOneId, name: 'Accounts Co One' },
      });
      joinedProfileId = res.body.profileId;
    });

    it('10. GET /me/companies lists the join as PENDING_APPROVAL', async () => {
      await expect(myCompanies(joiner.accessToken)).resolves.toEqual([
        expect.objectContaining({
          profileId: joinedProfileId,
          status: 'PENDING_APPROVAL',
        }),
      ]);
    });

    it('11. joining the same company again → 409', async () => {
      const res = await join(
        joiner.accessToken,
        await joinCodeOf(companyOneId),
      );

      expect(res.status).toBe(409);
      expect(res.body.message).toBe(
        'You already belong to or are waiting for this company',
      );
    });

    it('12. two joins of another company at once → one 201, one 409 (Review Focus 5)', async () => {
      const code = await joinCodeOf(companyTwoId);

      const responses = await Promise.all([
        join(joiner.accessToken, code),
        join(joiner.accessToken, code),
      ]);

      expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
      const me = await request(http)
        .get('/auth/me')
        .set(...auth(joiner.accessToken))
        .expect(200);
      await expect(
        prisma.profile.count({
          where: { accountId: me.body.accountId, companyId: companyTwoId },
        }),
      ).resolves.toBe(1);
    });

    it('13. the new profile opens with POST /auth/switch', async () => {
      const res = await request(http)
        .post('/auth/switch')
        .set(...auth(joiner.accessToken))
        .send({ refreshToken: joiner.refreshToken, profileId: joinedProfileId })
        .expect(201);

      expect(res.body.profile).toMatchObject({
        id: joinedProfileId,
        status: 'PENDING_APPROVAL',
        companyId: companyOneId,
      });
    });
  });

  describe('the guessing brake (5 wrong codes per account per hour)', () => {
    const guesserEmail = 'guesser@accounts.e2e.test';
    let guesser: { accessToken: string; refreshToken: string };
    let wrongCode: string;

    /** An 8-digit code no company has. */
    const unusedJoinCode = async (): Promise<string> => {
      for (let n = 0; ; n += 1) {
        const code = String(n).padStart(8, '0');
        const taken = await prisma.company.findUnique({
          where: { joinCode: code },
        });
        if (!taken) return code;
      }
    };

    beforeAll(async () => {
      guesser = await signUp(guesserEmail);
      wrongCode = await unusedJoinCode();
    });

    it('14. wrong codes → 404 Invalid join code', async () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const res = await join(guesser.accessToken, wrongCode);
        expect(res.status).toBe(404);
        expect(res.body.message).toBe('Invalid join code');
      }
    });

    it('15. a right code in between still works, and is not counted', async () => {
      const res = await join(
        guesser.accessToken,
        await joinCodeOf(companyOneId),
      );

      expect(res.status).toBe(201);
    });

    it('16. the 5th wrong code → 404; the next try → 429', async () => {
      // had the right code counted, this would already be the 6th → 429
      expect((await join(guesser.accessToken, wrongCode)).status).toBe(404);

      const res = await join(guesser.accessToken, wrongCode);

      expect(res.status).toBe(429);
      expect(res.body.message).toBe(
        'Too many invite code attempts; try again later',
      );
      await expect(
        prisma.companyJoinAttempt.count({
          where: {
            account: { loginMethods: { some: { email: guesserEmail } } },
          },
        }),
      ).resolves.toBe(5);
    });

    it('17. once blocked, even a right code → 429 (a blocked account learns nothing)', async () => {
      const res = await join(
        guesser.accessToken,
        await joinCodeOf(companyTwoId),
      );

      expect(res.status).toBe(429);
    });

    it('18. the brake is per account: another account joins with that code', async () => {
      const neighbour = await signUp('neighbour@accounts.e2e.test');

      const res = await join(
        neighbour.accessToken,
        await joinCodeOf(companyTwoId),
      );

      expect(res.status).toBe(201);
    });
  });

  describe('the platform admin', () => {
    it('19. cannot join or create a company → 403', async () => {
      const joined = await join(adminAccess, await joinCodeOf(companyOneId));
      const created = await createCompany(adminAccess, 5, 'Admin Co');

      for (const res of [joined, created]) {
        expect(res.status).toBe(403);
        expect(res.body.message).toBe(
          'The platform admin cannot join or create companies',
        );
      }
    });
  });

  describe("each company's name and contact email (Task 5)", () => {
    const mailpitApi = `http://localhost:${process.env.MAILPIT_UI_PORT ?? 8025}/api/v1`;
    const contactEmail = 'lee.contact@accounts.e2e.test';
    let lee: { accessToken: string; refreshToken: string };
    let leeInCompanyOne: string; // profile ids
    let leeInCompanyTwo: string;
    let leeAccess: string; // with company one's profile open
    let proof: string;

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

    /** Every message Mailpit holds for `address`, newest first. */
    const inbox = async (address: string) =>
      (
        (await (
          await fetch(
            `${mailpitApi}/search?query=${encodeURIComponent(`to:${address}`)}`,
          )
        ).json()) as { messages: { ID: string; Subject: string }[] }
      ).messages;

    /** POST /auth/email/start → the code from Mailpit → POST /auth/email/confirm. */
    const emailProofFor = async (address: string): Promise<string> => {
      await request(http)
        .post('/auth/email/start')
        .send({ email: address })
        .expect(200);
      const messageId = await waitFor(
        async () => (await inbox(address))[0]?.ID ?? null,
      );
      const message = (await (
        await fetch(`${mailpitApi}/message/${messageId}`)
      ).json()) as { Text: string };
      const code = message.Text.match(/\[(\d{6})\]/)?.[1];
      if (!code) throw new Error(`no code in the email to ${address}`);
      const confirmed = await request(http)
        .post('/auth/email/confirm')
        .send({ email: address, code: code })
        .expect(200);
      return confirmed.body.emailVerificationToken as string;
    };

    beforeAll(async () => {
      // an earlier run must not make the Mailpit checks pass
      await fetch(
        `${mailpitApi}/search?query=${encodeURIComponent(`to:${contactEmail}`)}`,
        { method: 'DELETE' },
      );

      // Lee waits to join both companies, then opens company one's profile
      lee = await signUp('lee@accounts.e2e.test');
      leeInCompanyOne = (
        await join(lee.accessToken, await joinCodeOf(companyOneId), 'Lee')
      ).body.profileId;
      leeInCompanyTwo = (
        await join(lee.accessToken, await joinCodeOf(companyTwoId), 'Lee')
      ).body.profileId;
      leeAccess = (
        await request(http)
          .post('/auth/switch')
          .set(...auth(lee.accessToken))
          .send({ refreshToken: lee.refreshToken, profileId: leeInCompanyOne })
          .expect(201)
      ).body.accessToken;
    });

    it('20. with no company open, /profiles/me → 403 Choose a company first', async () => {
      const res = await request(http)
        .patch('/profiles/me')
        .set(...auth(lee.accessToken)) // signup's token: no profile in it
        .send({ name: 'Lee Ji-eun' });

      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Choose a company first');
    });

    it('21. a WAITING profile renames itself in this company → 200', async () => {
      const res = await request(http)
        .patch('/profiles/me')
        .set(...auth(leeAccess))
        .send({ name: 'Lee Ji-eun' })
        .expect(200);

      expect(res.body).toEqual({
        id: leeInCompanyOne,
        name: 'Lee Ji-eun',
        contactEmail: null,
      });
    });

    it('22. …and sets a code-proven contact email → 200, stored lowercase', async () => {
      proof = await emailProofFor(contactEmail);

      const res = await request(http)
        .put('/profiles/me/contact-email')
        .set(...auth(leeAccess))
        .send({
          email: ' Lee.Contact@Accounts.E2E.test ',
          emailVerificationToken: proof,
        })
        .expect(200);

      expect(res.body).toEqual({
        id: leeInCompanyOne,
        name: 'Lee Ji-eun',
        contactEmail: contactEmail,
      });
    });

    it('23. the same proof twice → 400, nothing changes', async () => {
      const res = await request(http)
        .put('/profiles/me/contact-email')
        .set(...auth(leeAccess))
        .send({ email: contactEmail, emailVerificationToken: proof });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid or expired email verification');
    });

    it('24. once approved, the "member approved" email arrives at that address', async () => {
      const ownerAccess = (
        await request(http)
          .post('/auth/switch')
          .set(...auth(owner.accessToken))
          .send({ refreshToken: owner.refreshToken, profileId: ownerProfileId })
          .expect(201)
      ).body.accessToken;
      const staff = await prisma.role.findUniqueOrThrow({
        where: { code: 'STAFF' },
      });

      await request(http)
        .patch(`/profiles/${leeInCompanyOne}/approve`)
        .set(...auth(ownerAccess))
        .send({ roleId: staff.id, cornerId: null })
        .expect(200);

      const expected = notificationTemplates.memberApproved('Accounts Co One');
      const messages = await waitFor(async () => {
        const found = await inbox(contactEmail);
        return found.some((message) => message.Subject === expected.subject)
          ? found
          : null;
      });
      expect(messages.map((message) => message.Subject)).toContain(
        expected.subject,
      );
    });

    it("25. the account's other profile keeps its own name and no contact email", async () => {
      const companies = await myCompanies(lee.accessToken);

      expect(
        companies.find((entry) => entry.profileId === leeInCompanyTwo),
      ).toMatchObject({ name: 'Lee' });
      await expect(
        prisma.profile.findUniqueOrThrow({
          where: { id: leeInCompanyTwo },
          select: { name: true, contactEmail: true },
        }),
      ).resolves.toEqual({ name: 'Lee', contactEmail: null });
    });
  });
  describe('the part-timer: one sign-in, two companies', () => {
    const parkEmail = 'park@part.accounts.e2e.test';
    const parkPhone = 'park-phone'; // one phone for both companies
    let ownerA: OwnerSetup;
    let ownerB: OwnerSetup;
    let park: Session; // straight from signup: no company
    let parkInA: string; // profile ids
    let parkInB: string;
    let parkA: Session; // company A open
    let parkB: Session; // company B open

    const approveAsStaff = async (ownerAccess: string, profileId: string) => {
      const staff = await prisma.role.findUniqueOrThrow({
        where: { code: 'STAFF' },
      });
      await request(http)
        .patch(`/profiles/${profileId}/approve`)
        .set(...auth(ownerAccess))
        .send({ roleId: staff.id, cornerId: null })
        .expect(200);
    };
    const memberIds = async (accessToken: string) =>
      (
        (
          await request(http)
            .get('/profiles')
            .set(...auth(accessToken))
            .expect(200)
        ).body as Array<{ id: string }>
      ).map((member) => member.id);

    beforeAll(async () => {
      const parts = suiteAccounts(app, {
        nextPhone: nextPhone,
        emailDomain: 'part.accounts.e2e.test',
        taxIdOf: taxIdOf, // 21, 22: unused above
        companyNameOf: (n) => `Part Co ${n}`,
      });
      ownerA = await parts.registerOwner(adminAccess, 21);
      ownerB = await parts.registerOwner(adminAccess, 22);
      park = await signUp(parkEmail);
      // the phone belongs to the sign-in: registered once, before any company
      await request(http)
        .post('/devices')
        .set(...auth(park.accessToken))
        .send({ token: parkPhone, platform: 'ANDROID' })
        .expect(204);
    });

    it("26. joins A and is approved, then asks to join B: A's routes still work with A's token", async () => {
      parkInA = (await joinCompany(app, park, ownerA.joinCode, 'Park'))
        .profileId;
      await approveAsStaff(ownerA.access, parkInA);
      parkA = await switchTo(app, park, parkInA);

      parkInB = (await joinCompany(app, parkA, ownerB.joinCode, 'Park'))
        .profileId;

      // waiting for B changes nothing in A
      expect(await memberIds(parkA.accessToken)).toContain(ownerA.profileId);
      const companies = await myCompanies(parkA.accessToken);
      expect(companies.map((entry) => [entry.profileId, entry.status])).toEqual(
        [
          [parkInA, 'ACTIVE'],
          [parkInB, 'PENDING_APPROVAL'],
        ],
      );
    });

    it('27. B approves; switching opens B, with no password', async () => {
      await approveAsStaff(ownerB.access, parkInB);

      parkB = await switchTo(app, parkA, parkInB);

      const me = await request(http)
        .get('/auth/me')
        .set(...auth(parkB.accessToken))
        .expect(200);
      expect(me.body.profile).toMatchObject({
        id: parkInB,
        companyId: ownerB.companyId,
        status: 'ACTIVE',
      });
    });

    it("28. each company's token sees only that company", async () => {
      // A's token on B's member, and B's token on A's: not found
      await request(http)
        .get(`/profiles/${ownerB.profileId}/history`)
        .set(...auth(parkA.accessToken))
        .expect(404);
      await request(http)
        .get(`/profiles/${ownerA.profileId}/history`)
        .set(...auth(parkB.accessToken))
        .expect(404);

      const inB = await memberIds(parkB.accessToken);
      expect(inB).toContain(ownerB.profileId);
      expect(inB).not.toContain(ownerA.profileId);
    });

    it("29. one phone gets both companies' approvals, each naming its own profile and company", async () => {
      const pushes = await waitFor(async () => {
        const rows = await prisma.notification.findMany({
          where: { eventType: 'member.approved', recipientAddress: parkPhone },
          orderBy: { createdAt: 'asc' },
        });
        return rows.length === 2 ? rows : null;
      });

      const expected = notificationTemplates.memberApproved;
      expect(
        pushes.map((push) => [
          push.recipientProfileId,
          push.subject,
          push.data,
        ]),
      ).toEqual([
        [
          parkInA,
          `Part Co 21 · ${expected('Part Co 21').subject}`,
          { companyId: ownerA.companyId, profileId: parkInA },
        ],
        [
          parkInB,
          `Part Co 22 · ${expected('Part Co 22').subject}`,
          { companyId: ownerB.companyId, profileId: parkInB },
        ],
      ]);
    });

    it('30. signing out ends the session for both companies', async () => {
      await request(http)
        .post('/auth/logout')
        .set(...auth(parkB.accessToken))
        .send({ refreshToken: parkB.refreshToken })
        .expect(201);

      // no refreshing into B, and no switching back to A
      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: parkB.refreshToken })
        .expect(401);
      await request(http)
        .post('/auth/switch')
        .set(...auth(parkB.accessToken))
        .send({ refreshToken: parkB.refreshToken, profileId: parkInA })
        .expect(401);
    });

    it('31. a company they left disappears from GET /me/companies', async () => {
      // leaving itself is piece 3: here the profile is ended directly
      await prisma.profile.update({
        where: { id: parkInA },
        data: { status: 'DEACTIVATED' },
      });

      const login = await request(http)
        .post('/auth/login')
        .send({ email: parkEmail, password: password })
        .expect(201);

      expect(login.body.profile).toMatchObject({ id: parkInB });
      await expect(myCompanies(login.body.accessToken)).resolves.toEqual([
        expect.objectContaining({ profileId: parkInB, status: 'ACTIVE' }),
      ]);
    });
  });
});
