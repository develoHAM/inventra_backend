import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakePhoneVerifier } from '../src/phone-verification/verifiers/fake.verifier';
import { testPhones, verifiedPhoneToken } from './helpers/phone';

/**
 * The OCTOMO reverse-SMS flow end to end: start → the user texts the code
 * (played by FakePhoneVerifier.receive) → confirm → the token is spent by
 * signup. PHONE_VERIFIER=fake in .env.test.
 */
describe('Phone verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;
  let fakeVerifier: FakePhoneVerifier;

  // users.phone is unique across the shared DB: suite 11's own block
  const nextPhone = testPhones(11);

  // dashed on purpose: the API must normalize it everywhere
  const ownerPhoneDashed = '010-1100-9001';
  const ownerPhoneDigits = '01011009001';
  let ownerToken: string;
  let joinCode: string;

  const start = (phone: string, purpose = 'SIGNUP') =>
    request(http)
      .post('/auth/phone/start')
      .send({ phone: phone, purpose: purpose });
  const confirm = (verificationId: string) =>
    request(http)
      .post('/auth/phone/confirm')
      .send({ verificationId: verificationId });
  const registerMember = (body: Record<string, unknown>) =>
    request(http)
      .post('/auth/register/member')
      .send({
        joinCode: joinCode,
        password: 'password123',
        name: 'PV Member',
        ...body,
      });

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
    fakeVerifier = app.get(FakePhoneVerifier);
  });

  afterAll(async () => {
    await app.close();
  });

  it('start returns a 6-digit code to text to OCTOMO, for a normalized phone', async () => {
    const response = await start(ownerPhoneDashed).expect(200);

    expect(response.body).toEqual({
      verificationId: expect.any(String),
      code: expect.stringMatching(/^\d{6}$/),
      receiverNumber: '1666-3538',
      expiresInSeconds: 300,
    });
    const row = await prisma.phoneVerification.findUnique({
      where: { id: response.body.verificationId },
    });
    expect(row!.phone).toBe(ownerPhoneDigits);
  });

  it('confirm says "not received yet" until the user has texted, then issues a token', async () => {
    const started = await start(ownerPhoneDashed).expect(200);

    const early = await confirm(started.body.verificationId).expect(400);
    expect(early.body.message).toBe('Message not received yet');

    fakeVerifier.receive(ownerPhoneDigits, started.body.code);
    const confirmed = await confirm(started.body.verificationId).expect(200);

    expect(confirmed.body.expiresInSeconds).toBe(600);
    expect(confirmed.body.verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    ownerToken = confirmed.body.verificationToken;
  });

  it('a verification cannot be confirmed twice', async () => {
    const started = await start(nextPhone()).expect(200);
    const phone = (await prisma.phoneVerification.findUnique({
      where: { id: started.body.verificationId },
    }))!.phone;
    fakeVerifier.receive(phone, started.body.code);
    await confirm(started.body.verificationId).expect(200);

    const again = await confirm(started.body.verificationId).expect(400);
    expect(again.body.message).toBe('Invalid or expired verification');
  });

  it('signup spends the token and stores the phone as digits only', async () => {
    await request(http)
      .post('/auth/register')
      .send({
        companyName: 'PV Co',
        taxId: '880-00-00001',
        ownerName: 'PV Owner',
        ownerEmail: 'owner@pv.test',
        ownerPassword: 'password123',
        ownerPhone: ownerPhoneDashed,
        ownerPhoneVerificationToken: ownerToken,
      })
      .expect(201);

    const owner = await prisma.user.findFirst({
      where: { loginMethods: { some: { email: 'owner@pv.test' } } },
    });
    expect(owner!.phone).toBe(ownerPhoneDigits);
    const spent = await prisma.phoneVerification.findFirst({
      where: { phone: ownerPhoneDigits, consumedAt: { not: null } },
    });
    expect(spent).not.toBeNull();

    joinCode = (await prisma.company.findUnique({
      where: { taxId: '880-00-00001' },
    }))!.joinCode;
  });

  it('a registered phone can neither start SIGNUP nor sign up again (409)', async () => {
    const restart = await start(ownerPhoneDigits).expect(409);
    expect(restart.body.message).toBe('Phone already registered');

    // reusing the spent token: the phone check comes first
    const reuse = await registerMember({
      email: 'reuse@pv.test',
      phone: ownerPhoneDigits,
      phoneVerificationToken: ownerToken,
    }).expect(409);
    expect(reuse.body.message).toBe('Phone already registered');
  });

  it('a token verified for one phone cannot register another phone', async () => {
    const tokenForA = await verifiedPhoneToken(app, nextPhone());

    const response = await registerMember({
      email: 'wrong-phone@pv.test',
      phone: nextPhone(), // B: never verified
      phoneVerificationToken: tokenForA,
    }).expect(400);
    expect(response.body.message).toBe('Invalid or expired verification token');
  });

  it('a FIND_ID token cannot be used to sign up', async () => {
    const phone = nextPhone();
    const started = await start(phone, 'FIND_ID').expect(200);
    fakeVerifier.receive(phone, started.body.code);
    const findIdToken = (await confirm(started.body.verificationId).expect(200))
      .body.verificationToken;

    await registerMember({
      email: 'find-id@pv.test',
      phone: phone,
      phoneVerificationToken: findIdToken,
    }).expect(400);
  });

  it('a member signs up with a fresh verified phone', async () => {
    const phone = nextPhone();
    const token = await verifiedPhoneToken(app, phone);

    const response = await registerMember({
      email: 'member@pv.test',
      phone: phone,
      phoneVerificationToken: token,
    }).expect(201);
    expect(response.body.user.status).toBe('PENDING_APPROVAL');
  });

  it('allows 10 checks per verification, then 429 (OCTOMO quota)', async () => {
    const started = await start(nextPhone()).expect(200);

    for (let check = 1; check <= 10; check += 1) {
      await confirm(started.body.verificationId).expect(400); // not texted
    }
    const eleventh = await confirm(started.body.verificationId).expect(429);
    expect(eleventh.body.message).toBe(
      'Too many checks; start a new verification',
    );
  });

  it('allows 10 starts per phone per day, then 429', async () => {
    const phone = nextPhone();
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await start(phone).expect(200);
    }
    await start(phone).expect(429);
  });

  it.each([
    ['a landline', { phone: '02-123-4567', purpose: 'SIGNUP' }],
    ['a legacy 011 number', { phone: '011-123-4567', purpose: 'SIGNUP' }],
    ['an unknown purpose', { phone: '01011009999', purpose: 'LOGIN' }],
  ])('start rejects %s with 400', async (_label, body) => {
    await request(http).post('/auth/phone/start').send(body).expect(400);
  });

  it('confirm rejects a non-UUID id with 400 (not a database error)', async () => {
    await confirm('not-a-uuid').expect(400);
  });

  it('confirm rejects an unknown id with 400', async () => {
    const response = await confirm(
      '00000000-0000-4000-8000-000000000000',
    ).expect(400);
    expect(response.body.message).toBe('Invalid or expired verification');
  });
});
