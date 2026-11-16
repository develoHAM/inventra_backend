import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { testPhones, verifiedPhone } from './helpers/phone';

/**
 * GET /me/companies, POST /me/companies/join and POST /me/companies: an
 * account made by POST /auth/signup (no company yet) joins or creates
 * companies, then opens one with POST /auth/switch.
 */
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
    ).body as Array<{ profileId: string; status: string }>;

  // no endpoint for a pending owner shows the code: read it from the DB
  const joinCodeOf = async (companyId: string) =>
    (await prisma.company.findUniqueOrThrow({ where: { id: companyId } }))
      .joinCode;

  let companyOneId: string;
  let companyTwoId: string;

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
    let owner: { accessToken: string; refreshToken: string };

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
});
