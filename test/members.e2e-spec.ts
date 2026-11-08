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
  let joinCode1: string;
  let joinCode2: string;
  let company2Id: string;
  let owner2UserId: string;

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
      .send({ roleId: role!.id, cornerId: null })
      .expect(200);
    const login = await request(http)
      .post('/auth/login')
      .send({ email: email, password: password })
      .expect(201);
    return { access: login.body.accessToken as string, userId: user!.id };
  };

  // member self-registers via join code and waits for approval (not approved here)
  const registerPending = async (tag: string, joinCode: string = joinCode1) => {
    const { phone, token } = await verifiedPhone(app, nextPhone);
    await request(http)
      .post('/auth/register/member')
      .send({
        joinCode: joinCode,
        credentials: {
          type: 'password',
          email: `${tag}@mbr.test`,
          password: 'password123',
        },
        name: tag,
        phone: phone,
        phoneVerificationToken: token,
      })
      .expect(201);
    const user = await prisma.user.findFirst({
      where: { loginMethods: { some: { email: `${tag}@mbr.test` } } },
    });
    return user!.id;
  };

  const approve = (
    access: string,
    userId: string,
    roleId: number,
    cornerId: string | null,
  ) =>
    request(http)
      .patch(`/users/${userId}/approve`)
      .set('Authorization', `Bearer ${access}`)
      .send({ roleId: roleId, cornerId: cornerId });

  const roleIdOf = async (code: string) =>
    (await prisma.role.findUniqueOrThrow({ where: { code: code } })).id;

  const setRole = (
    access: string,
    userId: string,
    role: string,
    cornerId?: string | null,
  ) =>
    request(http)
      .put(`/users/${userId}/role`)
      .set('Authorization', `Bearer ${access}`)
      // cornerId left undefined is dropped from the JSON: "not sent"
      .send({ role: role, cornerId: cornerId });

  const userIdByEmail = async (email: string) =>
    (
      await prisma.user.findFirstOrThrow({
        where: { loginMethods: { some: { email: email } } },
      })
    ).id;

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
    joinCode1 = company1.joinCode;
    ownerAccess = company1.access;
    ownerUserId = company1.userId;
    const company2 = await registerCompany(2);
    owner2Access = company2.access;
    owner2UserId = company2.userId;
    company2Id = company2.companyId;
    joinCode2 = company2.joinCode;

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
    // Let this suite's emails finish sending before closing the app, so the
    // queue isn't shut down mid-job ("Connection is closed").
    await waitFor(async () => {
      const pending = await prisma.notification.count({
        where: {
          status: 'PENDING',
          recipientAddress: { endsWith: '@mbr.test' },
        },
      });
      return pending === 0 ? true : null;
    });
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

  describe('approval picks the role and the branch', () => {
    it('a manager approves a newcomer into their own branch, as staff', async () => {
      const newcomerId = await registerPending('newcomer1');

      const approved = await approve(
        managerAccess,
        newcomerId,
        await roleIdOf('STAFF'),
        branchAId,
      ).expect(200);

      expect(approved.body).toMatchObject({
        id: newcomerId,
        status: 'ACTIVE',
        role: { code: 'STAFF' },
        branch: { id: branchAId, name: 'Branch A' },
      });
      const [firstRow] = await historyOf(newcomerId);
      expect(firstRow).toMatchObject({
        reason: 'APPROVED',
        fromRoleId: null,
        toRoleId: await roleIdOf('STAFF'),
        fromCompanyStoreId: null,
        toCompanyStoreId: branchAId,
        changedByUserId: managerUserId,
      });
    });

    it('a manager cannot approve as a manager, into another branch, or into no branch (403)', async () => {
      const newcomerId = await registerPending('newcomer2');

      await approve(
        managerAccess,
        newcomerId,
        await roleIdOf('MANAGER'),
        branchAId,
      ).expect(403);
      await approve(
        managerAccess,
        newcomerId,
        await roleIdOf('STAFF'),
        branchBId,
      ).expect(403);
      await approve(
        managerAccess,
        newcomerId,
        await roleIdOf('STAFF'),
        null,
      ).expect(403);

      const stillPending = await prisma.user.findUniqueOrThrow({
        where: { id: newcomerId },
      });
      expect(stillPending.status).toBe('PENDING_APPROVAL');
    });

    it('the owner approves a manager with "no branch yet"', async () => {
      const newcomerId = await registerPending('newcomer3');

      const approved = await approve(
        ownerAccess,
        newcomerId,
        await roleIdOf('MANAGER'),
        null,
      ).expect(200);

      expect(approved.body).toMatchObject({
        role: { code: 'MANAGER' },
        branch: null,
      });
    });

    it('a branch of another company is not found (404) and the member stays pending', async () => {
      const newcomerId = await registerPending('newcomer4');

      await approve(
        ownerAccess,
        newcomerId,
        await roleIdOf('STAFF'),
        company2BranchId,
      ).expect(404);

      const stillPending = await prisma.user.findUniqueOrThrow({
        where: { id: newcomerId },
      });
      expect(stillPending.status).toBe('PENDING_APPROVAL');
      expect(await historyOf(newcomerId)).toHaveLength(0);
    });

    it('two approvals of the same person at once: exactly one wins', async () => {
      const newcomerId = await registerPending('newcomer5');
      const staffRoleId = await roleIdOf('STAFF');

      const results = await Promise.all([
        approve(ownerAccess, newcomerId, staffRoleId, branchBId),
        approve(managerAccess, newcomerId, staffRoleId, branchAId),
      ]);

      const statuses = results.map((result) => result.status);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      // the loser either read "pending" and lost the write (409), or read
      // the already-approved member (400 not pending)
      expect([400, 409]).toContain(statuses.find((status) => status !== 200));
      const approvals = (await historyOf(newcomerId)).filter(
        (row) => row.reason === 'APPROVED',
      );
      expect(approvals).toHaveLength(1);
    });

    it('cornerId is required: leaving it out is 400', async () => {
      const newcomerId = await registerPending('newcomer6');

      await request(http)
        .patch(`/users/${newcomerId}/approve`)
        .set('Authorization', `Bearer ${ownerAccess}`)
        .send({ roleId: await roleIdOf('STAFF') })
        .expect(400);
    });
  });

  describe('changing roles', () => {
    let promotedId: string; // newcomer1: STAFF in Branch A, approved by the manager

    beforeAll(async () => {
      promotedId = await userIdByEmail('newcomer1@mbr.test');
    });

    it('a manager promotes staff of their own branch to manager; they stay there', async () => {
      const changed = await setRole(
        managerAccess,
        promotedId,
        'MANAGER',
      ).expect(200);

      expect(changed.body).toMatchObject({
        role: { code: 'MANAGER' },
        branch: { id: branchAId },
      });
      const rows = await historyOf(promotedId);
      expect(rows[rows.length - 1]).toMatchObject({
        reason: 'ROLE_CHANGED',
        fromRoleId: await roleIdOf('STAFF'),
        toRoleId: await roleIdOf('MANAGER'),
        fromCompanyStoreId: branchAId,
        toCompanyStoreId: branchAId, // a snapshot: the branch didn't change
        changedByUserId: managerUserId,
      });
    });

    it('the promoted member is notified', async () => {
      await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            recipientUserId: promotedId,
            eventType: 'member.roleChanged',
          },
        }),
      );
    });

    it('a manager cannot promote outside their branch, demote a manager, or touch an owner (403)', async () => {
      await setRole(managerAccess, staffUserId, 'MANAGER').expect(403); // staff has no branch
      await setRole(managerAccess, promotedId, 'STAFF').expect(403);
      await setRole(managerAccess, ownerUserId, 'STAFF').expect(403);
    });

    it('staff cannot change roles at all (403)', async () => {
      await setRole(staffAccess, promotedId, 'STAFF').expect(403);
    });

    it('the owner demotes a manager to staff; they stay in their branch', async () => {
      const changed = await setRole(ownerAccess, promotedId, 'STAFF').expect(
        200,
      );

      expect(changed.body).toMatchObject({
        role: { code: 'STAFF' },
        branch: { id: branchAId },
      });
    });

    it('cornerId is refused unless the admin is demoting an owner (400)', async () => {
      await setRole(ownerAccess, promotedId, 'MANAGER', branchBId).expect(400);
      await setRole(ownerAccess, promotedId, 'MANAGER', null).expect(400);
    });

    it('the owner promotes staff to owner; they leave their branch', async () => {
      const changed = await setRole(ownerAccess, staff2UserId, 'OWNER').expect(
        200,
      );

      expect(changed.body).toMatchObject({
        role: { code: 'OWNER' },
        branch: null,
      });
    });

    it('owners cannot demote another owner, or themselves (403)', async () => {
      await setRole(ownerAccess, staff2UserId, 'MANAGER').expect(403);
      await setRole(ownerAccess, ownerUserId, 'MANAGER').expect(403);
    });

    it('the admin demotes one of two owners into Branch B; the last owner stays (409)', async () => {
      await setRole(adminAccess, staff2UserId, 'STAFF').expect(400); // must say where they go

      const demoted = await setRole(
        adminAccess,
        staff2UserId,
        'STAFF',
        branchBId,
      ).expect(200);
      expect(demoted.body).toMatchObject({
        role: { code: 'STAFF' },
        branch: { id: branchBId },
      });

      await setRole(adminAccess, ownerUserId, 'STAFF', null).expect(409);
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: ownerUserId },
        include: { role: true },
      });
      expect(owner.role!.code).toBe('OWNER');
    });

    it('two admin demotions of the last two owners at once leave exactly one owner', async () => {
      // company 2: its owner + one promoted member = two owners
      const secondOwnerId = await registerPending('c2owner', joinCode2);
      await approve(
        owner2Access,
        secondOwnerId,
        await roleIdOf('MANAGER'),
        company2BranchId,
      ).expect(200);
      await setRole(owner2Access, secondOwnerId, 'OWNER').expect(200);

      const results = await Promise.all([
        setRole(adminAccess, owner2UserId, 'STAFF', null),
        setRole(adminAccess, secondOwnerId, 'STAFF', null),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const owners = await prisma.user.findMany({
        where: {
          companyId: company2Id,
          role: { code: 'OWNER' },
          status: 'ACTIVE',
          deletedAt: null,
        },
      });
      expect(owners).toHaveLength(1);

      // keep company 2's original owner an owner for the rest of the suite
      if (owners[0].id !== owner2UserId) {
        await setRole(adminAccess, owner2UserId, 'OWNER').expect(200);
      }
    });
  });
});
