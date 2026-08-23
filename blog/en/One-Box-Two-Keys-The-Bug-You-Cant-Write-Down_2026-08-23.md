# One Box, Two Keys: The Bug You Can't Write Down

> Inventra, between Phase 6 and Phase 7 — a detour into the composite foreign key that makes cross-corner corruption unrepresentable, not merely forbidden.
> 2026-08-23

## Intro

Inventra is a multi-tenant inventory SaaS built on the Korean concession model — companies run "corners" inside physical stores. Phase 6 finished the inventory ledger; Phase 7 is restock orders. Reading my own Phase 7 spec, I hit a line I had written but not actually understood:

> `Order` PK is composite `[id, companyStoreId]`; `OrderItem`'s composite FK `[companyStoreProductId, companyStoreId]` to the placement enforces **same-corner integrity** at the database level.

I could see the constraint in `schema.prisma`. I could not have explained *why it works* to anyone. So before writing a line of Phase 7, I stopped and took the whole thing apart — and rebuilt it in a throwaway SQLite database until it broke and un-broke in front of me. This post is that detour.

## The bug we're trying to make impossible

Two corners, both belonging to the same company:

| id | company_id | name |
|---|---|---|
| `corner-gangnam` | comp-1 | Gangnam Nike corner |
| `corner-busan` | comp-1 | Busan Nike corner |

Note the shape of the danger: **same company, two corners.** A plain `companyId` tenant check waves both of these through. Corner separation is a *stricter* rule than tenant separation, and nothing I'd built so far enforced it.

Now the same product placed on both corners:

| id | company_store_id | product |
|---|---|---|
| `101` | `corner-gangnam` | Air Max |
| `202` | `corner-busan` | Air Max |

And one restock order that belongs to Gangnam. The row that must never exist is an order line joining **Gangnam's order** to **Busan's placement `202`** — Gangnam's paperwork moving Busan's stock. Silent, cross-corner, and invisible in any single-table view.

## Architectural Decisions

### 1. Structural enforcement over procedural enforcement

**Goal.** Guarantee that an order line's order and its placement live on the same corner.

**Options.**
- **(a) Service-layer check.** Before inserting a line, fetch the placement and compare `companyStoreId` to the order's. The fetch-then-decide pattern already used everywhere else in Inventra.
- **(b) A `CHECK` constraint or trigger.** Push the comparison into the database as procedural logic.
- **(c) A composite foreign key** that makes the mismatched row structurally impossible to express.

**Choice.** **(c)**, with (a) still present as the 404-shaped API behaviour.

**Reason.** I wanted to see how badly (a) fails on its own, so I built the naive version for real. `orders` with a plain `id` primary key, `order_items` with two ordinary one-column foreign keys, and then the bad insert:

```sql
INSERT INTO order_items VALUES ('order-sept', 202, 30);
-- ACCEPTED
```

```
order_id    order_corner    placement  placement_corner
----------  --------------  ---------  ----------------
order-sept  corner-gangnam  202        corner-busan
```

The database was delighted. Both foreign keys had passed — *independently*. FK1 asked "is `order-sept` a real order?" (yes). FK2 asked "is `202` a real placement?" (yes). **Neither one was ever in a position to compare the other's answer.** That's the whole failure mode: two correct checks that never meet.

Which means under design (a), the only thing standing between me and that row is remembering to write a guard in every code path that ever creates an order line — today, and in every feature I add for the next two years. Option (b) is better but still logic I have to author and keep correct.

**Result.** With the composite FK, the bad row isn't rejected by a rule. There's nowhere to *put* it. More on that below, and it's the part that took me three tries to actually see.

### 2. One column, read by two foreign keys

**Goal.** Make the two lookups compare notes without writing any comparison.

**The move.** Add `company_store_id` to `order_items`, and widen both FKs to span two columns — with the **same** corner column in both:

```sql
CREATE TABLE order_items (
  order_id                 UUID    NOT NULL,
  company_store_id         UUID    NOT NULL,   -- one box
  company_store_product_id INTEGER NOT NULL,
  product_order_quantity   INTEGER NOT NULL,
  PRIMARY KEY (order_id, company_store_id, company_store_product_id),
  FOREIGN KEY (order_id, company_store_id)
    REFERENCES orders(id, company_store_id),
  FOREIGN KEY (company_store_product_id, company_store_id)
    REFERENCES company_store_products(id, company_store_id)
);
```

**The thing I had wrong.** I assumed a two-column foreign key meant two checks — *"column 1 must exist over there, and column 2 must exist over there."* It doesn't. It's **one** check on the pair: *"these two values, side by side, must appear together on a single row."*

