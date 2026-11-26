import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeSocialVerifier } from '../src/social-auth/verifiers/fake.verifier';
import { testPhones, verifiedPhoneToken } from './helpers/phone';
import {
  joinCompany,
  signUp,
  suiteAccounts,
  switchTo,
} from './helpers/accounts';
import type { MemberSetup, OwnerSetup, Session } from './helpers/accounts';

// Owners get a contact email proven through Mailpit (a code email, queued
// and delivered asynchronously), so Jest's 5 s default is too tight.
jest.setTimeout(30_000);

/**
 * Leaving a company: POST /profiles/me/leave and its preview, removal
 * (POST /profiles/:id/remove), and deleting an account (DELETE /me). Every
 * block has its own company, so the blocks can't disturb each other.
 */
describe('Leaving (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // Nest types its HTTP server as any; supertest wants its own type
  let http: Parameters<typeof request>[0];
  let accounts: ReturnType<typeof suiteAccounts>;
  let adminAccess: string;
  let storeId: string;

  // accounts.phone is unique across the shared DB: suite 18's own block
  const nextPhone = testPhones(18);
  const taxIdOf = (n: number) => `018-18-0000${n}`;

  /** What POST /profiles/me/leave answers (supertest types every body as any). */
  type LeaveSummaryBody = {
    companyClosed: boolean;
    newOwner: { profileId: string; name: string; picked: string } | null;
  };
  /** A member view, as GET /profiles lists it. */
  type MemberBody = { id: string; name: string; status: string };

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  const leave = (access: string, body: Record<string, unknown> = {}) =>
    request(http)
      .post('/profiles/me/leave')
      .set(...auth(access))
      .send(body);

  const removeMember = (access: string, profileId: string) =>
    request(http)
      .post(`/profiles/${profileId}/remove`)
      .set(...auth(access));

  const previewOf = (access: string) =>
    request(http)
      .get('/profiles/me/leave-preview')
      .set(...auth(access));

  const deleteMe = (access: string, phoneVerificationToken: string) =>
    request(http)
      .delete('/me')
      .set(...auth(access))
      .send({ phoneVerificationToken: phoneVerificationToken });

  /** Link a Kakao identity the fake verifier vouches for (no nonce needed). */
  const linkKakao = (access: string, credentialToken: string) =>
    request(http)
      .post('/accounts/me/login-methods')
      .set(...auth(access))
      .send({ provider: 'kakao', credential: { token: credentialToken } });

  /** A Kakao identity the fake verifier will vouch for, behind `credentialToken`. */
  const vouchForKakao = (credentialToken: string, providerUserId: string) =>
    app.get(FakeSocialVerifier).register(credentialToken, {
      provider: 'kakao',
      providerUserId: providerUserId,
      email: null,
      emailVerified: false,
      name: null,
      refreshToken: null,
    });

  const accountIdOfPhone = async (phone: string) =>
    (
      await prisma.account.findFirstOrThrow({
        where: { phone: phone, deletedAt: null },
      })
    ).id;

  /** The error message Nest sent. */
  const messageOf = (response: { body: unknown }) =>
    (response.body as { message: string }).message;

  const roleIdOf = async (code: string) =>
    (await prisma.role.findUniqueOrThrow({ where: { code: code } })).id;

  const openBranch = async (access: string, name: string) => {
    const response = await request(http)
      .post('/corners')
      .set(...auth(access))
      .send({ storeId: storeId, name: name })
      .expect(201);
    return (response.body as { id: string }).id;
  };

  const addBranch = (access: string, profileId: string, cornerId: string) =>
    request(http)
      .post(`/profiles/${profileId}/branches`)
      .set(...auth(access))
      .send({ cornerId: cornerId });

  const profileOf = (profileId: string) =>
    prisma.profile.findUniqueOrThrow({
      where: { id: profileId },
      include: { role: true },
    });

  /** The branches someone works in now, straight from the database. */
  const liveBranchIdsOf = async (profileId: string) =>
    (
      await prisma.profileBranch.findMany({
        where: { profileId: profileId, deletedAt: null },
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
      if (value) {
        return value;
      }
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
      emailDomain: 'lv.test',
      taxIdOf: taxIdOf,
      companyNameOf: (n) => `Leaving Co ${n}`,
    });

    const adminLogin = await request(http)
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);
    adminAccess = (adminLogin.body as { accessToken: string }).accessToken;

    const store = await request(http)
      .post('/stores')
      .set(...auth(adminAccess))
      .send({ name: 'Leaving Mall' })
      .expect(201);
    storeId = (store.body as { id: string }).id;
  });

  afterAll(async () => {
    // Let this suite's emails finish sending before closing the app, so the
    // queue isn't shut down mid-job ("Connection is closed").
    await waitFor(async () => {
      const pending = await prisma.notification.count({
        where: {
          status: 'PENDING',
          recipientAddress: { endsWith: '@lv.test' },
        },
      });
      return pending === 0 ? true : null;
    });
    await app.close();
  });

  describe('a staff member leaves', () => {
    let owner: OwnerSetup;
    let park: MemberSetup;
    let branchId: string;
    let parkWithoutCompany: Session; // after the refresh that found nothing to open

    beforeAll(async () => {
      owner = await accounts.registerOwner(adminAccess, 1, {
        contactEmail: true,
      });
      branchId = await openBranch(owner.access, 'Branch 1');
      park = await accounts.registerJoinedMember(
        owner.access,
        owner.joinCode,
        'STAFF',
        'park1',
      );
      await addBranch(owner.access, park.profileId, branchId).expect(201);
    });

    it('the preview: staff need no successor, and the company stays', async () => {
      const preview = await previewOf(park.access).expect(200);

      expect(preview.body).toEqual({ companyWillClose: false, owner: null });
    });

    it('leaves: 200 with a summary; DEACTIVATED, their branch ended, one LEFT_COMPANY row', async () => {
      const left = await leave(park.access).expect(200);

      expect(left.body).toEqual({ companyClosed: false, newOwner: null });
      expect((await profileOf(park.profileId)).status).toBe('DEACTIVATED');
      expect(await liveBranchIdsOf(park.profileId)).toEqual([]);
      const leftRows = (await historyOf(park.profileId)).filter(
        (row) => row.reason === 'LEFT_COMPANY',
      );
      expect(leftRows).toHaveLength(1);
      expect(leftRows[0]).toMatchObject({
        fromRoleId: await roleIdOf('STAFF'),
        toRoleId: null,
        fromCompanyStoreId: branchId,
        toCompanyStoreId: null,
        changedByProfileId: park.profileId,
      });
    });

    it('their old access token gets 401 at once: the guard reads the status on every request (Review Focus 3)', async () => {
      await request(http)
        .get('/profiles')
        .set(...auth(park.access))
        .expect(401);
    });

    it('their refresh opens no company, and company routes then say "Choose a company first"', async () => {
      const refreshed = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: park.refreshToken })
        .expect(201);
      const session = refreshed.body as {
        accessToken: string;
        refreshToken: string;
        profile: unknown;
      };
      expect(session.profile).toBeNull();
      parkWithoutCompany = {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      };

      const refused = await request(http)
        .get('/profiles')
        .set(...auth(session.accessToken))
        .expect(403);
      expect(messageOf(refused)).toBe('Choose a company first');
    });

    it('the owner is told', async () => {
      await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            recipientProfileId: owner.profileId,
            eventType: 'member.left',
            body: { contains: 'park1' },
          },
        }),
      );
    });

    it('the member list hides the old profile; ?status=DEACTIVATED shows it', async () => {
      const list = await request(http)
        .get('/profiles')
        .set(...auth(owner.access))
        .expect(200);
      expect(
        (list.body as MemberBody[]).map((member) => member.id),
      ).not.toContain(park.profileId);

      const departed = await request(http)
        .get('/profiles')
        .query({ status: 'DEACTIVATED' })
        .set(...auth(owner.access))
        .expect(200);
      expect(
        (departed.body as MemberBody[]).map((member) => member.id),
      ).toEqual([park.profileId]);
    });

    it('they can come back with the code: a new profile waits for approval, the old one stays a record, and the list shows them once', async () => {
      const rejoined = await joinCompany(
        app,
        parkWithoutCompany,
        owner.joinCode,
        'park1',
      );

      expect(rejoined.profileId).not.toBe(park.profileId);
      expect((await profileOf(rejoined.profileId)).status).toBe(
        'PENDING_APPROVAL',
      );
      expect((await profileOf(park.profileId)).status).toBe('DEACTIVATED');
      const list = await request(http)
        .get('/profiles')
        .set(...auth(owner.access))
        .expect(200);
      expect(
        (list.body as MemberBody[]).filter((member) => member.name === 'park1'),
      ).toEqual([expect.objectContaining({ id: rejoined.profileId })]);
    });
  });

  describe('an owner names who takes over', () => {
    let owner: OwnerSetup;
    let lee: MemberSetup;
    let kim: MemberSetup;
    let outsider: OwnerSetup; // the owner of another company
    let branchId: string;

    beforeAll(async () => {
      owner = await accounts.registerOwner(adminAccess, 2);
      outsider = await accounts.registerOwner(adminAccess, 6);
      branchId = await openBranch(owner.access, 'Branch 2');
      lee = await accounts.registerJoinedMember(
        owner.access,
        owner.joinCode,
        'MANAGER',
        'lee2',
      );
      kim = await accounts.registerJoinedMember(
        owner.access,
        owner.joinCode,
        'STAFF',
        'kim2',
      );
      await addBranch(owner.access, lee.profileId, branchId).expect(201);
      await addBranch(owner.access, kim.profileId, branchId).expect(201);
    });

    it('the preview lists who could take over, oldest first, and who the system would pick', async () => {
      const preview = await previewOf(owner.access).expect(200);

      expect(preview.body).toEqual({
        companyWillClose: false,
        owner: {
          successorNeeded: true,
          candidates: [
            { profileId: lee.profileId, name: 'lee2', role: 'MANAGER' },
            { profileId: kim.profileId, name: 'kim2', role: 'STAFF' },
          ],
          defaultPick: lee.profileId, // managers first
        },
      });
    });

    it('someone who cannot take over is 400, and the owner stays (Review Focus 5)', async () => {
      const waiting = await accounts.pendingMember(owner.joinCode, 'waiting2');

      for (const ineligibleId of [
        waiting.profileId, // still waiting for approval
        outsider.profileId, // another company's owner
        owner.profileId, // the leaver themselves
      ]) {
        const refused = await leave(owner.access, {
          ownerSuccessorProfileId: ineligibleId,
        }).expect(400);
        expect(messageOf(refused)).toBe(
          'This person cannot take over as owner',
        );
      }

      const ownerNow = await profileOf(owner.profileId);
      expect(ownerNow.status).toBe('ACTIVE');
      expect(ownerNow.role?.code).toBe('OWNER');
      expect((await profileOf(waiting.profileId)).status).toBe(
        'PENDING_APPROVAL',
      );
    });

    it('a waiting newcomer withdraws their request: DEACTIVATED, nothing recorded', async () => {
      const waiting = await accounts.pendingMember(owner.joinCode, 'waiting2b');

      const left = await leave(waiting.access).expect(200);

      expect(left.body).toEqual({ companyClosed: false, newOwner: null });
      expect((await profileOf(waiting.profileId)).status).toBe('DEACTIVATED');
      expect(await historyOf(waiting.profileId)).toEqual([]);
    });

    it('names Kim: Kim is the owner, works everywhere now (their branch ended), and the history says the leaver chose', async () => {
      const left = await leave(owner.access, {
        ownerSuccessorProfileId: kim.profileId,
      }).expect(200);

      expect(left.body as LeaveSummaryBody).toEqual({
        companyClosed: false,
        newOwner: { profileId: kim.profileId, name: 'kim2', picked: 'CHOSEN' },
      });
      const kimNow = await profileOf(kim.profileId);
      expect(kimNow.role?.code).toBe('OWNER');
      expect(kimNow.status).toBe('ACTIVE');
      expect(await liveBranchIdsOf(kim.profileId)).toEqual([]);
      const kimRows = await historyOf(kim.profileId);
      expect(kimRows[kimRows.length - 1]).toMatchObject({
        reason: 'ROLE_CHANGED',
        fromRoleId: await roleIdOf('STAFF'),
        toRoleId: await roleIdOf('OWNER'),
        fromCompanyStoreId: branchId,
        toCompanyStoreId: null,
        changedByProfileId: owner.profileId,
      });
      expect((await profileOf(owner.profileId)).status).toBe('DEACTIVATED');
    });

    it("Kim's existing token now passes owner-only routes", async () => {
      // Adding Lee to a branch they already work in gets past the permission
      // check and is refused only for the data (409), not with a 403.
      await addBranch(kim.access, lee.profileId, branchId).expect(409);
    });
  });

  describe('the last owner leaves without naming anyone', () => {
    let owner: OwnerSetup;
    let earlyStaff: MemberSetup;
    let firstManager: MemberSetup;

    beforeAll(async () => {
      owner = await accounts.registerOwner(adminAccess, 3);
      // the order they join in is the order of their createdAt
      earlyStaff = await accounts.registerJoinedMember(
        owner.access,
        owner.joinCode,
        'STAFF',
        'early3',
      );
      firstManager = await accounts.registerJoinedMember(
        owner.access,
        owner.joinCode,
        'MANAGER',
        'mgr3a',
      );
      await accounts.registerJoinedMember(
        owner.access,
        owner.joinCode,
        'MANAGER',
        'mgr3b',
      );
    });

    it('the system picks the longest-serving manager over earlier staff: AUTO_PROMOTED, by nobody', async () => {
      const left = await leave(owner.access).expect(200);

      expect(left.body as LeaveSummaryBody).toEqual({
        companyClosed: false,
        newOwner: {
          profileId: firstManager.profileId,
          name: 'mgr3a',
          picked: 'AUTO',
        },
      });
      expect((await profileOf(firstManager.profileId)).role?.code).toBe(
        'OWNER',
      );
      expect((await profileOf(earlyStaff.profileId)).role?.code).toBe('STAFF');
      const managerRows = await historyOf(firstManager.profileId);
      expect(managerRows[managerRows.length - 1]).toMatchObject({
        reason: 'AUTO_PROMOTED',
        fromRoleId: await roleIdOf('MANAGER'),
        toRoleId: await roleIdOf('OWNER'),
        changedByProfileId: null, // the system chose
      });
    });
  });

  describe('two owners leave at the same moment (Review Focus 2)', () => {
    let owner: OwnerSetup;
    let coOwner: MemberSetup;
    let remaining: MemberSetup;

    beforeAll(async () => {
      owner = await accounts.registerOwner(adminAccess, 4);
      coOwner = await accounts.pendingMember(owner.joinCode, 'co4');
      await request(http)
        .patch(`/profiles/${coOwner.profileId}/approve`)
        .set(...auth(owner.access))
        .send({ roleId: await roleIdOf('OWNER'), cornerId: null })
        .expect(200);
      remaining = await accounts.registerJoinedMember(
        owner.access,
        owner.joinCode,
        'STAFF',
        'staff4',
      );
    });

    it('one of them hands over to the remaining member; the company never ends up with no owner', async () => {
      // A smoke test: if the two requests happen not to overlap, the same
      // outcome comes out with or without the lock. The unit tests prove the
      // company lock comes first.
      const results = await Promise.all([
        leave(owner.access),
        leave(coOwner.access),
      ]);

      expect(results.map((result) => result.status)).toEqual([200, 200]);
      const summaries = results.map(
        (result) => result.body as LeaveSummaryBody,
      );
      expect(
        summaries.filter((summary) => summary.newOwner === null),
      ).toHaveLength(1);
      expect(
        summaries.flatMap((summary) =>
          summary.newOwner ? [summary.newOwner.profileId] : [],
        ),
      ).toEqual([remaining.profileId]);
      const activeOwners = await prisma.profile.findMany({
        where: {
          companyId: owner.companyId,
          role: { code: 'OWNER' },
          status: 'ACTIVE',
          deletedAt: null,
        },
      });
      expect(activeOwners.map((profile) => profile.id)).toEqual([
        remaining.profileId,
      ]);
    });
  });

  describe('a lone owner leaves: the company closes', () => {
    let owner: OwnerSetup;
    let waiting: MemberSetup;
    let branchId: string;
    let latecomer: Session; // signed up, no company

    beforeAll(async () => {
      owner = await accounts.registerOwner(adminAccess, 5);
      branchId = await openBranch(owner.access, 'Branch 5');
      waiting = await accounts.pendingMember(owner.joinCode, 'waiting5');
      latecomer = await signUp(app, nextPhone, {
        email: 'late5@lv.test',
        password: 'password123',
      });
    });

    it('the preview says the company would close: nobody could take over', async () => {
      const preview = await previewOf(owner.access).expect(200);

      expect(preview.body).toEqual({
        companyWillClose: true,
        owner: { successorNeeded: true, candidates: [], defaultPick: null },
      });
    });

    it('leaving closes it: the company and its branches soft-deleted by the leaver, everyone DEACTIVATED', async () => {
      const left = await leave(owner.access).expect(200);

      expect(left.body).toEqual({ companyClosed: true, newOwner: null });
      const company = await prisma.company.findUniqueOrThrow({
        where: { id: owner.companyId },
      });
      expect(company.deletedAt).not.toBeNull();
      expect(company.deletedByProfileId).toBe(owner.profileId);
      const branch = await prisma.companyStore.findUniqueOrThrow({
        where: { id: branchId },
      });
      expect(branch.deletedAt).not.toBeNull();
      expect((await profileOf(owner.profileId)).status).toBe('DEACTIVATED');
      expect((await profileOf(waiting.profileId)).status).toBe('DEACTIVATED');
      const ownerRows = await historyOf(owner.profileId);
      expect(ownerRows[ownerRows.length - 1]).toMatchObject({
        reason: 'COMPANY_CLOSED',
        toRoleId: null,
        changedByProfileId: owner.profileId,
      });
    });

    it('its invite code no longer works (404)', async () => {
      await request(http)
        .post('/me/companies/join')
        .set(...auth(latecomer.accessToken))
        .send({ joinCode: owner.joinCode, name: 'late5' })
        .expect(404);
    });

    it('closing is final: its tax ID stays taken (409)', async () => {
      const refused = await request(http)
        .post('/me/companies')
        .set(...auth(latecomer.accessToken))
        .send({
          companyName: 'Leaving Co 5 again',
          taxId: taxIdOf(5),
          ownerName: 'Late Five',
        })
        .expect(409);
      expect(messageOf(refused)).toBe('Tax ID already registered');
    });
  });

  describe('an owner removes a member', () => {
    let owner: OwnerSetup;
    let coOwner: MemberSetup;
    let manager: MemberSetup;
    let park: MemberSetup;
    let waiting: MemberSetup;
    let branchId: string;

    beforeAll(async () => {
      owner = await accounts.registerOwner(adminAccess, 7);
      branchId = await openBranch(owner.access, 'Branch 7');
      coOwner = await accounts.pendingMember(owner.joinCode, 'co7', {
        contactEmail: true,
      });
      await request(http)
        .patch(`/profiles/${coOwner.profileId}/approve`)
        .set(...auth(owner.access))
        .send({ roleId: await roleIdOf('OWNER'), cornerId: null })
        .expect(200);
      manager = await accounts.registerJoinedMember(
        owner.access,
        owner.joinCode,
        'MANAGER',
        'lee7',
      );
      park = await accounts.registerJoinedMember(
        owner.access,
        owner.joinCode,
        'STAFF',
        'park7',
        { contactEmail: true },
      );
      await addBranch(owner.access, park.profileId, branchId).expect(201);
      waiting = await accounts.pendingMember(owner.joinCode, 'wait7');
    });

    it('a manager cannot remove anyone (403): only the owners hold profiles.remove', async () => {
      await removeMember(manager.access, park.profileId).expect(403);

      expect((await profileOf(park.profileId)).status).toBe('ACTIVE');
    });

    it('removing yourself is leaving, not removal (400)', async () => {
      const refused = await removeMember(owner.access, owner.profileId).expect(
        400,
      );

      expect(messageOf(refused)).toBe('To leave, use POST /profiles/me/leave');
    });

    it('an owner cannot remove a co-owner (403)', async () => {
      const refused = await removeMember(
        owner.access,
        coOwner.profileId,
      ).expect(403);

      expect(messageOf(refused)).toBe('Owners cannot remove an owner');
    });

    it('a waiting request is not removed (400)', async () => {
      const refused = await removeMember(
        owner.access,
        waiting.profileId,
      ).expect(400);

      expect(messageOf(refused)).toBe('Only active members can be removed');
    });

    it('a malformed id is 400 before any query', async () => {
      await removeMember(owner.access, 'not-a-uuid').expect(400);
    });

    it('removes staff: 204; DEACTIVATED, their branch ended by the owner, one REMOVED row by the owner', async () => {
      const removed = await removeMember(owner.access, park.profileId).expect(
        204,
      );

      expect(removed.body).toEqual({});
      expect((await profileOf(park.profileId)).status).toBe('DEACTIVATED');
      const assignment = await prisma.profileBranch.findFirstOrThrow({
        where: { profileId: park.profileId, companyStoreId: branchId },
      });
      expect(assignment.deletedAt).not.toBeNull();
      expect(assignment.deletedByProfileId).toBe(owner.profileId);
      const removedRows = (await historyOf(park.profileId)).filter(
        (row) => row.reason === 'REMOVED',
      );
      expect(removedRows).toHaveLength(1);
      expect(removedRows[0]).toMatchObject({
        fromRoleId: await roleIdOf('STAFF'),
        toRoleId: null,
        fromCompanyStoreId: branchId,
        toCompanyStoreId: null,
        changedByProfileId: owner.profileId,
      });
    });

    it('their old access token gets 401 at once (Review Focus 3)', async () => {
      await request(http)
        .get('/profiles')
        .set(...auth(park.access))
        .expect(401);
    });

    it('they are told, though DEACTIVATED; the co-owner hears it as a removal', async () => {
      await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            recipientProfileId: park.profileId,
            eventType: 'member.removed',
          },
        }),
      );
      await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            recipientProfileId: coOwner.profileId,
            eventType: 'member.left',
            body: {
              contains: 'park7님이 Leaving Co 7의 구성원에서 제외되었습니다.',
            },
          },
        }),
      );
    });

    it('the member list hides them', async () => {
      const list = await request(http)
        .get('/profiles')
        .set(...auth(owner.access))
        .expect(200);

      expect(
        (list.body as MemberBody[]).map((member) => member.id),
      ).not.toContain(park.profileId);
    });

    it('they can come back with the code: a new profile waits for approval', async () => {
      const refreshed = await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: park.refreshToken })
        .expect(201);
      const session = refreshed.body as {
        accessToken: string;
        refreshToken: string;
        profile: unknown;
      };
      expect(session.profile).toBeNull();

      const rejoined = await joinCompany(
        app,
        {
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
        },
        owner.joinCode,
        'park7',
      );

      expect(rejoined.profileId).not.toBe(park.profileId);
      expect((await profileOf(rejoined.profileId)).status).toBe(
        'PENDING_APPROVAL',
      );
    });
  });

  describe('the admin removes an owner', () => {
    let owner: OwnerSetup;
    let coOwner: MemberSetup;
    let adminProfileId: string;

    beforeAll(async () => {
      owner = await accounts.registerOwner(adminAccess, 8);
      coOwner = await accounts.pendingMember(owner.joinCode, 'co8');
      await request(http)
        .patch(`/profiles/${coOwner.profileId}/approve`)
        .set(...auth(owner.access))
        .send({ roleId: await roleIdOf('OWNER'), cornerId: null })
        .expect(200);
      adminProfileId = (
        await prisma.profile.findFirstOrThrow({
          where: { role: { code: 'ADMIN' }, deletedAt: null },
        })
      ).id;
    });

    it('removes one of two owners: 204, and the history says the admin did it', async () => {
      await removeMember(adminAccess, coOwner.profileId).expect(204);

      expect((await profileOf(coOwner.profileId)).status).toBe('DEACTIVATED');
      const removedRows = (await historyOf(coOwner.profileId)).filter(
        (row) => row.reason === 'REMOVED',
      );
      expect(removedRows).toHaveLength(1);
      expect(removedRows[0]).toMatchObject({
        fromRoleId: await roleIdOf('OWNER'),
        toRoleId: null,
        fromCompanyStoreId: null,
        changedByProfileId: adminProfileId,
      });
    });

    it('the last owner cannot be removed (409): nobody is picked, and the company stays open', async () => {
      const refused = await removeMember(adminAccess, owner.profileId).expect(
        409,
      );

      expect(messageOf(refused)).toBe('A company needs at least one owner');
      const ownerNow = await profileOf(owner.profileId);
      expect(ownerNow.status).toBe('ACTIVE');
      expect(ownerNow.role?.code).toBe('OWNER');
      const company = await prisma.company.findUniqueOrThrow({
        where: { id: owner.companyId },
      });
      expect(company.deletedAt).toBeNull();
    });
  });

  describe('deleting an account (Review Focus 4)', () => {
    // Han: staff in Company 9 and Company 10, signs in with a password and
    // Kakao, and has a phone registered for pushes.
    const hanEmail = 'han@lv.test';
    let ownerA: OwnerSetup;
    let ownerB: OwnerSetup;
    let han: Session; // Company 9 open
    let hanPhone: string;
    let hanAccountId: string;
    let hanInA: string;
    let hanInB: string;

    beforeAll(async () => {
      // A contact email, so Company 9's owner can be seen hearing of it.
      ownerA = await accounts.registerOwner(adminAccess, 9, {
        contactEmail: true,
      });
      ownerB = await accounts.registerOwner(adminAccess, 10);

      hanPhone = nextPhone();
      const signedUp = await signUp(app, () => hanPhone, {
        email: hanEmail,
        password: 'password123',
      });
      hanInA = (await joinCompany(app, signedUp, ownerA.joinCode, 'han9'))
        .profileId;
      hanInB = (await joinCompany(app, signedUp, ownerB.joinCode, 'han10'))
        .profileId;
      await request(http)
        .patch(`/profiles/${hanInA}/approve`)
        .set(...auth(ownerA.access))
        .send({ roleId: await roleIdOf('STAFF'), cornerId: null })
        .expect(200);
      await request(http)
        .patch(`/profiles/${hanInB}/approve`)
        .set(...auth(ownerB.access))
        .send({ roleId: await roleIdOf('STAFF'), cornerId: null })
        .expect(200);
      han = await switchTo(app, signedUp, hanInA);
      hanAccountId = await accountIdOfPhone(hanPhone);

      vouchForKakao('kakao-han', 'e2e-lv-kakao-han');
      await linkKakao(han.accessToken, 'kakao-han').expect(201);
      await request(http)
        .post('/devices')
        .set(...auth(han.accessToken))
        .send({ token: 'e2e-lv-han-device', platform: 'ANDROID' })
        .expect(204);
    });

    it('the platform admin → 403: it runs the platform, and has no phone to prove', async () => {
      const refused = await deleteMe(adminAccess, 'no-phone-to-prove').expect(
        403,
      );

      expect(messageOf(refused)).toBe(
        'The platform admin cannot delete its account',
      );
    });

    it('a proof for another purpose (FIND_ID) → 400, nothing deleted', async () => {
      const findIdProof = await verifiedPhoneToken(app, hanPhone, 'FIND_ID');

      const refused = await deleteMe(han.accessToken, findIdProof).expect(400);

      expect(messageOf(refused)).toBe('Invalid or expired verification token');
      const account = await prisma.account.findUniqueOrThrow({
        where: { id: hanAccountId },
      });
      expect(account.deletedAt).toBeNull();
    });

    it("a DELETE_ACCOUNT proof of someone else's phone → 400, nothing deleted", async () => {
      const otherPhoneProof = await verifiedPhoneToken(
        app,
        nextPhone(),
        'DELETE_ACCOUNT',
      );

      await deleteMe(han.accessToken, otherPhoneProof).expect(400);

      const account = await prisma.account.findUniqueOrThrow({
        where: { id: hanAccountId },
      });
      expect(account.deletedAt).toBeNull();
      expect((await profileOf(hanInA)).status).toBe('ACTIVE');
    });

    it('deletes it: 204, and Han has left both companies, by their own hand', async () => {
      const proof = await verifiedPhoneToken(app, hanPhone, 'DELETE_ACCOUNT');

      await deleteMe(han.accessToken, proof).expect(204);

      const account = await prisma.account.findUniqueOrThrow({
        where: { id: hanAccountId },
      });
      expect(account.deletedAt).not.toBeNull();
      expect(account.lastProfileId).toBeNull();
      for (const profileId of [hanInA, hanInB]) {
        expect((await profileOf(profileId)).status).toBe('DEACTIVATED');
        expect(await historyOf(profileId)).toContainEqual(
          expect.objectContaining({
            reason: 'ACCOUNT_DELETED',
            changedByProfileId: profileId,
          }),
        );
      }
    });

    it('both companies list Han only under ?status=DEACTIVATED', async () => {
      for (const [owner, profileId] of [
        [ownerA, hanInA],
        [ownerB, hanInB],
      ] as const) {
        const live = await request(http)
          .get('/profiles')
          .set(...auth(owner.access))
          .expect(200);
        const gone = await request(http)
          .get('/profiles?status=DEACTIVATED')
          .set(...auth(owner.access))
          .expect(200);

        expect(
          (live.body as MemberBody[]).map((member) => member.id),
        ).not.toContain(profileId);
        expect(
          (gone.body as MemberBody[]).map((member) => member.id),
        ).toContain(profileId);
      }
    });

    it("Company 9's owner hears that Han left", async () => {
      await waitFor(() =>
        prisma.notification.findFirst({
          where: {
            recipientProfileId: ownerA.profileId,
            eventType: 'member.left',
            body: { contains: 'han9님이 Leaving Co 9을(를) 떠났습니다.' },
          },
        }),
      );
    });

    it('every credential is gone: old access and refresh tokens, password login, login methods, devices', async () => {
      await request(http)
        .get('/me/companies')
        .set(...auth(han.accessToken))
        .expect(401);
      await request(http)
        .post('/auth/refresh')
        .send({ refreshToken: han.refreshToken })
        .expect(401);
      await request(http)
        .post('/auth/login')
        .send({ email: hanEmail, password: 'password123' })
        .expect(401);

      expect(
        await prisma.accountLoginMethod.count({
          where: { accountId: hanAccountId },
        }),
      ).toBe(0);
      expect(
        await prisma.refreshToken.count({
          where: { accountId: hanAccountId, revokedAt: null },
        }),
      ).toBe(0);
      expect(
        await prisma.deviceToken.count({ where: { accountId: hanAccountId } }),
      ).toBe(0);
    });

    it('Kakao is asked to forget us, after the commit', () => {
      expect(app.get(FakeSocialVerifier).disconnected).toContainEqual({
        provider: 'kakao',
        providerUserId: 'e2e-lv-kakao-han',
        refreshToken: null,
      });
    });

    it('the same phone and email sign up again, and the same Kakao identity links again', async () => {
      const again = await signUp(app, () => hanPhone, {
        email: hanEmail,
        password: 'password123',
      });

      await linkKakao(again.accessToken, 'kakao-han').expect(201);
      expect(await accountIdOfPhone(hanPhone)).not.toBe(hanAccountId);
    });
  });

  describe('a link racing the deletion (Review Focus 4)', () => {
    it('never leaves a login on the deleted account: whichever takes the account lock second waits, then sees the other', async () => {
      const yoonPhone = nextPhone();
      const yoon = await signUp(app, () => yoonPhone, {
        email: 'yoon@lv.test',
        password: 'password123',
      });
      const yoonAccountId = await accountIdOfPhone(yoonPhone);
      vouchForKakao('kakao-yoon', 'e2e-lv-kakao-yoon');
      const proof = await verifiedPhoneToken(app, yoonPhone, 'DELETE_ACCOUNT');

      const [deleted, linked] = await Promise.all([
        deleteMe(yoon.accessToken, proof),
        linkKakao(yoon.accessToken, 'kakao-yoon'),
      ]);

      expect(deleted.status).toBe(204);
      // linked first (then deleted with the rest), or refused as deleted
      expect([201, 401]).toContain(linked.status);
      expect(
        await prisma.accountLoginMethod.count({
          where: { accountId: yoonAccountId },
        }),
      ).toBe(0);
      expect(
        await prisma.accountLoginMethod.count({
          where: { method: 'kakao', providerUserId: 'e2e-lv-kakao-yoon' },
        }),
      ).toBe(0);
    });
  });

  it('the platform admin has no company to leave (403)', async () => {
    const refused = await leave(adminAccess).expect(403);

    expect(messageOf(refused)).toBe(
      'The platform admin has no company to leave',
    );
  });
});
