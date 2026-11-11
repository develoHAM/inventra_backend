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
  let staff2Access: string; // signed in as staff; kept through promotion and demotion

  let branchAId: string;
  let branchBId: string;
  let storeId: string;
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
    storeId = store.body.id;
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
    staff2Access = staff2.access;
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

    it("the admin cannot approve a company's pending owner as a member (400); they stay its owner", async () => {
      // Company 3 registers; the admin has not approved the company yet.
      const { phone, token } = await verifiedPhone(app, nextPhone);
      await request(http)
        .post('/auth/register')
        .send({
          companyName: 'Members Co 3',
          taxId: '736-00-00003',
          ownerName: 'Owner 3',
          credentials: {
            type: 'password',
            email: 'owner3@mbr.test',
            password: 'password123',
          },
          ownerPhone: phone,
          ownerPhoneVerificationToken: token,
        })
        .expect(201);
      const pendingOwnerId = await userIdByEmail('owner3@mbr.test');

      await approve(
        adminAccess,
        pendingOwnerId,
        await roleIdOf('STAFF'),
        null,
      ).expect(400);

      const pendingOwner = await prisma.user.findUniqueOrThrow({
        where: { id: pendingOwnerId },
        include: { role: true },
      });
      expect(pendingOwner.status).toBe('PENDING_APPROVAL');
      expect(pendingOwner.role?.code).toBe('OWNER');
      expect(await historyOf(pendingOwnerId)).toEqual([]);
    });

    it('staff given a personal users.approve grant still cannot approve (403), nor see who is waiting: the role decides', async () => {
      const newcomerId = await registerPending('newcomer7');
      const approvePermission = await prisma.permission.findUniqueOrThrow({
        where: { code: 'users.approve' },
      });
      // The grant lets staff past the permission guard; the service's rule
      // for their role must still refuse.
      await prisma.userPermission.create({
        data: {
          userId: staffUserId,
          permissionId: approvePermission.id,
          effect: 'GRANT',
        },
      });
      try {
        await approve(
          staffAccess,
          newcomerId,
          await roleIdOf('MANAGER'),
          branchAId,
        ).expect(403);

        // Pending people are listed only for those who can really approve.
        const list = await request(http)
          .get('/users')
          .set('Authorization', `Bearer ${staffAccess}`)
          .expect(200);
        const listedIds = (list.body as Array<{ id: string }>).map(
          (member) => member.id,
        );
        expect(listedIds).not.toContain(newcomerId);
      } finally {
        await prisma.userPermission.delete({
          where: {
            userId_permissionId: {
              userId: staffUserId,
              permissionId: approvePermission.id,
            },
          },
        });
      }

      const newcomer = await prisma.user.findUniqueOrThrow({
        where: { id: newcomerId },
      });
      expect(newcomer.status).toBe('PENDING_APPROVAL');
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
      // The token staff2 signed in with as staff now opens owner-only routes:
      // a move (owners only) of the manager into the branch they're already in.
      await moveTo(staff2Access, managerUserId, branchAId).expect(200);
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

    it("the demoted owner's existing token loses owner-only routes (403)", async () => {
      // Same token as before the demotion: the guard reads the role from the
      // database on every request.
      await moveTo(staff2Access, managerUserId, branchAId).expect(403);
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

      // A smoke test only: if the two requests happen not to overlap,
      // [200, 409] comes out with or without the lock. The next test proves
      // the lock itself.
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

    it('an owner demotion waits for the company row lock before counting owners', async () => {
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: ownerUserId },
      });
      const company1Id = owner.companyId!;

      // The test takes company 1's row lock itself, as a concurrent demotion
      // would, and keeps its transaction open until told to finish.
      let signalLockTaken!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        signalLockTaken = resolve;
      });
      let releaseLock!: () => void;
      const lockReleased = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const lockHolder = prisma.$transaction(async (transaction) => {
        await transaction.company.updateMany({
          where: { id: company1Id },
          data: { updatedAt: new Date() },
        });
        signalLockTaken();
        await lockReleased;
      });
      await lockTaken;

      // Company 1's only owner: once it gets in, the count says 1 → 409.
      let answered = false;
      const demotion = setRole(adminAccess, ownerUserId, 'STAFF', null).then(
        (response) => {
          answered = true;
          return response;
        },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(answered).toBe(false); // still waiting at the locked door
      } finally {
        releaseLock();
        await lockHolder;
      }

      expect((await demotion).status).toBe(409);
    });
  });

  describe('deleting a branch releases its people', () => {
    let branchCId: string;
    let releasedManagerId: string; // newcomer3: MANAGER, no branch until now

    beforeAll(async () => {
      branchCId = await openBranch(ownerAccess, storeId, 'Branch C');
      releasedManagerId = await userIdByEmail('newcomer3@mbr.test');
      await moveTo(ownerAccess, releasedManagerId, branchCId).expect(200);
      await moveTo(ownerAccess, staffUserId, branchCId).expect(200);
    });

    it('the owner deletes Branch C: its manager and staff now have no branch', async () => {
      await request(http)
        .delete(`/corners/${branchCId}`)
        .set('Authorization', `Bearer ${ownerAccess}`)
        .expect(200);

      for (const userId of [releasedManagerId, staffUserId]) {
        const member = await prisma.user.findUniqueOrThrow({
          where: { id: userId },
        });
        expect(member.companyStoreId).toBeNull();
      }
    });

    it('each released person gets one BRANCH_DELETED history row', async () => {
      const rows = await prisma.membershipChange.findMany({
        where: { reason: 'BRANCH_DELETED', fromCompanyStoreId: branchCId },
      });

      expect(rows.map((row) => row.userId).sort()).toEqual(
        [releasedManagerId, staffUserId].sort(),
      );
      for (const row of rows) {
        expect(row.toCompanyStoreId).toBeNull();
        expect(row.fromRoleId).toBe(row.toRoleId); // a snapshot: role unchanged
        expect(row.changedByUserId).toBe(ownerUserId);
      }
    });

    it('each released person is told their branch was closed', async () => {
      for (const userId of [releasedManagerId, staffUserId]) {
        await waitFor(() =>
          prisma.notification.findFirst({
            where: {
              recipientUserId: userId,
              eventType: 'member.moved',
              AND: [
                { body: { contains: 'Branch C' } },
                { body: { contains: '삭제' } },
              ],
            },
          }),
        );
      }
    });

    it('nobody can be moved into the deleted branch (404)', async () => {
      await moveTo(ownerAccess, staff2UserId, branchCId).expect(404);
    });

    it('deleting it again is 404, and writes no more history', async () => {
      await request(http)
        .delete(`/corners/${branchCId}`)
        .set('Authorization', `Bearer ${ownerAccess}`)
        .expect(404);

      expect(
        await prisma.membershipChange.count({
          where: { reason: 'BRANCH_DELETED', fromCompanyStoreId: branchCId },
        }),
      ).toBe(2);
    });
  });

  describe('the member list', () => {
    const listAs = (access: string, query: Record<string, string> = {}) =>
      request(http)
        .get('/users')
        .query(query)
        .set('Authorization', `Bearer ${access}`);

    it('staff list their company, with phone and contact email', async () => {
      const list = await listAs(staffAccess).expect(200);

      const manager = list.body.find(
        (member: { id: string }) => member.id === managerUserId,
      );
      expect(manager).toMatchObject({
        name: 'manager',
        contactEmail: 'manager@mbr.test',
        status: 'ACTIVE',
        role: { code: 'MANAGER' },
        branch: { id: branchAId, name: 'Branch A' },
      });
      expect(manager.phone).toEqual(expect.any(String));
    });

    it('the other company never appears, even when it is named', async () => {
      const list = await listAs(ownerAccess, {
        companyId: company2Id,
      }).expect(200);

      const ids = list.body.map((member: { id: string }) => member.id);
      expect(ids).toContain(ownerUserId);
      expect(ids).not.toContain(owner2UserId);
    });

    it('pending members are listed, with no role and no branch', async () => {
      const pendingId = await userIdByEmail('newcomer2@mbr.test');

      const pending = await listAs(ownerAccess, {
        status: 'PENDING_APPROVAL',
      }).expect(200);

      expect(pending.body.map((member: { id: string }) => member.id)).toContain(
        pendingId,
      );
      for (const member of pending.body) {
        expect(member).toMatchObject({
          status: 'PENDING_APPROVAL',
          role: null,
          branch: null,
        });
      }
    });

    it('managers, who can approve, see people waiting for approval', async () => {
      const pendingId = await userIdByEmail('newcomer2@mbr.test');

      const list = await listAs(managerAccess).expect(200);

      expect(list.body.map((member: { id: string }) => member.id)).toContain(
        pendingId,
      );
    });

    it('staff, who cannot approve, never see people waiting for approval', async () => {
      const pendingId = await userIdByEmail('newcomer2@mbr.test');

      const list = await listAs(staffAccess).expect(200);
      expect(
        list.body.map((member: { id: string }) => member.id),
      ).not.toContain(pendingId);

      const askedDirectly = await listAs(staffAccess, {
        status: 'PENDING_APPROVAL',
      }).expect(200);
      expect(askedDirectly.body).toEqual([]);
    });

    it('filters by branch', async () => {
      const inBranchA = await listAs(ownerAccess, {
        cornerId: branchAId,
      }).expect(200);

      expect(
        inBranchA.body.map((member: { id: string }) => member.id),
      ).toContain(managerUserId);
      for (const member of inBranchA.body) {
        expect(member.branch.id).toBe(branchAId);
      }
    });

    it('cornerId=none lists the people with no branch', async () => {
      const noBranch = await listAs(ownerAccess, { cornerId: 'none' }).expect(
        200,
      );

      const ids = noBranch.body.map((member: { id: string }) => member.id);
      expect(ids).toContain(staffUserId); // released with Branch C
      expect(ids).not.toContain(managerUserId); // in Branch A
      for (const member of noBranch.body) {
        expect(member.branch).toBeNull();
      }
    });

    it('filters by role', async () => {
      const managers = await listAs(ownerAccess, { role: 'MANAGER' }).expect(
        200,
      );

      expect(
        managers.body.map((member: { id: string }) => member.id),
      ).toContain(managerUserId);
      for (const member of managers.body) {
        expect(member.role.code).toBe('MANAGER');
      }
    });

    it('the admin must say which company (400), then sees that one', async () => {
      await listAs(adminAccess).expect(400);

      const list = await listAs(adminAccess, {
        companyId: company2Id,
      }).expect(200);

      const ids = list.body.map((member: { id: string }) => member.id);
      expect(ids).toContain(owner2UserId);
      expect(ids).not.toContain(ownerUserId);
    });

    it('bad filters are 400', async () => {
      await listAs(ownerAccess, { role: 'BOSS' }).expect(400);
      await listAs(ownerAccess, { cornerId: 'branch-a' }).expect(400);
      await listAs(ownerAccess, { foo: '1' }).expect(400);
    });
  });

  describe('reading the history', () => {
    let company1Id: string;
    let promotedId: string; // newcomer1: STAFF in Branch A until this block promotes them
    let pendingId: string; // newcomer2: still waiting for approval

    const readAs = (
      access: string,
      path: string,
      query: Record<string, string> = {},
    ) =>
      request(http)
        .get(path)
        .query(query)
        .set('Authorization', `Bearer ${access}`);

    /** One history entry as the API sends it: dates arrive as text. */
    type HistoryEntryBody = {
      id: string;
      reason: string;
      createdAt: string;
      member: { id: string; name: string };
      changedBy: { id: string; name: string } | null;
      fromRole: { code: string; name: string } | null;
      toRole: { code: string; name: string } | null;
      fromBranch: { id: string; name: string } | null;
      toBranch: { id: string; name: string } | null;
    };
    type HistoryPageBody = {
      items: HistoryEntryBody[];
      nextCursor: string | null;
    };

    /** A page the caller may read (200). */
    const pageAs = async (
      access: string,
      path: string,
      query: Record<string, string> = {},
    ) =>
      (await readAs(access, path, query).expect(200)).body as HistoryPageBody;

    beforeAll(async () => {
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: ownerUserId },
      });
      company1Id = owner.companyId!;
      promotedId = await userIdByEmail('newcomer1@mbr.test');
      pendingId = await userIdByEmail('newcomer2@mbr.test');
    });

    it("a manager's promotion in Branch A shows in Branch A's history, from A to A", async () => {
      await setRole(managerAccess, promotedId, 'MANAGER').expect(200);

      const branchHistory = await pageAs(
        managerAccess,
        `/corners/${branchAId}/history`,
      );

      const [promotion] = branchHistory.items;
      expect(promotion).toMatchObject({
        reason: 'ROLE_CHANGED',
        fromRole: { code: 'STAFF' },
        toRole: { code: 'MANAGER' },
        fromBranch: { id: branchAId, name: 'Branch A' },
        toBranch: { id: branchAId, name: 'Branch A' }, // a snapshot: same branch
      });
      // Exactly an id and a name: no phone or email travels with history.
      expect(promotion.member).toEqual({ id: promotedId, name: 'newcomer1' });
      expect(promotion.changedBy).toEqual({
        id: managerUserId,
        name: 'manager',
      });
    });

    it('the owner reads the whole company feed, newest first; the manager cannot (403)', async () => {
      const feed = await pageAs(
        ownerAccess,
        `/companies/${company1Id}/history`,
      );

      expect(feed.items[0]).toMatchObject({
        reason: 'ROLE_CHANGED',
        member: { id: promotedId },
      });
      const times = feed.items.map((item) => Date.parse(item.createdAt));
      expect(times).toEqual(
        [...times].sort((later, earlier) => earlier - later),
      );

      await readAs(managerAccess, `/companies/${company1Id}/history`).expect(
        403,
      );
    });

    it('the admin reads any company feed', async () => {
      const feed = await pageAs(
        adminAccess,
        `/companies/${company1Id}/history`,
      );

      expect(feed.items[0]).toMatchObject({ member: { id: promotedId } });
    });

    it("another company's owner gets 404 for this company's feed, branch and people", async () => {
      await readAs(owner2Access, `/companies/${company1Id}/history`).expect(
        404,
      );
      await readAs(owner2Access, `/corners/${branchAId}/history`).expect(404);
      await readAs(owner2Access, `/users/${staffUserId}/history`).expect(404);
    });

    it('branch history: staff get 403, and so does a manager asking about another branch', async () => {
      await readAs(staffAccess, `/corners/${branchAId}/history`).expect(403);
      await readAs(managerAccess, `/corners/${branchBId}/history`).expect(403);
    });

    it('a closed branch keeps its name in the feed, though its own history is gone (404)', async () => {
      const branchC = await prisma.companyStore.findFirstOrThrow({
        where: { companyId: company1Id, name: 'Branch C' },
      });

      await readAs(ownerAccess, `/corners/${branchC.id}/history`).expect(404);

      const feed = await pageAs(
        ownerAccess,
        `/companies/${company1Id}/history`,
        { limit: '100' },
      );
      expect(feed.items).toContainEqual(
        expect.objectContaining({
          reason: 'BRANCH_DELETED',
          member: { id: staffUserId, name: 'staff' },
          fromBranch: { id: branchC.id, name: 'Branch C' },
          toBranch: null,
        }),
      );
    });

    it("staff read their own history, newest first, but not a colleague's (403)", async () => {
      const own = await pageAs(staffAccess, `/users/${staffUserId}/history`);

      expect(own.items.length).toBeGreaterThan(0);
      for (const item of own.items) {
        expect(item.member.id).toBe(staffUserId);
      }
      expect(own.items[0].reason).toBe('BRANCH_DELETED'); // their latest change

      await readAs(staffAccess, `/users/${managerUserId}/history`).expect(403);
    });

    it('a manager reads the people in their branch, but not someone outside it (403)', async () => {
      await readAs(managerAccess, `/users/${promotedId}/history`).expect(200); // in Branch A
      await readAs(managerAccess, `/users/${staffUserId}/history`).expect(403); // no branch
    });

    it('someone waiting for approval has a history too: empty so far', async () => {
      const pending = await pageAs(ownerAccess, `/users/${pendingId}/history`);

      expect(pending).toEqual({ items: [], nextCursor: null });
    });

    it('limit=1: the bookmark is the one entry shown, and the next page starts after it', async () => {
      const path = `/companies/${company1Id}/history`;

      const firstPage = await pageAs(ownerAccess, path, { limit: '1' });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toBe(firstPage.items[0].id);

      const secondPage = await pageAs(ownerAccess, path, {
        limit: '1',
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id);
    });

    it('paging through the whole feed one entry at a time repeats nothing and loses nothing, ties included', async () => {
      const everyId = (
        await prisma.membershipChange.findMany({
          where: { companyId: company1Id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        })
      ).map((row) => row.id);

      const seenIds: string[] = [];
      let cursor: string | null = null;
      do {
        const query: Record<string, string> = cursor
          ? { limit: '1', cursor: cursor }
          : { limit: '1' };
        const page = await pageAs(
          ownerAccess,
          `/companies/${company1Id}/history`,
          query,
        );
        seenIds.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor !== null && seenIds.length <= everyId.length);

      expect(seenIds).toEqual(everyId);
    });

    it('bad paging parameters are 400', async () => {
      const path = `/companies/${company1Id}/history`;

      await readAs(ownerAccess, path, { limit: '0' }).expect(400);
      await readAs(ownerAccess, path, { limit: '101' }).expect(400);
      await readAs(ownerAccess, path, { limit: 'ten' }).expect(400);
      await readAs(ownerAccess, path, { cursor: 'page-2' }).expect(400);
      await readAs(ownerAccess, '/companies/not-a-uuid/history').expect(400);
      // well-formed, but no entry has this id
      await readAs(ownerAccess, path, {
        cursor: '00000000-0000-4000-8000-000000000000',
      }).expect(400);
    });

    it('a bookmark from another feed is 400, not a silently wrong page', async () => {
      const feed = await pageAs(
        ownerAccess,
        `/companies/${company1Id}/history`,
        { limit: '1' },
      );
      const companyEntry = feed.items[0]; // newcomer1's promotion
      expect(companyEntry.member.id).not.toBe(staffUserId);

      await readAs(ownerAccess, `/users/${staffUserId}/history`, {
        cursor: companyEntry.id,
      }).expect(400);
    });
  });

  describe('history is permanent', () => {
    it('every foreign key on the history refuses a delete instead of blanking the row', async () => {
      const rules = await prisma.$queryRaw<
        Array<{ name: string; onDelete: string }>
      >`
        SELECT conname::text AS name, confdeltype::text AS "onDelete"
        FROM pg_constraint
        WHERE conrelid = 'membership_changes'::regclass AND contype = 'f'
        ORDER BY conname`;

      expect(rules).toHaveLength(7);
      // In Postgres's catalog 'r' = RESTRICT ('n' would be SET NULL).
      expect(rules.filter((rule) => rule.onDelete !== 'r')).toEqual([]);
    });

    it('so a closed branch can never be erased from under its history', async () => {
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: ownerUserId },
      });
      const branchC = await prisma.companyStore.findFirstOrThrow({
        where: { companyId: owner.companyId!, name: 'Branch C' },
      });

      // Rolled back either way: refused by the database, or undone by the
      // throw below if the delete went through.
      await expect(
        prisma.$transaction(async (transaction) => {
          await transaction.companyStore.delete({ where: { id: branchC.id } });
          throw new Error('the delete went through');
        }),
      ).rejects.toThrow(/foreign key constraint/i);
    });
  });
});
