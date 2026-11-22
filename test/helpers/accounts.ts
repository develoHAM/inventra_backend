import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { emailProof } from './email';
import { verifiedPhone } from './phone';

/**
 * Getting people into companies the way the app does it: sign up (an
 * account, no company) → create or join a company (a waiting profile) →
 * switch into it → approval. Every helper drives the real endpoints.
 */

/** What every sign-in step answers, as far as the tests need it. */
export type Session = { accessToken: string; refreshToken: string };

/** Nest types its HTTP server as `any`; supertest wants its own type. */
type HttpServer = Parameters<typeof request>[0];
const httpOf = (app: INestApplication) => app.getHttpServer() as HttpServer;

/** The fields of a session response the helpers read. */
type SessionBody = { accessToken: string; refreshToken: string };

const auth = (token: string): [string, string] => [
  'Authorization',
  `Bearer ${token}`,
];

/** POST /auth/signup with a password and a fresh verified phone. */
export async function signUp(
  app: INestApplication,
  nextPhone: () => string,
  credentials: { email: string; password: string },
): Promise<Session> {
  const { phone, token } = await verifiedPhone(app, nextPhone);
  const response = await request(httpOf(app))
    .post('/auth/signup')
    .send({
      phone: phone,
      phoneVerificationToken: token,
      credentials: { type: 'password', ...credentials },
    })
    .expect(201);
  const body = response.body as SessionBody;
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

/** POST /me/companies → a new company and its waiting OWNER profile. */
export async function createCompany(
  app: INestApplication,
  session: Session,
  body: { companyName: string; taxId: string; ownerName: string },
): Promise<{ profileId: string; companyId: string; joinCode: string }> {
  const response = await request(httpOf(app))
    .post('/me/companies')
    .set(...auth(session.accessToken))
    .send(body)
    .expect(201);
  const view = response.body as {
    profileId: string;
    company: { id: string };
  };
  const companyId = view.company.id;
  // no endpoint shows a waiting owner the code: read it from the database
  const company = await app
    .get(PrismaService)
    .company.findUniqueOrThrow({ where: { id: companyId } });
  return {
    profileId: view.profileId,
    companyId: companyId,
    joinCode: company.joinCode,
  };
}

/** POST /me/companies/join → a waiting profile, no role yet. */
export async function joinCompany(
  app: INestApplication,
  session: Session,
  joinCode: string,
  name: string,
): Promise<{ profileId: string }> {
  const response = await request(httpOf(app))
    .post('/me/companies/join')
    .set(...auth(session.accessToken))
    .send({ joinCode: joinCode, name: name })
    .expect(201);
  return { profileId: (response.body as { profileId: string }).profileId };
}

/** POST /auth/switch → a new session with that profile open. */
export async function switchTo(
  app: INestApplication,
  session: Session,
  profileId: string,
): Promise<Session> {
  const response = await request(httpOf(app))
    .post('/auth/switch')
    .set(...auth(session.accessToken))
    .send({ refreshToken: session.refreshToken, profileId: profileId })
    .expect(201);
  const body = response.body as SessionBody;
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

/**
 * Prove `address` with an emailed code, then make it the open profile's
 * contact email (where this company's notifications go). Needs Mailpit.
 */
export async function setContactEmail(
  app: INestApplication,
  session: Session,
  address: string,
): Promise<void> {
  const proof = await emailProof(app, address);
  await request(httpOf(app))
    .put('/profiles/me/contact-email')
    .set(...auth(session.accessToken))
    .send({ email: address, emailVerificationToken: proof })
    .expect(200);
}

/** How one suite names its people and companies (the database is shared). */
export interface SuiteNaming {
  nextPhone: () => string; // testPhones(<suite number>)
  emailDomain: string; // 'cat.test' → owner1@cat.test, staff@cat.test
  taxIdOf: (n: number) => string; // unique across suites
  companyNameOf: (n: number) => string;
  password?: string; // default 'password123'
}

/** { contactEmail: true } proves the login address and sets it, BEFORE approval. */
export interface PersonOptions {
  contactEmail?: boolean;
}

export interface OwnerSetup {
  access: string; // the owner's company is open in it
  refreshToken: string;
  profileId: string;
  companyId: string;
  joinCode: string;
  email: string; // the login email (and contact email, if set)
}

export interface MemberSetup {
  access: string; // the member's company is open in it
  refreshToken: string;
  profileId: string;
  email: string;
}

/**
 * The suite's helpers, bound to its naming (a factory: the returned
 * functions remember `naming` through a closure).
 */
export function suiteAccounts(app: INestApplication, naming: SuiteNaming) {
  const http = httpOf(app);
  const password = naming.password ?? 'password123';

  /** Company n, created and waiting for the admin; the owner has it open. */
  const pendingOwner = async (
    n: number,
    options: PersonOptions = {},
  ): Promise<OwnerSetup> => {
    const email = `owner${n}@${naming.emailDomain}`;
    const session = await signUp(app, naming.nextPhone, {
      email: email,
      password: password,
    });
    const created = await createCompany(app, session, {
      companyName: naming.companyNameOf(n),
      taxId: naming.taxIdOf(n),
      ownerName: `Owner ${n}`,
    });
    const opened = await switchTo(app, session, created.profileId);
    if (options.contactEmail) {
      await setContactEmail(app, opened, email);
    }
    return {
      access: opened.accessToken,
      refreshToken: opened.refreshToken,
      profileId: created.profileId,
      companyId: created.companyId,
      joinCode: created.joinCode,
      email: email,
    };
  };

  /** Company n, approved by the admin: an ACTIVE owner. */
  const registerOwner = async (
    adminAccess: string,
    n: number,
    options: PersonOptions = {},
  ): Promise<OwnerSetup> => {
    const owner = await pendingOwner(n, options);
    await request(http)
      .patch(`/companies/${owner.companyId}/approve`)
      .set(...auth(adminAccess))
      .expect(200);
    return owner;
  };

  /** `tag`@domain joins with the code and waits; the profile is open. */
  const pendingMember = async (
    joinCode: string,
    tag: string,
    options: PersonOptions = {},
  ): Promise<MemberSetup> => {
    const email = `${tag}@${naming.emailDomain}`;
    const session = await signUp(app, naming.nextPhone, {
      email: email,
      password: password,
    });
    const joined = await joinCompany(app, session, joinCode, tag);
    const opened = await switchTo(app, session, joined.profileId);
    if (options.contactEmail) {
      await setContactEmail(app, opened, email);
    }
    return {
      access: opened.accessToken,
      refreshToken: opened.refreshToken,
      profileId: joined.profileId,
      email: email,
    };
  };

  /**
   * `tag`@domain joins and the owner approves with `roleCode`, no branch:
   * an ACTIVE member. (The guard reads the profile on every request, so
   * the session opened while waiting works with the new role at once.)
   */
  const registerJoinedMember = async (
    ownerAccess: string,
    joinCode: string,
    roleCode: string,
    tag: string,
    options: PersonOptions = {},
  ): Promise<MemberSetup> => {
    const member = await pendingMember(joinCode, tag, options);
    const role = await app
      .get(PrismaService)
      .role.findUniqueOrThrow({ where: { code: roleCode } });
    await request(http)
      .patch(`/profiles/${member.profileId}/approve`)
      .set(...auth(ownerAccess))
      .send({ roleId: role.id, cornerId: null })
      .expect(200);
    return member;
  };

  return {
    pendingOwner: pendingOwner,
    registerOwner: registerOwner,
    pendingMember: pendingMember,
    registerJoinedMember: registerJoinedMember,
  };
}
