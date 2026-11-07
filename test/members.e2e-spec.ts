import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { testPhones, verifiedPhone } from './helpers/phone';

/**
 * Members: who is in which branch, in which role. One story, shared state,
 * run in order: each block builds on what the previous one left behind.
 */
describe('Members (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let owner2Access: string;
  let managerAccess: string;
  let staffAccess: string;

  let ownerUserId: string;
  let managerUserId: string;
  let staffUserId: string;
  let staff2UserId: string;

  let branchAId: string;
  let branchBId: string;
  let company2BranchId: string;

  // users.phone is unique across the shared DB: suite 16's own block
  const nextPhone = testPhones(16);

  // register a company → ADMIN approves it → owner logs in
  const registerCompany = async (n: number) => {
    const taxId = `7${n}6-00-0000${n}`;
    const email = `owner${n}@mbr.test`;
    const password = 'password123';
    const { phone, token } = await verifiedPhone(app, nextPhone);
    await request(http)
      .post('/auth/register')
      .send({
        companyName: `Members Co ${n}`,
        taxId: taxId,
        ownerName: `Owner ${n}`,
        credentials: { type: 'password', email: email, password: password },
        ownerPhone: phone,
        ownerPhoneVerificationToken: token,
      })
      .expect(201);
    const company = await prisma.company.findUnique({
      where: { taxId: taxId },
    });
    await request(http)
      .patch(`/companies/${company!.id}/approve`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const login = await request(http)
      .post('/auth/login')
      .send({ email: email, password: password })
      .expect(201);
    const owner = await prisma.user.findFirst({
      where: { loginMethods: { some: { email: email } } },
    });
    return {
      access: login.body.accessToken as string,
      userId: owner!.id,
      companyId: company!.id,
      joinCode: company!.joinCode,
    };
  };

  // member self-registers via join code → owner approves with a role → member logs in
  const registerMember = async (
    joinCode: string,
    roleCode: string,
    tag: string,
  ) => {
    const email = `${tag}@mbr.test`;
    const password = 'password123';
    const { phone, token } = await verifiedPhone(app, nextPhone);
    await request(http)
      .post('/auth/register/member')
      .send({
        joinCode: joinCode,
        credentials: { type: 'password', email: email, password: password },
        name: tag,
        phone: phone,
        phoneVerificationToken: token,
      })
      .expect(201);
    const user = await prisma.user.findFirst({
      where: { loginMethods: { some: { email: email } } },
    });
    const role = await prisma.role.findUnique({ where: { code: roleCode } });
    await request(http)
      .patch(`/users/${user!.id}/approve`)
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ roleId: role!.id })
      .expect(200);
    const login = await request(http)
      .post('/auth/login')
      .send({ email: email, password: password })
      .expect(201);
    return { access: login.body.accessToken as string, userId: user!.id };
  };

  const openBranch = async (access: string, storeId: string, name: string) => {
    const response = await request(http)
      .post('/corners')
      .set('Authorization', `Bearer ${access}`)
      .send({ storeId: storeId, name: name })
      .expect(201);
    return response.body.id as string;
  };

  const moveTo = (access: string, userId: string, cornerId: string | null) =>
    request(http)
      .put(`/users/${userId}/branch`)
      .set('Authorization', `Bearer ${access}`)
      .send({ cornerId: cornerId });

  const historyOf = (userId: string) =>
    prisma.membershipChange.findMany({
      where: { userId: userId },
      orderBy: { createdAt: 'asc' },
    });

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

    const adminLogin = await request(http)
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);
    adminAccess = adminLogin.body.accessToken;

    const company1 = await registerCompany(1);
    ownerAccess = company1.access;
    ownerUserId = company1.userId;
    const company2 = await registerCompany(2);
    owner2Access = company2.access;

    const store = await request(http)
      .post('/stores')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Members Mall' })
      .expect(201);
    branchAId = await openBranch(ownerAccess, store.body.id, 'Branch A');
    branchBId = await openBranch(ownerAccess, store.body.id, 'Branch B');
    company2BranchId = await openBranch(owner2Access, store.body.id, 'Other');

    const manager = await registerMember(
      company1.joinCode,
      'MANAGER',
      'manager',
    );
    managerAccess = manager.access;
    managerUserId = manager.userId;
    const staff = await registerMember(company1.joinCode, 'STAFF', 'staff');
    staffAccess = staff.access;
    staffUserId = staff.userId;
    const staff2 = await registerMember(company1.joinCode, 'STAFF', 'staff2');
    staff2UserId = staff2.userId;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('moving members between branches', () => {
    it('the owner puts the manager and the staff into Branch A', async () => {
      const managerMoved = await moveTo(
        ownerAccess,
        managerUserId,
        branchAId,
      ).expect(200);
      expect(managerMoved.body).toMatchObject({
        id: managerUserId,
        role: { code: 'MANAGER' },
        branch: { id: branchAId, name: 'Branch A' },
      });

      for (const userId of [staffUserId, staff2UserId]) {
        await moveTo(ownerAccess, userId, branchAId).expect(200);
      }
    });

    // Reads are company-wide; only writes check the branch (assertWorksCorner).
    // A made-up product gets past the branch check (→ 400 Invalid product)
    // only for someone who works in that branch; anyone else gets 403 first.
    const placeMissingProductIn = (cornerId: string) =>
      request(http)
        .post(`/corners/${cornerId}/products`)
        .set('Authorization', `Bearer ${staffAccess}`)
        .send({ productId: '11111111-1111-4111-8111-111111111111' });

    it('staff in Branch A pass its branch check with the token they already had', async () => {
      await placeMissingProductIn(branchAId).expect(400);
    });

    it('the owner moves staff A → B → no branch; each move is one history row', async () => {
      await moveTo(ownerAccess, staffUserId, branchBId).expect(200);
      const offBranch = await moveTo(ownerAccess, staffUserId, null).expect(
        200,
      );
      expect(offBranch.body.branch).toBeNull();

      const moves = (await historyOf(staffUserId)).filter(
        (row) => row.reason === 'MOVED',
      );
      expect(
        moves.map((row) => [row.fromCompanyStoreId, row.toCompanyStoreId]),
      ).toEqual([
        [null, branchAId],
        [branchAId, branchBId],
        [branchBId, null],
      ]);
      for (const row of moves) {
        expect(row.fromRoleId).toBe(row.toRoleId); // a snapshot: role unchanged
        expect(row.changedByUserId).toBe(ownerUserId);
      }
    });

    it('the same token now gets 403 on Branch A: access follows the database, not the token', async () => {
      await placeMissingProductIn(branchAId).expect(403);
    });

    it('the moved member is notified', async () => {
      const notification = await waitFor(() =>
        prisma.notification.findFirst({
          where: { recipientUserId: staffUserId, eventType: 'member.moved' },
        }),
      );
      expect(notification.channel).toBe('EMAIL');
    });

    it('moving someone to the branch they are already in changes nothing', async () => {
      const before = (await historyOf(staff2UserId)).length;

      await moveTo(ownerAccess, staff2UserId, branchAId).expect(200);

      expect(await historyOf(staff2UserId)).toHaveLength(before);
    });

    it('managers and staff cannot move anyone (403)', async () => {
      await moveTo(managerAccess, staff2UserId, branchBId).expect(403);
      await moveTo(staffAccess, staff2UserId, branchBId).expect(403);
    });

    it("another company's owner cannot see the member (404)", async () => {
      await moveTo(owner2Access, staff2UserId, company2BranchId).expect(404);
    });

    it('a branch of another company is not found (404) and nothing changes', async () => {
      await moveTo(ownerAccess, staff2UserId, company2BranchId).expect(404);

      const staff2 = await prisma.user.findUnique({
        where: { id: staff2UserId },
      });
      expect(staff2!.companyStoreId).toBe(branchAId);
    });

    it('owners have no branch (400); cornerId is required (400)', async () => {
      await moveTo(ownerAccess, ownerUserId, branchAId).expect(400);
      await request(http)
        .put(`/users/${staff2UserId}/branch`)
        .set('Authorization', `Bearer ${ownerAccess}`)
        .send({})
        .expect(400);
    });

    it('the admin can move a member of any company', async () => {
      await moveTo(adminAccess, staff2UserId, branchBId).expect(200);
      await moveTo(adminAccess, staff2UserId, branchAId).expect(200);

      // staff2 was moved 3 times (owner → A, admin → B, admin → A). Wait for
      // all 3 emails to be sent, so the app isn't closed while the
      // notification pipeline is still queueing them.
      await waitFor(async () => {
        const sent = await prisma.notification.count({
          where: {
            recipientUserId: staff2UserId,
            eventType: 'member.moved',
            status: 'SENT',
          },
        });
        return sent === 3 ? sent : null;
      });
    });
  });
});
