import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { testPhones } from './helpers/phone';
import { suiteAccounts } from './helpers/accounts';

// Members get a contact email proven through Mailpit (a code email, queued
// and delivered asynchronously), so Jest's 5 s default is too tight.
jest.setTimeout(30_000);

/**
 * Members: who is in which branch, in which role. One story, shared state,
 * run in order: each block builds on what the previous one left behind.
 */
describe('Members (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // Nest types its HTTP server as any; supertest wants its own type
  let http: Parameters<typeof request>[0];
  let accounts: ReturnType<typeof suiteAccounts>;

  let adminAccess: string;
  let ownerAccess: string;
  let owner2Access: string;
  let managerAccess: string;
  let staffAccess: string;

  let ownerProfileId: string;
  let managerProfileId: string;
  let staffProfileId: string;
  let staff2ProfileId: string;
  let staff2Access: string; // signed in as staff; kept through promotion and demotion

  let branchAId: string;
  let branchBId: string;
  let branchDId: string; // nobody works here: the "third branch" for refusals
  let twoBranchManagerId: string; // manager2: works in A and B
  let storeId: string;
  let company2BranchId: string;
  let joinCode1: string;
  let joinCode2: string;
  let company2Id: string;
  let owner2ProfileId: string;

  // accounts.phone is unique across the shared DB: suite 16's own block
  const nextPhone = testPhones(16);

  // a member joins with the code and waits for approval (not approved here);
  // their login email is proven and becomes their contact email
  const registerPending = async (tag: string, joinCode: string = joinCode1) =>
    (await accounts.pendingMember(joinCode, tag, { contactEmail: true }))
      .profileId;

  const approve = (
    access: string,
    profileId: string,
    roleId: number,
    cornerId: string | null,
  ) =>
    request(http)
      .patch(`/profiles/${profileId}/approve`)
      .set('Authorization', `Bearer ${access}`)
      .send({ roleId: roleId, cornerId: cornerId });

  const roleIdOf = async (code: string) =>
    (await prisma.role.findUniqueOrThrow({ where: { code: code } })).id;

  const setRole = (
    access: string,
    profileId: string,
    role: string,
    cornerId?: string | null,
  ) =>
    request(http)
      .put(`/profiles/${profileId}/role`)
      .set('Authorization', `Bearer ${access}`)
      // cornerId left undefined is dropped from the JSON: "not sent"
      .send({ role: role, cornerId: cornerId });

  /** A member view as the API sends it (supertest types every body as any). */
  type MemberBody = {
    id: string;
    role: { code: string; name: string } | null;
    branches: { id: string; name: string }[];
  };

  /** The error message Nest sent (supertest types every body as any). */
  const messageOf = (response: { body: unknown }) =>
    (response.body as { message: string }).message;

  const profileIdByEmail = async (email: string) =>
    (
      await prisma.profile.findFirstOrThrow({
        where: { account: { loginMethods: { some: { email: email } } } },
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

  const addBranch = (access: string, profileId: string, cornerId: string) =>
    request(http)
      .post(`/profiles/${profileId}/branches`)
      .set('Authorization', `Bearer ${access}`)
      .send({ cornerId: cornerId });

  const removeBranch = (access: string, profileId: string, cornerId: string) =>
    request(http)
      .delete(`/profiles/${profileId}/branches/${cornerId}`)
      .set('Authorization', `Bearer ${access}`);

  /** The branches someone works in now, oldest first, straight from the database. */
  const liveBranchIdsOf = async (profileId: string) =>
    (
      await prisma.profileBranch.findMany({
        where: { profileId: profileId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      })
    ).map((assignment) => assignment.companyStoreId);

  const historyOf = (profileId: string) =>
    prisma.membershipChange.findMany({
      where: { profileId: profileId },
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
    http = app.getHttpServer() as Parameters<typeof request>[0];
    accounts = suiteAccounts(app, {
      nextPhone: nextPhone,
      emailDomain: 'mbr.test',
      taxIdOf: (n) => `7${n}6-00-0000${n}`,
      companyNameOf: (n) => `Members Co ${n}`,
    });

    const adminLogin = await request(http)
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);
    adminAccess = adminLogin.body.accessToken;

    const company1 = await accounts.registerOwner(adminAccess, 1);
    joinCode1 = company1.joinCode;
    ownerAccess = company1.access;
    ownerProfileId = company1.profileId;
    const company2 = await accounts.registerOwner(adminAccess, 2);
    owner2Access = company2.access;
    owner2ProfileId = company2.profileId;
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
    branchDId = await openBranch(ownerAccess, storeId, 'Branch D');
    company2BranchId = await openBranch(owner2Access, store.body.id, 'Other');

    // contact emails: the suite checks the manager's in the member list and
    // the emails the staff are sent when their branches change
    const manager = await accounts.registerJoinedMember(
      ownerAccess,
      company1.joinCode,
      'MANAGER',
      'manager',
      { contactEmail: true },
    );
    managerAccess = manager.access;
    managerProfileId = manager.profileId;
    const staff = await accounts.registerJoinedMember(
      ownerAccess,
      company1.joinCode,
      'STAFF',
      'staff',
      { contactEmail: true },
    );
    staffAccess = staff.access;
    staffProfileId = staff.profileId;
    const staff2 = await accounts.registerJoinedMember(
      ownerAccess,
      company1.joinCode,
      'STAFF',
      'staff2',
      { contactEmail: true },
    );
    staff2ProfileId = staff2.profileId;
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

  describe('adding and removing branches', () => {
    // Reads are company-wide; only writes check the branch (assertWorksCorner).
    // A made-up product gets past the branch check (→ 400 Invalid product)
    // only for someone who works in that branch; anyone else gets 403 first.
    const placeMissingProductIn = (cornerId: string) =>
      request(http)
        .post(`/corners/${cornerId}/products`)
        .set('Authorization', `Bearer ${staffAccess}`)
        .send({ productId: '11111111-1111-4111-8111-111111111111' });

    it('the owner adds the manager and the staff to Branch A', async () => {
      const managerAdded = await addBranch(
        ownerAccess,
        managerProfileId,
        branchAId,
      ).expect(201);
      expect(managerAdded.body).toMatchObject({
        id: managerProfileId,
        role: { code: 'MANAGER' },
        branches: [{ id: branchAId, name: 'Branch A' }],
      });

      for (const profileId of [staffProfileId, staff2ProfileId]) {
        await addBranch(ownerAccess, profileId, branchAId).expect(201);
      }
    });

    it('staff in Branch A pass its branch check with the token they already had', async () => {
      await placeMissingProductIn(branchAId).expect(400);
    });

    it('staff added to Branch B too work in both, oldest first, and in no other branch (Review Focus 1)', async () => {
      const added = await addBranch(
        ownerAccess,
        staffProfileId,
        branchBId,
      ).expect(201);
      expect((added.body as MemberBody).branches).toEqual([
        { id: branchAId, name: 'Branch A' },
        { id: branchBId, name: 'Branch B' },
      ]);

      await placeMissingProductIn(branchAId).expect(400);
      await placeMissingProductIn(branchBId).expect(400);
      const refused = await placeMissingProductIn(branchDId).expect(403);
      expect(messageOf(refused)).toBe('You can only work in your own branches');
    });

    it('adding someone to a branch they already work in is 409, and writes nothing', async () => {
      const before = (await historyOf(staffProfileId)).length;

      const refused = await addBranch(
        ownerAccess,
        staffProfileId,
        branchAId,
      ).expect(409);

      expect(messageOf(refused)).toBe('Already in this branch');
      expect(await historyOf(staffProfileId)).toHaveLength(before);
    });

    it('the owner removes staff from Branch A; removing them again is 404', async () => {
      const removed = await removeBranch(
        ownerAccess,
        staffProfileId,
        branchAId,
      ).expect(200);
      expect((removed.body as MemberBody).branches).toEqual([
        { id: branchBId, name: 'Branch B' },
      ]);

      const again = await removeBranch(
        ownerAccess,
        staffProfileId,
        branchAId,
      ).expect(404);
      expect(messageOf(again)).toBe('Not in this branch');
    });

    it('the same token now gets 403 on Branch A: access follows the database, not the token', async () => {
      await placeMissingProductIn(branchAId).expect(403);
      await placeMissingProductIn(branchBId).expect(400);
    });

    it('removing their last branch is allowed: no branch now, the same role', async () => {
      const removed = await removeBranch(
        ownerAccess,
        staffProfileId,
        branchBId,
      ).expect(200);

      expect(removed.body).toMatchObject({
        role: { code: 'STAFF' },
        branches: [],
      });
    });

    it('each assignment started or ended is one history row, the role unchanged', async () => {
      const rows = (await historyOf(staffProfileId)).filter(
        (row) =>
          row.reason === 'BRANCH_ADDED' || row.reason === 'BRANCH_REMOVED',
      );

      expect(
        rows.map((row) => [
          row.reason,
          row.fromCompanyStoreId,
          row.toCompanyStoreId,
        ]),
      ).toEqual([
        ['BRANCH_ADDED', null, branchAId],
        ['BRANCH_ADDED', null, branchBId],
        ['BRANCH_REMOVED', branchAId, null],
        ['BRANCH_REMOVED', branchBId, null],
      ]);
      for (const row of rows) {
        expect(row.fromRoleId).toBe(row.toRoleId); // a snapshot: role unchanged
        expect(row.changedByProfileId).toBe(ownerProfileId);
      }
    });

    it('the member is told when a branch is added, and when one is removed', async () => {
      // memberBranchAdded / memberBranchRemoved
      for (const words of [
        '지점에 배정되었습니다',
        '지점 배정이 해제되었습니다',
      ]) {
        await waitFor(() =>
          prisma.notification.findFirst({
            where: {
              recipientProfileId: staffProfileId,
              eventType: 'member.moved',
              body: { contains: words },
            },
          }),
        );
      }
    });

    it('managers and staff cannot add or remove branches (403)', async () => {
      await addBranch(managerAccess, staff2ProfileId, branchBId).expect(403);
      await addBranch(staffAccess, staff2ProfileId, branchBId).expect(403);
      await removeBranch(managerAccess, staff2ProfileId, branchAId).expect(403);
    });

    it("another company's owner cannot see the member (404)", async () => {
      await addBranch(owner2Access, staff2ProfileId, company2BranchId).expect(
        404,
      );
    });

    it('a branch of another company is not found (404) and nothing changes', async () => {
      const refused = await addBranch(
        ownerAccess,
        staff2ProfileId,
        company2BranchId,
      ).expect(404);

      expect(messageOf(refused)).toBe('Branch not found');
      expect(await liveBranchIdsOf(staff2ProfileId)).toEqual([branchAId]);
    });

    it('an owner gets no branch (400); cornerId is required (400)', async () => {
      const refused = await addBranch(
        ownerAccess,
        ownerProfileId,
        branchAId,
      ).expect(400);
      expect(messageOf(refused)).toBe('Owners work across the whole company');

      await request(http)
        .post(`/profiles/${staff2ProfileId}/branches`)
        .set('Authorization', `Bearer ${ownerAccess}`)
        .send({})
        .expect(400);
    });

    it('the admin can add and remove branches for a member of any company', async () => {
      await addBranch(adminAccess, staff2ProfileId, branchBId).expect(201);
      await removeBranch(adminAccess, staff2ProfileId, branchBId).expect(200);
      expect(await liveBranchIdsOf(staff2ProfileId)).toEqual([branchAId]);

      // staff2 got 3 branch emails (the owner added A, the admin added and
      // removed B). Wait for all 3 to be sent, so the app isn't closed while
      // the notification pipeline is still queueing them.
      await waitFor(async () => {
        const sent = await prisma.notification.count({
          where: {
            recipientProfileId: staff2ProfileId,
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
        branches: [{ id: branchAId, name: 'Branch A' }],
      });
      const [firstRow] = await historyOf(newcomerId);
      expect(firstRow).toMatchObject({
        reason: 'APPROVED',
        fromRoleId: null,
        toRoleId: await roleIdOf('STAFF'),
        fromCompanyStoreId: null,
        toCompanyStoreId: branchAId,
        changedByProfileId: managerProfileId,
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

      const stillPending = await prisma.profile.findUniqueOrThrow({
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
        branches: [],
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

      const stillPending = await prisma.profile.findUniqueOrThrow({
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
        .patch(`/profiles/${newcomerId}/approve`)
        .set('Authorization', `Bearer ${ownerAccess}`)
        .send({ roleId: await roleIdOf('STAFF') })
        .expect(400);
    });

    it("the admin cannot approve a company's pending owner as a member (400); they stay its owner", async () => {
      // Company 3 registers; the admin has not approved the company yet.
      const pendingOwnerId = (await accounts.pendingOwner(3)).profileId;

      await approve(
        adminAccess,
        pendingOwnerId,
        await roleIdOf('STAFF'),
        null,
      ).expect(400);

      const pendingOwner = await prisma.profile.findUniqueOrThrow({
        where: { id: pendingOwnerId },
        include: { role: true },
      });
      expect(pendingOwner.status).toBe('PENDING_APPROVAL');
      expect(pendingOwner.role?.code).toBe('OWNER');
      expect(await historyOf(pendingOwnerId)).toEqual([]);
    });

    it('staff given a personal profiles.approve grant still cannot approve (403), nor see who is waiting: the role decides', async () => {
      const newcomerId = await registerPending('newcomer7');
      const approvePermission = await prisma.permission.findUniqueOrThrow({
        where: { code: 'profiles.approve' },
      });
      // The grant lets staff past the permission guard; the service's rule
      // for their role must still refuse.
      await prisma.profilePermission.create({
        data: {
          profileId: staffProfileId,
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
          .get('/profiles')
          .set('Authorization', `Bearer ${staffAccess}`)
          .expect(200);
        const listedIds = (list.body as Array<{ id: string }>).map(
          (member) => member.id,
        );
        expect(listedIds).not.toContain(newcomerId);
      } finally {
        await prisma.profilePermission.delete({
          where: {
            profileId_permissionId: {
              profileId: staffProfileId,
              permissionId: approvePermission.id,
            },
          },
        });
      }

      const newcomer = await prisma.profile.findUniqueOrThrow({
        where: { id: newcomerId },
      });
      expect(newcomer.status).toBe('PENDING_APPROVAL');
    });
  });

  describe('a manager in two branches (Review Focus 1)', () => {
    let twoBranchManagerAccess: string;

    beforeAll(async () => {
      const manager2 = await accounts.registerJoinedMember(
        ownerAccess,
        joinCode1,
        'MANAGER',
        'manager2',
      );
      twoBranchManagerAccess = manager2.access;
      twoBranchManagerId = manager2.profileId;
      await addBranch(ownerAccess, twoBranchManagerId, branchAId).expect(201);
      await addBranch(ownerAccess, twoBranchManagerId, branchBId).expect(201);
    });

    it('approves a newcomer into either of their branches, never into another (403)', async () => {
      const newcomerId = await registerPending('newcomer8');
      const staffRoleId = await roleIdOf('STAFF');

      const refused = await approve(
        twoBranchManagerAccess,
        newcomerId,
        staffRoleId,
        branchDId,
      ).expect(403);
      expect(messageOf(refused)).toBe(
        'Managers can approve only into their own branch',
      );

      const approved = await approve(
        twoBranchManagerAccess,
        newcomerId,
        staffRoleId,
        branchBId,
      ).expect(200);
      expect((approved.body as MemberBody).branches).toEqual([
        { id: branchBId, name: 'Branch B' },
      ]);
    });

    it("reads both branches' histories, but not a third branch's (403)", async () => {
      for (const cornerId of [branchAId, branchBId]) {
        await request(http)
          .get(`/corners/${cornerId}/history`)
          .set('Authorization', `Bearer ${twoBranchManagerAccess}`)
          .expect(200);
      }
      await request(http)
        .get(`/corners/${branchDId}/history`)
        .set('Authorization', `Bearer ${twoBranchManagerAccess}`)
        .expect(403);
    });
  });

  describe('changing roles', () => {
    let promotedId: string; // newcomer1: STAFF in Branch A, approved by the manager

    beforeAll(async () => {
      promotedId = await profileIdByEmail('newcomer1@mbr.test');
    });

    it('a manager cannot promote anyone, even staff of their own branch (403): only owners make managers', async () => {
      const refused = await setRole(
        managerAccess,
        promotedId,
        'MANAGER',
      ).expect(403);

      expect(messageOf(refused)).toBe('Managers can only step down themselves');
    });

    it('the owner promotes staff in Branch A to manager; they stay there', async () => {
      const changed = await setRole(ownerAccess, promotedId, 'MANAGER').expect(
        200,
      );

      expect(changed.body).toMatchObject({
        role: { code: 'MANAGER' },
        branches: [{ id: branchAId }],
      });
      const rows = await historyOf(promotedId);
      expect(rows[rows.length - 1]).toMatchObject({
        reason: 'ROLE_CHANGED',
        fromRoleId: await roleIdOf('STAFF'),
        toRoleId: await roleIdOf('MANAGER'),
        fromCompanyStoreId: branchAId,
        toCompanyStoreId: branchAId, // a snapshot: the branch didn't change
        changedByProfileId: ownerProfileId,
      });
    });

    it('the promoted member is notified', async () => {
      await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            recipientProfileId: promotedId,
            eventType: 'member.roleChanged',
          },
        }),
      );
    });

    it('a manager cannot promote outside their branch, demote another manager, or touch an owner (403)', async () => {
      await setRole(managerAccess, staffProfileId, 'MANAGER').expect(403); // staff has no branch
      await setRole(managerAccess, promotedId, 'STAFF').expect(403); // now a manager too
      await setRole(managerAccess, ownerProfileId, 'STAFF').expect(403);
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
        branches: [{ id: branchAId }],
      });
    });

    it('cornerId is refused unless an owner is being demoted (400)', async () => {
      await setRole(ownerAccess, promotedId, 'MANAGER', branchBId).expect(400);
      await setRole(ownerAccess, promotedId, 'MANAGER', null).expect(400);
    });

    it('the owner promotes staff in Branches A and B to owner: both assignments end, one history row each', async () => {
      await addBranch(ownerAccess, staff2ProfileId, branchBId).expect(201);
      const staffRoleId = await roleIdOf('STAFF');
      const ownerRoleId = await roleIdOf('OWNER');

      const changed = await setRole(
        ownerAccess,
        staff2ProfileId,
        'OWNER',
      ).expect(200);

      expect(changed.body).toMatchObject({
        role: { code: 'OWNER' },
        branches: [],
      });
      expect(await liveBranchIdsOf(staff2ProfileId)).toEqual([]);
      const promotionRows = (await historyOf(staff2ProfileId)).filter(
        (row) => row.reason === 'ROLE_CHANGED',
      );
      // written in one statement: same timestamp, so compare without order
      expect(
        promotionRows.map((row) => [
          row.fromRoleId,
          row.fromCompanyStoreId,
          row.toRoleId,
          row.toCompanyStoreId,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [staffRoleId, branchAId, ownerRoleId, null],
          [staffRoleId, branchBId, ownerRoleId, null],
        ]),
      );
      expect(promotionRows).toHaveLength(2);

      // The token staff2 signed in with as staff now passes owner-only routes:
      // adding the manager to Branch A gets past the permission check and is
      // refused only for the data (409: already there), not with a 403.
      await addBranch(staff2Access, managerProfileId, branchAId).expect(409);
    });

    it('owners cannot demote another owner (403)', async () => {
      const refused = await setRole(
        ownerAccess,
        staff2ProfileId,
        'MANAGER',
      ).expect(403);

      expect(messageOf(refused)).toBe("Owners cannot change an owner's role");
    });

    it('the admin demotes one of two owners into Branch B; the last owner stays (409)', async () => {
      const demoted = await setRole(
        adminAccess,
        staff2ProfileId,
        'STAFF',
        branchBId,
      ).expect(200);
      expect(demoted.body).toMatchObject({
        role: { code: 'STAFF' },
        branches: [{ id: branchBId }],
      });

      await setRole(adminAccess, ownerProfileId, 'STAFF', null).expect(409);
      const owner = await prisma.profile.findUniqueOrThrow({
        where: { id: ownerProfileId },
        include: { role: true },
      });
      expect(owner.role!.code).toBe('OWNER');
    });

    it("the demoted owner's existing token loses owner-only routes (403)", async () => {
      // Same token as before the demotion: the guard reads the role from the
      // database on every request.
      await addBranch(staff2Access, managerProfileId, branchAId).expect(403);
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
        setRole(adminAccess, owner2ProfileId, 'STAFF', null),
        setRole(adminAccess, secondOwnerId, 'STAFF', null),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const owners = await prisma.profile.findMany({
        where: {
          companyId: company2Id,
          role: { code: 'OWNER' },
          status: 'ACTIVE',
          deletedAt: null,
        },
      });
      expect(owners).toHaveLength(1);

      // keep company 2's original owner an owner for the rest of the suite
      if (owners[0].id !== owner2ProfileId) {
        await setRole(adminAccess, owner2ProfileId, 'OWNER').expect(200);
      }
    });

    it('an owner demotion waits for the company row lock before counting owners', async () => {
      const owner = await prisma.profile.findUniqueOrThrow({
        where: { id: ownerProfileId },
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
      const demotion = setRole(adminAccess, ownerProfileId, 'STAFF', null).then(
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

  // Company 4 of its own, so its owner count can't disturb companies 1 and 2.
  describe('approving an owner, and stepping down', () => {
    let owner4Access: string;
    let owner4ProfileId: string;
    let joinCode4: string;
    let branch4Id: string;
    let newOwnerId: string;
    let newOwnerAccess: string; // signed in while waiting; kept through every change

    beforeAll(async () => {
      const company4 = await accounts.registerOwner(adminAccess, 4);
      owner4Access = company4.access;
      owner4ProfileId = company4.profileId;
      joinCode4 = company4.joinCode;
      branch4Id = await openBranch(owner4Access, storeId, 'Branch Four');
    });

    it('an owner approves a newcomer as an owner, with no branch; with a branch it is 400', async () => {
      const newcomer = await accounts.pendingMember(joinCode4, 'newowner4');
      newOwnerId = newcomer.profileId;
      newOwnerAccess = newcomer.access;
      const ownerRoleId = await roleIdOf('OWNER');

      const refused = await approve(
        owner4Access,
        newOwnerId,
        ownerRoleId,
        branch4Id,
      ).expect(400);
      expect(messageOf(refused)).toBe('Owners work across the whole company');

      const approved = await approve(
        owner4Access,
        newOwnerId,
        ownerRoleId,
        null,
      ).expect(200);
      expect(approved.body).toMatchObject({
        status: 'ACTIVE',
        role: { code: 'OWNER' },
        branches: [],
      });
      const [firstRow] = await historyOf(newOwnerId);
      expect(firstRow).toMatchObject({
        reason: 'APPROVED',
        fromRoleId: null,
        toRoleId: ownerRoleId,
        fromCompanyStoreId: null,
        toCompanyStoreId: null,
        changedByProfileId: owner4ProfileId,
      });
    });

    it('the new owner steps down into a branch while the first owner remains', async () => {
      const steppedDown = await setRole(
        newOwnerAccess,
        newOwnerId,
        'MANAGER',
        branch4Id,
      ).expect(200);

      expect(steppedDown.body).toMatchObject({
        role: { code: 'MANAGER' },
        branches: [{ id: branch4Id, name: 'Branch Four' }],
      });
      const rows = await historyOf(newOwnerId);
      expect(rows[rows.length - 1]).toMatchObject({
        reason: 'ROLE_CHANGED',
        fromRoleId: await roleIdOf('OWNER'),
        toRoleId: await roleIdOf('MANAGER'),
        fromCompanyStoreId: null,
        toCompanyStoreId: branch4Id,
        changedByProfileId: newOwnerId, // they did it themselves
      });
    });

    it('the last owner cannot step down (409), and stays an owner', async () => {
      const refused = await setRole(
        owner4Access,
        owner4ProfileId,
        'STAFF',
      ).expect(409);

      expect(messageOf(refused)).toBe('A company needs at least one owner');
      const owner4 = await prisma.profile.findUniqueOrThrow({
        where: { id: owner4ProfileId },
        include: { role: true },
      });
      expect(owner4.role!.code).toBe('OWNER');
    });

    it('a manager steps down to staff, and stays in their branch', async () => {
      const steppedDown = await setRole(
        newOwnerAccess,
        newOwnerId,
        'STAFF',
      ).expect(200);

      expect(steppedDown.body).toMatchObject({
        role: { code: 'STAFF' },
        branches: [{ id: branch4Id }],
      });
    });

    it('staff cannot step back up (403)', async () => {
      await setRole(newOwnerAccess, newOwnerId, 'MANAGER').expect(403);
    });
  });

  describe('deleting a branch ends its assignments', () => {
    let branchCId: string;
    let releasedManagerId: string; // newcomer3: MANAGER, no branch until now

    beforeAll(async () => {
      branchCId = await openBranch(ownerAccess, storeId, 'Branch C');
      releasedManagerId = await profileIdByEmail('newcomer3@mbr.test');
      await addBranch(ownerAccess, releasedManagerId, branchCId).expect(201);
      await addBranch(ownerAccess, staffProfileId, branchCId).expect(201);
      // staff2 works in Branch B as well
      await addBranch(ownerAccess, staff2ProfileId, branchCId).expect(201);
    });

    it("the owner deletes Branch C: only C's assignments end, and nobody's role changes", async () => {
      await request(http)
        .delete(`/corners/${branchCId}`)
        .set('Authorization', `Bearer ${ownerAccess}`)
        .expect(200);

      expect(await liveBranchIdsOf(releasedManagerId)).toEqual([]);
      expect(await liveBranchIdsOf(staffProfileId)).toEqual([]);
      expect(await liveBranchIdsOf(staff2ProfileId)).toEqual([branchBId]); // B untouched
      const releasedManager = await prisma.profile.findUniqueOrThrow({
        where: { id: releasedManagerId },
        include: { role: true },
      });
      expect(releasedManager.role!.code).toBe('MANAGER'); // now a manager with no branch
    });

    it('each ended assignment gets one BRANCH_DELETED history row', async () => {
      const rows = await prisma.membershipChange.findMany({
        where: { reason: 'BRANCH_DELETED', fromCompanyStoreId: branchCId },
      });

      expect(rows.map((row) => row.profileId).sort()).toEqual(
        [releasedManagerId, staffProfileId, staff2ProfileId].sort(),
      );
      for (const row of rows) {
        expect(row.toCompanyStoreId).toBeNull();
        expect(row.fromRoleId).toBe(row.toRoleId); // a snapshot: role unchanged
        expect(row.changedByProfileId).toBe(ownerProfileId);
      }
    });

    it('each person whose assignment ended is told the branch was closed', async () => {
      for (const profileId of [
        releasedManagerId,
        staffProfileId,
        staff2ProfileId,
      ]) {
        await waitFor(() =>
          prisma.notification.findFirst({
            where: {
              recipientProfileId: profileId,
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

    it('nobody can be added to the deleted branch (404)', async () => {
      await addBranch(ownerAccess, staffProfileId, branchCId).expect(404);
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
      ).toBe(3);
    });
  });

  describe('the member list', () => {
    const listAs = (access: string, query: Record<string, string> = {}) =>
      request(http)
        .get('/profiles')
        .query(query)
        .set('Authorization', `Bearer ${access}`);

    it('staff list their company, with phone and contact email', async () => {
      const list = await listAs(staffAccess).expect(200);

      const manager = list.body.find(
        (member: { id: string }) => member.id === managerProfileId,
      );
      expect(manager).toMatchObject({
        name: 'manager',
        contactEmail: 'manager@mbr.test',
        status: 'ACTIVE',
        role: { code: 'MANAGER' },
        branches: [{ id: branchAId, name: 'Branch A' }],
      });
      expect(manager.phone).toEqual(expect.any(String));
    });

    it('the other company never appears, even when it is named', async () => {
      const list = await listAs(ownerAccess, {
        companyId: company2Id,
      }).expect(200);

      const ids = list.body.map((member: { id: string }) => member.id);
      expect(ids).toContain(ownerProfileId);
      expect(ids).not.toContain(owner2ProfileId);
    });

    it('pending members are listed, with no role and no branch', async () => {
      const pendingId = await profileIdByEmail('newcomer2@mbr.test');

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
          branches: [],
        });
      }
    });

    it('managers, who can approve, see people waiting for approval', async () => {
      const pendingId = await profileIdByEmail('newcomer2@mbr.test');

      const list = await listAs(managerAccess).expect(200);

      expect(list.body.map((member: { id: string }) => member.id)).toContain(
        pendingId,
      );
    });

    it('staff, who cannot approve, never see people waiting for approval', async () => {
      const pendingId = await profileIdByEmail('newcomer2@mbr.test');

      const list = await listAs(staffAccess).expect(200);
      expect(
        list.body.map((member: { id: string }) => member.id),
      ).not.toContain(pendingId);

      const askedDirectly = await listAs(staffAccess, {
        status: 'PENDING_APPROVAL',
      }).expect(200);
      expect(askedDirectly.body).toEqual([]);
    });

    it('filters by branch: everyone listed works in it, among their branches', async () => {
      const inBranchA = await listAs(ownerAccess, {
        cornerId: branchAId,
      }).expect(200);

      expect(
        inBranchA.body.map((member: { id: string }) => member.id),
      ).toContain(managerProfileId);
      for (const member of inBranchA.body as MemberBody[]) {
        expect(member.branches.map((branch) => branch.id)).toContain(branchAId);
      }
    });

    it('cornerId and role together: exactly the managers who work in Branch A', async () => {
      const managersInA = await listAs(ownerAccess, {
        cornerId: branchAId,
        role: 'MANAGER',
      }).expect(200);

      // not newcomer3, a manager with no branch since Branch C closed
      const managerIds = (managersInA.body as MemberBody[]).map(
        (member) => member.id,
      );
      expect(managerIds.sort()).toEqual(
        [managerProfileId, twoBranchManagerId].sort(),
      );
    });

    it('cornerId=none lists the people with no branch', async () => {
      const noBranch = await listAs(ownerAccess, { cornerId: 'none' }).expect(
        200,
      );

      const ids = noBranch.body.map((member: { id: string }) => member.id);
      expect(ids).toContain(staffProfileId); // their last branch was Branch C
      expect(ids).toContain(await profileIdByEmail('newcomer3@mbr.test')); // a manager, no branch
      expect(ids).toContain(ownerProfileId); // owners have no assignments
      expect(ids).not.toContain(managerProfileId); // in Branch A
      for (const member of noBranch.body as MemberBody[]) {
        expect(member.branches).toEqual([]);
      }
    });

    it('filters by role', async () => {
      const managers = await listAs(ownerAccess, { role: 'MANAGER' }).expect(
        200,
      );

      expect(
        managers.body.map((member: { id: string }) => member.id),
      ).toContain(managerProfileId);
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
      expect(ids).toContain(owner2ProfileId);
      expect(ids).not.toContain(ownerProfileId);
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
      const owner = await prisma.profile.findUniqueOrThrow({
        where: { id: ownerProfileId },
      });
      company1Id = owner.companyId!;
      promotedId = await profileIdByEmail('newcomer1@mbr.test');
      pendingId = await profileIdByEmail('newcomer2@mbr.test');
    });

    it("a promotion in Branch A shows in Branch A's history, from A to A; its manager reads it", async () => {
      await setRole(ownerAccess, promotedId, 'MANAGER').expect(200);

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
        id: ownerProfileId,
        name: 'Owner 1',
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
      await readAs(owner2Access, `/profiles/${staffProfileId}/history`).expect(
        404,
      );
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
          member: { id: staffProfileId, name: 'staff' },
          fromBranch: { id: branchC.id, name: 'Branch C' },
          toBranch: null,
        }),
      );
    });

    it("staff read their own history, newest first, but not a colleague's (403)", async () => {
      const own = await pageAs(
        staffAccess,
        `/profiles/${staffProfileId}/history`,
      );

      expect(own.items.length).toBeGreaterThan(0);
      for (const item of own.items) {
        expect(item.member.id).toBe(staffProfileId);
      }
      expect(own.items[0].reason).toBe('BRANCH_DELETED'); // their latest change

      await readAs(staffAccess, `/profiles/${managerProfileId}/history`).expect(
        403,
      );
    });

    it('a manager reads the people in their branch, but not someone outside it (403)', async () => {
      await readAs(managerAccess, `/profiles/${promotedId}/history`).expect(
        200,
      ); // in Branch A
      await readAs(managerAccess, `/profiles/${staffProfileId}/history`).expect(
        403,
      ); // no branch
    });

    it('someone waiting for approval has a history too: empty so far', async () => {
      const pending = await pageAs(
        ownerAccess,
        `/profiles/${pendingId}/history`,
      );

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
      expect(companyEntry.member.id).not.toBe(staffProfileId);

      await readAs(ownerAccess, `/profiles/${staffProfileId}/history`, {
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
      const owner = await prisma.profile.findUniqueOrThrow({
        where: { id: ownerProfileId },
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
