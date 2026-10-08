# The Text Message We Never Sent

> I set out to build "email, SMS and push notifications." I ended up with a queue that never loses a message, phone verification that never sends a text, and a lesson about error codes that only showed up in `node_modules`.

*2026-10-06*

## Intro

[Inventra](https://github.com/develoHAM/inventra_backend) is a multi-tenant inventory SaaS built on **NestJS 11 + Prisma 7 + PostgreSQL**, modeled on the Korean concession-store world: companies run "corners" inside department stores, and owners, managers and staff keep stock in sync.

This track was the biggest so far. It ran across **five slices in two weeks**:
1. a notification pipeline (events → queue → worker → email)
2. eight business events wired into it
3. phone verification at signup
4. find-my-ID and password reset
5. push notifications to Android, iOS and the web

Along the way, the SMS half of the plan turned into something I hadn't expected. The unit suite went from 233 to **514** tests, and e2e from 87 to **140**.

## Architectural Decisions

### 1. Business code emits events; a queue does the sending

**The goal:** let any service say "an order was created" without knowing about email, SMS or push, and never lose a notification when a mail server is down.

**The options:**
- Call the mailer directly inside each service.
- Emit an in-process event, and have a listener send the email inline.
- Emit an event; the listener writes a `Notification` row and enqueues a **BullMQ** job; a worker sends it with retries.

**The choice:** events plus a queue.

**The reason:**
- **Sending inline makes the user's request wait for SMTP.** A slow or dead mail server would slow down or fail order creation, which has nothing to do with email.
- **A queue gives retries with backoff,** and the `Notification` row is a durable record of every message: PENDING → SENT / FAILED, with `attempts` and `lastError`.

**The result:** `OrdersService` only calls `eventEmitter.emit('order.created', { … })`. A `NotificationsListener` turns that into rows, and a `WorkerHost` delivers them. Adding push later didn't touch a single business service.

### 2. Emit after commit: return reports, don't emit from inside the transaction

**The goal:** never announce something that didn't happen, such as a "stock below target" alert from a transaction that later rolled back.

**The options:** emit from inside `recordWithinTransaction`; emit from a Prisma middleware; or have transactional code **return** what changed and emit after `$transaction` resolves.

**The choice:** return and collect. `recordWithinTransaction` returns `{ ledgerEntry, stockChange }`; callers collect the changes and call `emitStockAlerts(changes)` only after the transaction commits.

**The reason:** with this design, a rollback simply never reaches the emit line. It also let me fix a subtle false alarm. Fulfilling a reservation is a RELEASE (+q) followed by a SALE (−q), and judging each write separately could see a dip that never really happened. So alerts are judged **per placement, from the first "before" to the last "after"**, and fire only on the **crossing** below target.

**The result:** exactly one alert when stock crosses below target, and none for later sales or rolled-back writes.

### 3. A cron job that rescues stuck rows, made safe by `jobId`

**The goal:** if Redis restarts between "row written" and "job enqueued", the message must still go out.

**The choice:** every job uses `jobId = notification.id`, and a `@Cron(EVERY_5_MINUTES)` reconciler re-enqueues `PENDING` rows older than 10 minutes.

**The reason:** BullMQ ignores an `add()` whose `jobId` already exists. So re-enqueueing is **idempotent**: if the job is still in the queue, nothing happens; if it was lost, it's recreated.

**The result:** at-least-once delivery without duplicates, in about 30 lines.

### 4. The pivot: phone verification where the user texts *us*

**The goal:** require a verified, unique phone at signup.

**The options:**
- A classic outbound SMS code (we send a code, the user types it in).
- **OCTOMO reverse SMS (MO):** we *show* a code, the user texts it from their phone to `1666-3538`, and we ask OCTOMO's API whether it arrived.

**The choice:** OCTOMO, decided halfway through planning, after I'd already designed the outbound version.

**The reason:**
- **The carrier proves the sender.** If a text containing the code arrives *from* 010-1234-5678, the person holding the code controls that phone.
- **So the code isn't a secret:** it's shown on screen, and there's nothing to hash and nothing to guess.
- **It's free,** and needs no outbound provider, sender-number registration or delivery failures.

The outbound design I'd drafted needed a "redacted" queue job, so that the code wasn't stored in the database but still reached the worker. All of that disappeared.

**The result:** `POST /auth/phone/start` returns `{ verificationId, code, receiverNumber }`, and `POST /auth/phone/confirm` asks a `PhoneOwnershipVerifier`, which is OCTOMO in production and a fake in e2e. Success yields a **single-use, 10-minute token** that signup consumes inside its transaction.

### 5. Race-proof limits with conditional `updateMany`

**The goal:**
- at most 10 OCTOMO checks per verification (each one costs quota)
- exactly one token per verification
- each token spent exactly once

**The options:** read the counter, decide in JavaScript, then write; or put the condition **in the write**.

**The choice:** conditional writes, such as `updateMany({ where: { id, checkAttempts: { lt: 10 } }, data: { checkAttempts: { increment: 1 } } })`, followed by reading `count`.

**The reason:** I ran a simulation of 25 simultaneous confirms against a read-then-write counter. **All 25 got through, and the counter ended at 2:** every request read the same stale value and overwrote the others. With the condition inside one `UPDATE`, Postgres locks the row, and the 11th request finds nothing to update.

**The result:** three rules (check cap, single token, single spend) enforced with one pattern and no explicit locks.

### 6. Spend the token before revealing anything

**The goal:** stop strangers from probing join codes, phone numbers or emails for free.

**The problem:** member signup looked up the join code *before* checking the phone token. A 404 meant "no such code", and anything else meant "this code exists", so guessing cost nothing.

**The choice:** every flow spends its verification token **first**, inside the transaction. A "no match" outcome **returns** from the transaction, which commits it, so the token stays spent. The 404/400 is thrown only after that.

**The reason:** an error thrown *inside* `$transaction` rolls back the token consumption too, which would let one verified phone probe forever. Returning instead of throwing is the difference between commit and rollback.

**The result:** each probe costs a real SMS from a real phone (with a cap of 10 a day). A genuine failure, like an email-uniqueness race, still rolls back, so honest users keep their token.

### 7. Join codes people can actually type

**The goal:** owners had no way to *see* their company's join code (the e2e suites read it from the database).

**The choice:**
- `GET /companies/me/join-code` (owner + manager) and `POST …/rotate` (owner only)
- 8-digit codes instead of `INV-3FA91C07B2DE`
- signup strips spaces and dashes

**The reason:** digits are easy to read aloud and handwrite. But 10⁸ codes means collisions are no longer "never", so `generateUniqueJoinCode` redraws when it hits a taken code, up to 5 times. `/me` routes take the company from the JWT, so reaching another tenant's code is impossible to even express.

### 8. Password reset needs two factors, and logs out every device

**The choice:** `email + verified phone + RESET_PASSWORD token`. In one transaction: spend the token, check both factors point to the same account, store the hash, and revoke every refresh token. Afterwards, email the owner "your password was changed".

**The reason:** a stolen phone alone isn't enough, because find-ID only ever shows `ow***@example.com`. Revoking sessions removes an attacker who was already logged in. The alert email reaches the real owner through the one channel the attacker didn't need. The password is hashed *before* the transaction, so the deliberately slow hash doesn't hold a database connection.

### 9. Push: one row per device, and dead tokens clean themselves up

**The goal:** every event as email **and** push, on Android, iOS and web.

**The choice:**
- A `DeviceToken` table, upserted by token. A re-registered token *moves* to the new user, which handles shared phones.
- One `Notification` row per device.
- A `PushSender` interface with FCM and fake implementations.
- An `EVENT_CHANNELS: Record<EventName, Channel[]>` table, which makes every event's channels a compile-time requirement.

**The reason:** per-device rows mean each device retries or fails on its own. When FCM says a token is dead, the worker throws a `DeadDeviceTokenError`, deletes that device, marks the row FAILED and **doesn't retry**, while the user's other devices are unaffected.

**The result:** built and fully tested against a fake. Going live is two environment variables and a service-account key.

## TIL (Today I Learned)

**"Why BullMQ, when Nest has events already?"**
Events are in-memory and fire-and-forget: if the process dies, they're gone, and there's no retry. A queue persists the work in Redis and retries it. Events decouple *who announces*; the queue guarantees *the delivery happens*.

**"I didn't get the trap."** (about storing a redacted OTP)
The worker sends whatever text is in the database row. If the row must say `******`, the real code has to travel some other way, such as inside the job. Then anything that rebuilds a job *from the row alone* (my reconciler) would text users `******`. I only understood it once I walked through the row, the job and the phone, value by value. In the end OCTOMO made the whole problem disappear.

**"What exactly is `superRefine` vs `refine`?"**
`refine` returns true/false and reports one fixed message. `superRefine` receives the parsed object and calls `context.addIssue()` as many times as needed, each issue with its own path. And neither runs if a field already failed its own rule, so inside them every field is guaranteed valid.

**"`inject: [A, B, C]`: is that passed to `useFactory` in order?"**
Yes, strictly by position, never by name or type. If you swap the array but not the parameters, the parameter named `octomo` silently receives the fake.

**"What are `AbortController` and `AbortSignal`?"**
A promise has no cancel button. A controller is the remote control (`abort()`); its signal is the receiver you hand to `fetch`. `AbortSignal.timeout(5000)` is a signal that presses its own button. A surprise from a live demo: `fetch` rejects with **`signal.reason`**, so `abort('some string')` rejects with a plain string that has no `.name`.

**"Do we really have to throw HTTP errors from the service layer?"**
No. Domain errors plus an exception filter keep services HTTP-free. But every one of my 14 services throws Nest HTTP exceptions directly, and nothing but HTTP calls them. The time to switch is when a queue worker or cron job needs to call such a service.

**"If `token` is unique, won't re-registering a phone for user B violate the constraint?"**
No. The upsert finds the existing row and *updates its `userId`*. There's still exactly one row with that token. The constraint only fires on an *insert* of a duplicate, and `upsert` exists to avoid that.

**"Does FCM give each device a fixed token forever?"**
No. A token belongs to one app *install*, and it changes on reinstall, cleared data, restore to a new phone, occasional refreshes, or ~270 days of inactivity. That's why the app re-registers on every launch and the server deletes tokens FCM reports as dead.

**"Why do the dead-token codes start with `messaging/`? The docs don't show that."**
This was the best question of the track. The SDK's `MessagingErrorCode` enum is `'registration-token-not-registered'`, but at runtime `error.code` is `'messaging/registration-token-not-registered'`: the error's constructor adds the prefix. Comparing with `===` against the enum would **silently never match**, and dead tokens would be retried forever. The SDK's own `error.hasCode(code)` accepts both forms.

**"Did you use Context7 to check this?"**
Partly. Context7 gave me the API shape, but the prefixed code came from memory. What actually settled it was reading `node_modules/firebase-admin/lib/messaging/error.js` and running it. The lesson I'm keeping: **docs describe a version; `node_modules` *is* your version.**

## NestJS Concepts & Libraries

| Concept / library | Why we used it |
|---|---|
| `@nestjs/event-emitter` (`@OnEvent`) | decouple "something happened" from "who gets told" |
| `@nestjs/bullmq` (`WorkerHost`, `@InjectQueue`) | durable delivery with retries, backoff and `jobId` idempotency |
| `@nestjs/schedule` (`@Cron`) | the reconciler that rescues stuck PENDING rows |
| nodemailer + Mailpit | SMTP email; Mailpit catches it in dev/e2e with an API to assert on |
| OCTOMO API (`fetch` + `AbortSignal.timeout`) | free reverse-SMS phone verification |
| firebase-admin (FCM) | push to Android, iOS and web through one API |
| Injection tokens + `useFactory` | pick OCTOMO vs fake and FCM vs fake per environment |
| Zod `superRefine` | cross-field env rules (e.g. `fcm` needs a key path; prod refuses fakes) |
| Prisma conditional `updateMany` / `upsert` | race-free caps, single-use tokens, device reassignment |
| `Prisma.TransactionClient` | let `consume()` join the caller's transaction |
| `@Transform` + `@Matches` | normalize `010-1234-5678` → `01012345678` before validating |
| `Record<Union, T>` | an exhaustive event→channel table enforced by the compiler |

## Wrap-up

The track delivered:
- **email for every business event**, sent after commit and through a queue that rescues itself
- **OCTOMO phone verification** at signup
- **find-my-ID and password reset** that each cost a real verification
- **visible, rotatable 8-digit join codes**
- **push notifications** with per-device delivery and dead-token cleanup

The best moments were the ones where a question changed the design: "make all notifications go through a queue" exposed the redaction trap, and "why the `messaging/` prefix?" caught a bug no test of mine would have.

**Deferred on purpose:**
- reservation SMS to customers, which needs an outbound provider
- pruning stale devices by `lastSeenAt`
- deep-link data in pushes

Next up, I'll decide between performance work (only where measured) and a new feature track.