The cleanest way to internalize it: stop reading a composite key as two columns and read it as **one value with a separator in it.** The database now recognises exactly these keys:

```
placements:  "101|corner-gangnam"      orders:  "order-sept|corner-gangnam"
             "202|corner-busan"
```

A foreign key check is then the ordinary thing it always was — take my key, find it in your list.

**Reason it works.** The row has **one** `company_store_id` box, and both lookups build their key out of it. So try writing the bad line. You want `order-sept` + placement `202`; you must fill the corner box; there are exactly two candidate values:

| attempt | box | FK1 looks for | FK2 looks for | verdict |
|---|---|---|---|---|
| A | `corner-gangnam` | `order-sept\|corner-gangnam` ✓ | `202\|corner-gangnam` ✗ | **REJECTED** |
| B | `corner-busan` | `order-sept\|corner-busan` ✗ | `202\|corner-busan` ✓ | **REJECTED** |

Both ran; both bounced. And there is no attempt C — satisfying both would require the box to hold `corner-gangnam` and `corner-busan` simultaneously.

**Result.** The invariant reads: *the box says "this line's corner"; FK1 forces it to equal the order's corner; FK2 forces it to equal the placement's corner; therefore they're equal.* Nothing compared them. They were both compared to the same box. Same construction, verbatim, in `inventory_audit_items` and `purchase_reservations`.

A bonus fell out of the child's primary key, `(order_id, company_store_id, company_store_product_id)`: **a placement can appear at most once per order.** No duplicate lines for the same product, for free.

### 3. Two different ways to become "corner-addressable"

**Goal.** Both parents need to be lookup-able by the pair, since that's what the composite FK requires.

**The constraint behind the constraint.** A foreign key can only target columns backed by a unique constraint — the database needs an index to look *into*. I proved this to myself by deleting the index and inserting a perfectly valid row:

```
Error: foreign key mismatch - "order_items" referencing "company_store_products"
```

Not a data error. The **foreign key itself** was unusable.

**Options.** (a) Promote the pair to the primary key; (b) keep the simple PK and add a unique index on the pair.

**Choice.** Both — different tables, different answers, and the asymmetry is forced rather than sloppy:

| table | mechanism | why |
|---|---|---|
| `orders`, `inventory_audits` | `PRIMARY KEY (id, company_store_id)` | nothing references them by `id` alone, so they're free to do the stronger thing |
| `company_store_products` | `UNIQUE (id, company_store_id)` | `inventory_transactions` and `company_store_product_stocks` reference it by `id` alone — that must stay a key |

**Reason.** I tried the "consistent" version, giving placements a composite PK too. Both single-column children broke instantly on valid data:

```
Error: foreign key mismatch - "company_store_product_stocks" referencing "company_store_products"
Error: foreign key mismatch - "inventory_transactions" referencing "company_store_products"
```

The fix would be adding `UNIQUE(id)` back — which trades one redundant index for another, pointing the other way, and makes every placement `findUnique` become `where: { id_companyStoreId: { … } }` in the Prisma client. Strictly worse.

**Result.** `UQ_csp_id_company_store` looks pointless — `id` is already the PK, so the pair is unique for free — and that's exactly right: **it constrains no data.** It exists solely to make placements addressable by corner. It's a permission slip, not a rule. Meanwhile going composite-PK on `orders` is a modelling statement: an order *is* identified by corner + id, and nobody can later write a single-column FK to `orders(id)`, because there's nothing to point at.

### 4. Knowing where the pattern stops

**Goal.** Apply this everywhere it earns its keep — and nowhere else.

**The judgment call.** `inventory_transactions` doesn't get the treatment. It has a plain single-column FK to the placement and no `company_store_id` at all.

**Reason.** The mismatch bug requires **two** references that can disagree. A transaction points at exactly one thing — a placement — and a placement has exactly one corner, permanently. With one reference there's nothing to cross-check, and storing the corner again would be denormalization with no invariant to buy.

Except: `sourceType` + `sourceId` *are* a second reference, pointing at an order or an audit. But they carry **no foreign key at all**, because one column can't reference two different tables. Nothing in the database stops a transaction on Gangnam's placement from carrying a Busan order's `sourceId`. That gap is covered in the service layer instead:

```ts
await this.corners.assertWorksCorner(caller, cornerId);
const placement = await this.prisma.companyStoreProduct.findFirst({
  where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
});
if (!placement) throw new NotFoundException('Placement not found');
```

That second query asks in TypeScript exactly what the composite FK asks in SQL.

**Result.** Two honest tiers, and knowing which one you're standing on:

| tier | where | fails how |
|---|---|---|
| **structural** | `order_items`, `inventory_audit_items`, `purchase_reservations` | Postgres rejects the insert — no code involved, unbypassable |
| **procedural** | `inventory_transactions`, the polymorphic `sourceId` | 404 from the service — only as good as the code path |

