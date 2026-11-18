# One Phone, Two Name Tags

> Letting one person work for two companies sounded like adding a table. It took three migrations, a token redesign, a brake on guessing invite codes, a lock you take by writing, and retiring the two endpoints every test depended on.

*2026-11-19*

## Intro

[Inventra](https://github.com/develoHAM/inventra_backend) is a multi-tenant inventory SaaS built on **NestJS 11 + Prisma 7 + PostgreSQL**, modeled on the Korean concession-store world: companies run branches ("corners") inside department stores, and owners, managers and staff keep the stock in sync.

This track is **piece 2 of 3 of the membership overhaul: one sign-in, many companies.** Until now a phone number belonged to exactly one company. A part-timer who works the weekday shift for one brand and the weekend shift for another needed two accounts, two passwords and two apps. Now a person signs up once, joins or creates companies from inside the app, and switches between them like Slack workspaces. They have a different name, photo and contact email in each company, and one phone gets every company's notifications, each tagged with where it came from.

It ran **eight days**: 7 tasks, a rename task in the middle, and one follow-up I asked for at the end. The unit suite went from 1069 to **1238** tests, and the end-to-end suites from 227 to **271** across 17 suites. The last run passed first time, even though all 16 existing suites had been rewritten.

## Architectural Decisions

### 1. Split "who you are" from "who you are at work"

**The goal:** one person, one sign-in (phone, passwords, Kakao or Apple logins, sessions, devices), and **a separate profile in each company** (name, photo, contact email, role, branch, status).

**The options:**
- Keep the `users` table and add a `memberships` join table between users and companies.
- Build two brand-new tables and move everything into them.
- **Create a new `accounts` table for the sign-in, and keep `users` as the per-company profile.**

**The choice:** the third. The sign-in moved out to `accounts`, and the old `users` row stayed exactly where it was, becoming the profile.

**The reason:** every company-side relation (orders, audits, stock movements, history, notifications) points at the *person in the company*, not at the login. Leaving those rows in place meant none of those foreign keys moved. And because every migrated account **reuses its user's id** (`accounts.id = users.id`), the data step was plain copies, with no lookups and no mapping table:

```
expand   → create accounts; add nullable account_id columns
copy     → INSERT INTO accounts SELECT id, phone … FROM users; repoint logins, sessions, devices
contract → NOT NULL, drop the old columns and foreign keys
```

**The result:** Task 1 changed no behaviour at all, which was the point. The existing 227 e2e tests passed unchanged, and existing users kept their passwords, Kakao and Apple links, and devices.

### 2. Names are documentation, so the rename got its own migration (and I changed my mind once)

**The goal:** once the sign-in was split out, the `users` table *was* a company profile, but the code still called it `User`, `AuthUser`, `request.user`, `users.*` permissions…

**The options:** live with the old names; rename in code only (`@@map` to the old table); or **rename everything, database included.**

**The choice:** rename everything. The migration has 54 `RENAME`s (tables, an enum, columns, primary keys, foreign keys, indexes) plus one `UPDATE` for the permission codes, and moves no rows.

**The reason:** a model called `User` that is really "a person in one company" would mislead every future reader, me included. RENAMEs keep the data, the ids and every row as they were.

There's a confession in this one. I first chose **User** for the sign-in and **Profile** for the company side. Halfway through I realised "user" is exactly the word that means different things to different people, and switched the sign-in to **Account**. The first attempt went into a git stash; its migration had never been applied, so throwing it away was free. Now there's a vocabulary rule in the project guide: *no model is called "User"*.

**The result:** `Account` = the sign-in, `Profile` = the person in one company, and everything "recorded by" points at a profile. Every name now says what the thing is.

### 3. Tokens name the account and the open profile, and switching rotates the session

**The goal:** a token must say *who signed in* and *which company is open*, and a company switch must not need a password.

**The options:**
- One token per company, so the app juggles several sessions.
- A token listing every company the person belongs to.
- **One session per sign-in, with the open profile in the token.**

**The choice:**
```ts
access:  { sub: accountId, pid?: profileId, type: 'access' }   // no pid = no company open
refresh: { sub: accountId, jti, type: 'refresh' }               // its database row remembers the profile
```
`POST /auth/switch { refreshToken, profileId }` revokes the old refresh token and issues a new pair with the new profile.

**The reason:** a list in the token goes stale the moment someone is approved or leaves. Several sessions means several logouts. With one session that *remembers* which profile is open, refreshing keeps the company you were in, and switching is just one more rotation.

Two new guard rules came with it:
- a `pid` that isn't **this** account's profile is a 401 (a forged or stale token must never act as someone else);
- a token with no company open, on a route that needs one, is a **403 `Choose a company first`**. That's better than a 500 from a missing caller deep inside a service.

Routes that work without a company (`/auth/me`, `/devices`, the login methods) are marked `@AccountRoute()`, a metadata decorator the guard reads the same way it reads `@Public()`.

**The result:** after logging in, the app gets back the company dropdown and the profile to open (the last one switched to, or the newest). Switching costs one request and no password.

### 4. Signup makes only the sign-in

**The goal:** creating an account and joining a company had always been one request (`register`, `register/member`). With many companies per person, those are two separate acts.

**The choice:** `POST /auth/signup { phone, phoneVerificationToken, credentials }` creates the account and its first login method, and **nothing else**: no profile, no company. The response has `profile: null, companies: []`, and the app lands on a "join or create" screen.

One detail turned into a long lesson (see TIL). The credentials are a union, `{ type: 'password', … } | { type: 'social', … }`, and I wanted the tag to be **case-insensitive** (`'Social'`, `'PASSWORD'`). class-transformer's `discriminator` option can't do that: it matches exactly, and on the *raw* JSON, before any `@Transform` runs. So the class is picked by a `@Type` **type function** that lowercases a copy of the tag, and a small `@LowercaseTag()` stores it lowercase for `@Equals`.

**The result:** the first API path to a session with no company open. That finally let the "Choose a company first" 403 from decision 3 get its end-to-end test.

### 5. Joining: let the index decide, and brake the guessing

**The goal:** `POST /me/companies/join { joinCode, name }` creates a waiting profile. Joining twice must fail, even when two requests arrive at the same instant. And an 8-digit code (100 million combinations) must not be guessable.

**The choice:**
- **Duplicates:** no "already a member?" check first. The partial unique index decides:
  ```prisma
  @@unique([accountId, companyId], where: raw("((deleted_at IS NULL) AND (status <> 'DEACTIVATED'::profile_status))"))
  ```
  `createManyAndReturn({ skipDuplicates: true })` inserts, or returns `[]`, which means 409. Under concurrency, Postgres lets exactly one insert through.
- **Guessing:** every **wrong** code becomes a row in `company_join_attempts`. Five rows within the last hour (a *rolling* window, so there's no reset on the hour to wait for) gives 429. The count runs **before** the code is looked up, so a blocked account learns nothing, not even that its sixth guess was right. A right code leaves no row.

**The reason, and the trap:** the wrong guess's row has to **survive the 404**. Inside a transaction, the throw would roll the row back and the brake would never engage. So the lookup and the attempt row run **outside** any transaction, each statement committing on its own.

**The result:** two joins at once give one 201 and one 409. Five wrong codes give 404s, and the sixth try gives 429, even with the right code. Another account isn't affected. The index on the attempts table is `(account_id, created_at)` rather than `account_id` alone, so the count reads at most five index entries instead of an attacker's whole history (see TIL).

### 6. Creating a company: lock, then count

**The goal:** `POST /me/companies` creates a company and a waiting OWNER profile, with **at most one company waiting for approval per account** (my rule: it stops one account flooding the admin with registrations).

**The options:** a unique index can't express "at most one row that is waiting **and** has the OWNER role", because the role lives in another table. A plain count races: two creates at once both count 0, and both create.

**The choice:** lock by writing, then count:
```ts
await transaction.account.updateMany({ where: { id: accountId }, data: { updatedAt: new Date() } }); // takes the row lock
const waiting = await transaction.profile.count({ where: { accountId, status: 'PENDING_APPROVAL', role: { code: 'OWNER' } } });
```

**The reason:** an `UPDATE` holds a lock on that account's row until the transaction ends, so a second create waits on the same line. Under Postgres's default READ COMMITTED isolation, each statement sees everything committed before *it* started. So the waiting request's count runs after the first commit, sees one company, and answers 409. **The order is the point**: count first, and both would read 0. A unit test checks the lock comes before the count.

The rest is an old friend. The company row needs its creator and the profile needs its company, so the profile is inserted first with `companyId: null`. A taken tax ID is thrown **inside** the transaction, rolling the half-made owner profile back. Without that rollback, the orphan would make every later create return 409 forever.

**The result:** a double tap gives one 201 and one 409. Two different accounts lock different rows and run side by side.

### 7. A name and a contact email per company, the email proven by code

**The goal:** each company sees its own name and contact email for you, set by you and only for the company that's open.

**The choice:**
- `PATCH /profiles/me { name }` and `PUT /profiles/me/contact-email { email, emailVerificationToken }`.
- "Me" is the token's open profile, never an id from the client.
- No permission decorator, so a profile **still waiting for approval** can set its email, and the "you're approved" email has somewhere to go.

**The reason the email needs a proof:** with an unproven address, a typo silently drops every notification, a stranger's address leaks a company's notices, and a victim's address turns them into a spam cannon. The proof comes from the existing emailed-code flow. It's **bound to that address and single-use**, and it's spent in the same transaction as the write, so a bad proof writes nothing.

**One small defence:** Express matches routes in registration order, and `:id` matches the text `me` too. So `MyProfileController` is registered **before** the controller with the `/profiles/:id/...` routes, and a unit test reads the module's metadata to keep it that way.

**The result:** the part-timer can be "Lee" at one brand and "Lee Ji-eun" at the other, each with their own work email.

### 8. One phone, every company's pushes

**The goal:** a device belongs to the account, so a phone gets every company's pushes, whichever company is open. The lock screen has to say which company each one is about, and tapping one has to open the right company.

**The choice:** every push gets
```ts
title: `${company.name} · ${subject}`
data:  { ...eventData, profileId: recipient.id, ...(recipient.company ? { companyId } : {}) }
```
- **`profileId`** is there because `POST /auth/switch` takes a profile.
- The recipient's ids are spread **last**, so they win over an event key of the same name.
- The platform admin, who has no company, keeps the event's own title and data.

**The reason it costs nothing extra:** `notifyProfiles` already queried the recipients to find their devices. One relation select added the company:
```
loop, one company lookup per recipient:  1 + N queries   (5 recipients → 6)
select: { company: { select: … } }:      2 queries, whatever N is
```

**The result:** "Acme · 새 발주가 등록되었습니다" on the lock screen, and a tap that switches to Acme first.

### 9. The contract step: retiring the endpoints every test used

**The goal:** delete `POST /auth/register` and `/auth/register/member`. This was the *contract* of expand → migrate → contract, after five tasks of the old and new paths living side by side.

**Why delete instead of keep:** two paths mean every future rule gets built twice. And the old one quietly broke a rule the new one keeps: a password `register` copied the login email into the contact email, **unproven**. There's no production yet, so no deprecation period was needed.

**How:** delete the entry points and let `tsc` list every reference. Then *search* for what's now unused but doesn't error: two constructor dependencies of `AuthService`, a module import, a whole DTO class and a factory left building just one decorator.

**The surprise:** every e2e suite set up its owners and members through `register`, and **got contact emails for free** from that unproven copy. With the new flow, nobody has a contact email until they prove one, so every suite that asserted an email would have failed. The new shared helpers (`suiteAccounts(app, naming)`, a factory whose functions remember each suite's naming through a closure) take `{ contactEmail: true }`. That runs the **real** proof flow through Mailpit, *before* approval, the same order a real person follows. Writing the column directly would have been faster, and it would have skipped the very rule we'd just built.

**The result:** 16 suites rewritten. Nine of them were mechanical, because they'd all carried near-identical copies of the same two setup helpers, and those copies are now one shared file. Then a new **part-timer story** walks the whole design end to end:
1. join A, get approved, ask to join B (A keeps working);
2. B approves, and Park switches to B;
3. each company's token gets 404 on the other's members;
4. both approval pushes arrive on the same phone, each with its own `profileId`;
5. logging out ends both;
6. a company they left disappears from the dropdown.

All 267 tests passed on the first run.

### 10. The follow-up: prove the email *with* the join

**The goal:** with the old route gone, a newcomer needed five calls before the approval email could reach them. I asked for one: join or create *with* an already-proven address.

**The choice:** an optional pair, `contactEmail` + `emailVerificationToken`, **both or neither**, in one small base class that both DTOs extend:
```ts
const sendsEither = (dto) => dto.contactEmail !== undefined || dto.emailVerificationToken !== undefined;

@ValidateIf(sendsEither) @Transform(normalizeEmail) @IsEmail()      contactEmail?: string;
@ValidateIf(sendsEither) @IsString() @IsNotEmpty()                  emailVerificationToken?: string;
```
When the condition is false, every rule on the field is skipped. When either field is sent, both are checked, so half a pair is a 400 naming the missing field.

**The interesting part:** join had deliberately **no** transaction (decision 5). Now the proof and the profile must be written together. So the transaction starts **after** the code lookup: a wrong code's row still survives its 404, and the duplicate-join 409 is thrown *inside*, so a refused join doesn't waste the proof.

**The result:** approval emails arrive at the up-front address, and 271 e2e tests pass.

## TIL (Today I Learned)

**"Discriminator? It picks a class from `credentials.type`?"**
Yes. It's a lookup table you write in `@Type`'s options: `property: 'type'` plus `subTypes: [{ name: 'social', value: SocialDto }, …]`. class-transformer reads that key **from the raw JSON**, matches it **exactly** against the names, and falls back to the class your `@Type(() => …)` arrow returns if nothing matches. That's why `'Social'` quietly built the password class.

**"Why `keepDiscriminatorProperty: true`?"**
By default the label is deleted once the class is chosen. The library treats the object's class as the label: going back to JSON, it writes the label in again from the same table, read backwards. Our classes *declare* `type` and check it with `@Equals`, and the service branches on it, so we had to keep it.

**"What does `@Type` do, as a whole?"**
`ValidationPipe` runs two libraries. class-transformer **builds** (`plainToInstance`), then class-validator **checks** (`validate`). JSON has no classes, so for a nested object someone must decide which class it becomes, because the rules live on classes. `@Type` is that decision:
- `@Type(() => X)` always builds `X`; on an array, each element; for `Number` or `Date`, it converts;
- `@Type((options) => …)` is a function that decides, and it gets the whole parent JSON;
- `@Type(() => Fallback, { discriminator })` is a table with your class as the fallback.

`@ValidateNested()` then steps inside and runs that class's rules.

**"So we need `@Type`, not `@Transform`, to choose the class? What does `@Transform` do?"**
`@Transform` changes a **value** and runs **after** that field is built. `@Type`'s function runs **before** the build and returns a **class**. By the time any `@Transform` sees the credentials, the class is already chosen. The one that lowercases the tag even lives *on* the class being chosen.

**"What are `object`, `property` and `newObject` for our credentials?"**
- `object` is the whole raw request body (phone still dashed, tag still `'Social'`).
- `property` is `'credentials'`.
- `newObject` is the half-built DTO, holding only the fields finished so far, so it depends on the JSON's key order.

The picker reads `object[property].type` and ignores `newObject`.

**"Why three credentials DTOs?"**
Password works the same everywhere. Social needed two shapes: register created a profile, so it carried a proven contact email; signup creates none, so its class has only the ticket, and the whitelist refuses a stray `contactEmail` instead of silently ignoring it. After the contract step, only two are left.

**"Why index `(account_id, created_at)` and not just `account_id`?"**
An index is a sorted list. With `account_id` alone, Postgres finds the account's rows but must open every one to read its time, and the attempts table is never cleaned up. With time as the second column, it jumps to "an hour ago" and reads forward until the account changes: at most 5 entries. Equality columns go first, the range column last.

**"Explain `create()` with the whole context."**
That's decision 6. The question that made it click was what would go wrong without each step. Without the lock, a double tap makes two waiting companies. Without the throw inside the transaction, an orphan owner profile blocks every future create.

**"We don't return the role because the owner hasn't approved yet?"**
Two different things. `/profiles/me` never returns a role: it answers with exactly the fields it edits. In the dropdown, a **joined** profile's role is `null` until the approver picks one, but a company **creator** is OWNER straight away, because the admin's approval activates the company and doesn't change the role.

**"What's N+1, and what does a relation select solve?"**
One query for N rows, then one more for each row, gives 1 + N round trips, growing with N, usually hidden in a helper inside a loop. A relation select describes the shape you want. I'd said Prisma "joins it in the same query", and a query log proved me wrong. Its default is **two** queries: the parents, then every child at once with `WHERE id IN (…)`, attached in memory. The win is that the count stops growing, not the JOIN. (I also found a small N+1 already in the code, in the email half of `notifyProfiles`.)

**"Can the user be emailed when they're approved?"**
Yes, if the waiting profile sets a contact email first. Push needs nothing, because devices belong to the account. That question became the follow-up (decision 10).

**"Can't you just read my terminal?"**
No, but a file works: `npm run test:e2e 2>&1 | tee e2e.log`. I keep watching the output live, the log lands in a git-ignored file, and "done" is all I have to say.

## NestJS Concepts & Libraries

| Concept / library | Why we used it |
|---|---|
| `SetMetadata` + `Reflector.getAllAndOverride([handler, class])` | `@AccountRoute()` on a method or a whole controller |
| `createParamDecorator` | `@CurrentAccount()` and `@CurrentProfile()` read the guard's `request.account` / `request.profile` |
| Global `APP_GUARD` | one query per request: the profile and its account's `deletedAt`, or the account alone |
| Controller registration order (`@Module({ controllers })`) | `/profiles/me` registered before `/profiles/:id` |
| Module `imports` / `exports` and cycle checks | `AccountsModule` used by auth and social login, never the other way round |
| `@nestjs/event-emitter` | `member.joinRequested`, `company.registered`, emitted only after commit |
| class-transformer `@Type` (type function, `discriminator`, `keepDiscriminatorProperty`), `@Transform` | case-insensitive credential classes; normalized phones, emails and codes |
| class-validator `@ValidateNested`, `@Equals`, `@ValidateIf`, `@MaxLength` | nested credentials, the tag check, both-or-neither pairs, a 400 instead of a database 500 |
| DTO inheritance | `JoinCompanyDto` and `CreateCompanyDto` share one optional proven email |
| Prisma `createManyAndReturn({ skipDuplicates })` + partial unique index | duplicate joins decided by the database, the response selected from the insert |
| Prisma `updateMany` as a lock + READ COMMITTED | at most one waiting company per account |
| Prisma relation select (batched `IN` query) | the company name in every push without N+1 |
| Prisma `@@index([accountId, createdAt])` | a rolling-window count that stays cheap |
| `satisfies Prisma.ProfileSelect` + `ProfileGetPayload` | one select constant, one derived type |
| `prisma migrate dev --create-only` + hand-written SQL | expand → copy → contract with reused ids; a rename-only migration |
| JWT claims (`sub`, `pid`, `jti`) + refresh rotation | one session per sign-in that remembers its open profile |
| Mailpit + supertest | real emailed codes in the e2e; the approval email checked in the inbox |
| Jest `invocationCallOrder` | "lock before count", "spend before insert", "emit after commit" as tests |

## Wrap-up

The track delivered:
- **one sign-in per person** (`accounts`) and **a profile per company** (`profiles`), migrated with every existing user's logins and devices intact
- tokens that name the account and the open profile, **Slack-style switching**, and a clear 403 when no company is open
- **signup without a company**, then **join or create** from `/me/companies`, with a brake on guessing codes and at most one company waiting per account
- a **name and a code-proven contact email per company**, which can also be proven up front with the join or the create
- **pushes from every company** on one phone, each naming its company and the profile to open
- the old one-step `register` endpoints **retired**, with every e2e suite moved onto shared helpers and a part-timer story that walks it all

The lesson I'll keep: **the order of two lines is often the whole design.** Lock, then count. Look up the code, *then* open the transaction. Spend the proof, then insert, and throw the 409 inside. Each of those, written the other way round, still passes most tests, and the only one that notices is the test written to fail.

Next up: **piece 3, leaving.** Leaving a company (the profile becomes `DEACTIVATED` and frees its slot), deleting an account (and asking Apple to forget us, which it requires), and closing a company when its last owner leaves, which means picking a successor.