The lesson I'm taking into Phase 7: reach for tier one whenever the rule is expressible as "these two references must agree," and be explicit — in the spec — when you're settling for tier two.

## TIL (Today I Learned)

**Does a composite foreign key check each column separately, or the pair together?**
Together, on one row — and this was *the* misunderstanding underneath everything else. I designed a test row that separates the two interpretations: a `locations(country, city)` table containing `KR|Seoul`, `KR|Busan`, `US|Boston`, `JP|Tokyo`, and a child row of `('JP','Busan')`. `JP` exists. `Busan` exists. The pair does not.

```
jp_appears_somewhere  busan_appears_somewhere  pair_exists_on_one_row
--------------------  -----------------------  ----------------------
         1                       1                        0
```

The insert was **rejected**. The first two columns are true, so the FK wasn't reading those — it was reading the third. If the "separate checks" reading were right, that row would be sitting in the table. It isn't. Once I saw a composite key as *one glued value*, everything downstream became obvious rather than clever.

**Why does `UQ_csp_id_company_store` exist when `id` is already the primary key?**
Because `(id, companyStoreId)` being unique isn't the point — being **indexed** is. A foreign key needs something to look into. Drop the index and the FK isn't merely weaker, it's rejected outright (Postgres at `CREATE TABLE`, SQLite when you first use it). The index adds zero guarantees about my data and is still load-bearing.

**Do I need a composite PK on `CompanyStoreProduct` too, like `Order` has?**
No. A primary key is just a unique constraint that's been designated as the row's identity; for FK targeting, Postgres accepts either. `orders` can afford the composite PK because nothing references it by `id` alone. `company_store_products` can't, because `inventory_transactions` and `company_store_product_stocks` do. Same capability — *"look me up by (id, corner)"* — reached two ways, for a real reason each time.

**Why doesn't a `companyId` check already cover this?**
Because both corners belong to the same company. Every tenant-scoping check I'd written would pass this row. Corner-level integrity is a strictly finer boundary than tenant-level, and it needed its own mechanism.

**Why did it take me four explanations to get it?**
Because I kept nodding at the *conclusion* ("so they must be on the same corner") while quietly holding a wrong model of the *primitive* (what a two-column FK checks). No amount of walking through the conclusion fixes a broken primitive. What finally worked was building an executable model — three throwaway SQLite databases, one naive, one real, one deliberately broken — and predicting each insert before running it. Being wrong out loud, against a real engine, located the gap in about ninety seconds.

## Concepts & Tools

| thing | why it showed up |
|---|---|
| **Composite primary key** — Prisma `@@id([id, companyStoreId])` | makes the corner part of an order's identity, so children must restate it |
| **Composite unique index** — Prisma `@@unique([...], map: "UQ_csp_id_company_store")` | gives placements a second, corner-inclusive way to be addressed, without disturbing the `SERIAL` PK |
| **Multi-field relations** — `@relation(fields: [a, b], references: [x, y])` | how Prisma expresses a two-column FK; the shared column across two relations is the whole trick |
| **FK target rule** (target must be unique-indexed) | the reason the "redundant" index is load-bearing rather than decorative |
| **`prisma migrate` generated SQL** | the raw `ALTER TABLE … ADD CONSTRAINT` is far more legible than the Prisma DSL for this pattern — reading `migration.sql` is what made the shared column visible |
| **SQLite as a scratch lab** | Postgres semantics are close enough here, and a disposable `.db` file made the difference between believing an explanation and testing one |
| **`OwnershipService` / fetch-then-decide** (NestJS) | the procedural tier that covers what no FK can express — the polymorphic `sourceId` |
| **`PrismaService` + `$transaction`** (NestJS) | where the structural guarantee meets the write path in Phase 6's ledger |

## Wrap-up

No feature shipped in this detour. What shipped is that I can now read my own schema. `orders_pkey`, `UQ_csp_id_company_store`, and those four-column `order_items` foreign keys stopped being ceremony I'd copied and became a single idea I could re-derive: **put the discriminator in the key, then let two lookups share one column, and the class of bug where a tenant filter goes missing simply cannot be written down.**

The cost is honest — an extra UUID column on every child table, and every insert has to thread `companyStoreId` through. The benefit is that it costs *nothing at runtime* and can't be forgotten, which is more than I can say for any guard I write by hand.

Next up: **Phase 7 — restock orders.** `orders`, `order_items`, draft-and-confirm, and the moment a confirmed order hands off to the Phase 6 ledger to actually move stock. The constraint I just spent a day understanding is the one holding that whole phase upright.
