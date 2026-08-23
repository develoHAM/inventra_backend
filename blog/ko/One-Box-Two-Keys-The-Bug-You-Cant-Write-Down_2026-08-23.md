# 하나의 칸, 두 개의 키: 애초에 적을 수 없는 버그

> Inventra, Phase 6과 Phase 7 사이 — 코너 간 데이터 오염을 "금지"하는 게 아니라 "표현 자체를 불가능"하게 만드는 composite foreign key로의 우회.
> 2026-08-23

## 들어가며

Inventra는 한국의 편집숍/코너 모델을 기반으로 한 멀티테넌트 재고관리 SaaS다 — 회사들이 물리적 매장 안에서 "코너"를 운영한다. Phase 6에서 재고 원장(ledger)을 마쳤고, Phase 7은 발주(restock orders)다. 그런데 내가 직접 쓴 Phase 7 스펙을 다시 읽다가, 써놓고도 사실은 이해하지 못한 문장 하나를 만났다.

> `Order`의 PK는 composite `[id, companyStoreId]`이고, `OrderItem`이 placement로 거는 composite FK `[companyStoreProductId, companyStoreId]`가 **same-corner integrity**를 데이터베이스 레벨에서 강제한다.

`schema.prisma`에 제약이 있는 건 보였다. 그런데 *왜 그게 동작하는지*는 누구에게도 설명할 수 없었다. 그래서 Phase 7 코드를 한 줄도 쓰기 전에 멈추고, 이걸 전부 분해했다 — 그리고 일회용 SQLite 데이터베이스 위에 다시 쌓아올리면서, 눈앞에서 깨지고 다시 붙는 걸 확인했다. 이 글은 그 우회의 기록이다.

## 불가능하게 만들고 싶은 버그

같은 회사에 속한 코너 두 개:

| id | company_id | name |
|---|---|---|
| `corner-gangnam` | comp-1 | 강남 Nike 코너 |
| `corner-busan` | comp-1 | 부산 Nike 코너 |

위험의 모양을 보자: **같은 회사, 다른 코너.** 평범한 `companyId` 테넌트 검사는 이 둘을 모두 통과시킨다. 코너 분리는 테넌트 분리보다 *더 엄격한* 규칙이고, 지금까지 내가 만든 어떤 것도 그걸 강제하지 않았다.

그리고 두 코너에 각각 올라간 같은 상품:

| id | company_store_id | product |
|---|---|---|
| `101` | `corner-gangnam` | Air Max |
| `202` | `corner-busan` | Air Max |

그리고 강남 소속 발주 하나. 절대 존재하면 안 되는 row는 **강남의 발주**와 **부산의 placement `202`**를 묶은 주문 라인이다 — 강남의 서류로 부산의 재고를 움직이는 것. 조용하고, 코너를 넘나들고, 단일 테이블만 봐서는 보이지 않는다.

## 아키텍처 결정들

### 1. 절차적(procedural) 강제 대신 구조적(structural) 강제

**목표.** 주문 라인의 order와 placement가 같은 코너에 있음을 보장한다.

**선택지.**
- **(a) 서비스 레이어 검사.** 라인을 넣기 전에 placement를 조회해 `companyStoreId`를 order의 것과 비교. Inventra 다른 곳에서 이미 쓰는 fetch-then-decide 패턴.
- **(b) `CHECK` 제약 또는 trigger.** 비교 로직을 데이터베이스 안으로 밀어넣기.
- **(c) composite foreign key** — 어긋난 row를 구조적으로 표현조차 불가능하게 만들기.

**선택.** **(c)**, 그리고 (a)는 404 형태의 API 동작으로 여전히 유지.

**이유.** (a)만으로 얼마나 무력한지 직접 보고 싶어서, naive 버전을 실제로 만들어봤다. `orders`는 `id` 단독 PK, `order_items`는 평범한 단일 컬럼 FK 두 개. 그리고 나쁜 insert:

```sql
INSERT INTO order_items VALUES ('order-sept', 202, 30);
-- ACCEPTED
```

```
order_id    order_corner    placement  placement_corner
----------  --------------  ---------  ----------------
order-sept  corner-gangnam  202        corner-busan
```

데이터베이스는 아주 만족스러워했다. 두 FK 모두 통과했으니까 — *각자 독립적으로*. FK1은 "`order-sept`가 실재하는 order인가?"를 물었고(예), FK2는 "`202`가 실재하는 placement인가?"를 물었다(예). **어느 쪽도 상대의 답을 볼 수 있는 위치에 있지 않았다.** 이게 실패 모드의 전부다: 절대 만나지 않는 두 개의 올바른 검사.

즉 (a) 설계에서 나와 저 row 사이를 막는 유일한 것은, 주문 라인을 만드는 *모든* 코드 경로에 가드를 넣는 걸 기억하는 일이다 — 오늘도, 앞으로 2년간 추가할 모든 기능에서도. (b)는 낫지만 여전히 내가 작성하고 계속 옳게 유지해야 하는 로직이다.

**결과.** composite FK에서는 나쁜 row가 규칙에 의해 거절되는 게 아니다. **넣을 자리가 없다.** 아래에서 이어지는데, 사실 이 부분을 진짜로 *보는* 데 세 번의 시도가 필요했다.

### 2. 하나의 컬럼, 두 개의 foreign key가 읽는

**목표.** 아무 비교 코드도 쓰지 않으면서 두 조회가 서로 대조하게 만들기.

**수단.** `order_items`에 `company_store_id`를 추가하고, 두 FK를 모두 두 컬럼짜리로 넓힌다 — **같은** 코너 컬럼을 양쪽에 넣어서:

```sql
CREATE TABLE order_items (
  order_id                 UUID    NOT NULL,
  company_store_id         UUID    NOT NULL,   -- 칸 하나
  company_store_product_id INTEGER NOT NULL,
  product_order_quantity   INTEGER NOT NULL,
  PRIMARY KEY (order_id, company_store_id, company_store_product_id),
  FOREIGN KEY (order_id, company_store_id)
    REFERENCES orders(id, company_store_id),
  FOREIGN KEY (company_store_product_id, company_store_id)
    REFERENCES company_store_products(id, company_store_id)
);
```

**내가 잘못 알고 있던 것.** 나는 두 컬럼짜리 foreign key가 두 개의 검사라고 — *"1번 컬럼이 저쪽에 있어야 하고, 2번 컬럼도 저쪽에 있어야 한다"* — 생각했다. 아니다. 그건 pair에 대한 **하나의** 검사다: *"이 두 값이 나란히, 저쪽의 한 row에 함께 나타나야 한다."*

가장 확실하게 체화하는 방법: composite key를 두 컬럼으로 읽기를 멈추고, **구분자가 들어간 하나의 값**으로 읽는 것. 데이터베이스가 지금 인식하는 키는 정확히 이것들이다:

```
placements:  "101|corner-gangnam"      orders:  "order-sept|corner-gangnam"
             "202|corner-busan"
```

그러면 foreign key 검사는 원래부터 그랬던 평범한 일이 된다 — 내 키를 들고 가서 네 목록에서 찾기.

**동작하는 이유.** row에는 `company_store_id` 칸이 **하나**뿐이고, 두 조회 모두 그 칸으로 자기 키를 만든다. 그러니 나쁜 라인을 써보자. `order-sept` + placement `202`를 원한다; 코너 칸을 채워야 한다; 후보 값은 정확히 둘이다:

| 시도 | 칸 | FK1이 찾는 것 | FK2가 찾는 것 | 결과 |
|---|---|---|---|---|
| A | `corner-gangnam` | `order-sept\|corner-gangnam` ✓ | `202\|corner-gangnam` ✗ | **REJECTED** |
| B | `corner-busan` | `order-sept\|corner-busan` ✗ | `202\|corner-busan` ✓ | **REJECTED** |

둘 다 실행했고, 둘 다 튕겼다. 그리고 시도 C는 없다 — 둘을 동시에 만족시키려면 칸 하나가 `corner-gangnam`과 `corner-busan`을 동시에 담아야 한다.

**결과.** 불변식은 이렇게 읽힌다: *칸은 "이 라인의 코너"를 말한다; FK1이 그것을 order의 코너와 같게 만든다; FK2가 그것을 placement의 코너와 같게 만든다; 따라서 둘은 같다.* 아무것도 둘을 비교하지 않았다. 둘 다 같은 칸과 비교되었을 뿐이다. `inventory_audit_items`와 `purchase_reservations`에도 토씨 하나 안 틀리고 같은 구조가 들어가 있다.

자식 테이블의 PK `(order_id, company_store_id, company_store_product_id)`에서 보너스도 떨어졌다: **하나의 order에 같은 placement는 최대 한 번만 등장한다.** 같은 상품의 중복 라인 방지가 공짜로 따라온다.

### 3. "코너로 조회 가능"해지는 두 가지 방법

**목표.** composite FK가 요구하는 대로, 두 부모 모두 pair로 조회 가능해야 한다.

**제약 뒤의 제약.** foreign key는 unique 제약이 걸린 컬럼만 타겟으로 삼을 수 있다 — 데이터베이스는 *들여다볼* 인덱스가 필요하다. 인덱스를 지우고 완전히 정상인 row를 넣어보면서 이걸 스스로 증명했다:

```
Error: foreign key mismatch - "order_items" referencing "company_store_products"
```

데이터 에러가 아니다. **foreign key 자체**가 쓸 수 없는 상태였다.

**선택지.** (a) pair를 primary key로 승격; (b) 단순 PK를 유지하고 pair에 unique 인덱스 추가.

**선택.** 둘 다 — 테이블마다 다른 답이고, 이 비대칭은 게을러서가 아니라 강제된 것이다:

| 테이블 | 방식 | 이유 |
|---|---|---|
| `orders`, `inventory_audits` | `PRIMARY KEY (id, company_store_id)` | `id` 단독으로 참조하는 곳이 없으니 더 강한 쪽을 택할 자유가 있다 |
| `company_store_products` | `UNIQUE (id, company_store_id)` | `inventory_transactions`와 `company_store_product_stocks`가 `id` 단독으로 참조한다 — 그건 키로 남아야 한다 |

**이유.** "일관성 있게" placement에도 composite PK를 줘봤다. 단일 컬럼으로 참조하는 자식 둘이 정상 데이터에서 즉시 깨졌다:

```
Error: foreign key mismatch - "company_store_product_stocks" referencing "company_store_products"
Error: foreign key mismatch - "inventory_transactions" referencing "company_store_products"
```

해결책은 `UNIQUE(id)`를 다시 추가하는 것 — 중복 인덱스 하나를 방향만 바꿔 다른 중복 인덱스로 맞바꾸는 셈이고, 게다가 Prisma client에서 placement의 모든 `findUnique`가 `where: { id_companyStoreId: { … } }`가 된다. 명백히 더 나쁘다.

**결과.** `UQ_csp_id_company_store`는 무의미해 보인다 — `id`가 이미 PK라 pair는 자동으로 unique다 — 그리고 그게 정확히 맞다: **이 인덱스는 데이터를 아무것도 제약하지 않는다.** 오직 placement를 코너와 함께 조회 가능하게 만들려고 존재한다. 규칙이 아니라 통행증이다. 반면 `orders`의 composite PK는 모델링 선언이다: order는 코너 + id로 *식별된다*, 그리고 나중에 누구도 `orders(id)`로 단일 컬럼 FK를 걸 수 없다. 가리킬 대상 자체가 없으니까.

### 4. 패턴이 멈추는 지점을 아는 것

**목표.** 값어치를 하는 곳에는 전부 적용하고, 그 외에는 하지 않기.

**판단.** `inventory_transactions`는 이 처리를 받지 않는다. placement로 가는 평범한 단일 컬럼 FK만 있고 `company_store_id`는 아예 없다.

**이유.** 이 불일치 버그는 서로 어긋날 수 있는 **두 개의** 참조를 필요로 한다. transaction은 정확히 하나 — placement — 를 가리키고, placement는 영구히 정확히 하나의 코너에 속한다. 참조가 하나면 대조할 대상이 없고, 코너를 다시 저장하는 건 사들일 불변식 없는 비정규화일 뿐이다.

다만: `sourceType` + `sourceId`는 *실제로* 두 번째 참조다 — order 또는 audit을 가리킨다. 그런데 여기엔 **foreign key가 아예 없다**. 컬럼 하나가 서로 다른 두 테이블을 참조할 수 없기 때문이다. 강남 placement의 transaction이 부산 order의 `sourceId`를 달고 있어도 데이터베이스는 막지 않는다. 그 구멍은 서비스 레이어가 대신 메운다:

```ts
await this.corners.assertWorksCorner(caller, cornerId);
const placement = await this.prisma.companyStoreProduct.findFirst({
  where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
});
if (!placement) throw new NotFoundException('Placement not found');
```

저 두 번째 쿼리는 composite FK가 SQL로 묻는 것을 TypeScript로 똑같이 묻는다.

**결과.** 정직한 2단 구조, 그리고 내가 지금 어느 단 위에 서 있는지 아는 것:

| 단계 | 위치 | 실패 방식 |
|---|---|---|
| **구조적** | `order_items`, `inventory_audit_items`, `purchase_reservations` | Postgres가 insert를 거절 — 코드 개입 없음, 우회 불가 |
| **절차적** | `inventory_transactions`, 다형적 `sourceId` | 서비스가 404 — 코드 경로만큼만 안전 |

Phase 7로 가져갈 교훈: 규칙이 "이 두 참조는 일치해야 한다"로 표현 가능하면 무조건 1단을 잡고, 2단으로 타협할 때는 스펙에 명시적으로 적어둘 것.

## TIL (Today I Learned)

**composite foreign key는 각 컬럼을 따로 검사할까, pair를 함께 검사할까?**
한 row 위에서 함께 — 그리고 이게 나머지 전부의 밑에 깔려 있던 *핵심* 오해였다. 두 해석이 갈리는 테스트 row를 설계했다: `locations(country, city)` 테이블에 `KR|Seoul`, `KR|Busan`, `US|Boston`, `JP|Tokyo`를 넣고, 자식 row로 `('JP','Busan')`. `JP`는 있다. `Busan`도 있다. pair는 없다.

```
jp_appears_somewhere  busan_appears_somewhere  pair_exists_on_one_row
--------------------  -----------------------  ----------------------
         1                       1                        0
```

insert는 **거절됐다**. 앞의 두 컬럼이 참인데도 거절됐으니, FK는 그걸 보고 있지 않았던 것 — 세 번째를 보고 있었다. "따로 검사" 해석이 맞았다면 저 row는 지금 테이블에 앉아 있어야 한다. 없다. composite key를 *하나로 붙은 값*으로 보게 된 순간, 그 뒤의 모든 게 기발한 트릭이 아니라 당연한 귀결이 됐다.

**`id`가 이미 PK인데 `UQ_csp_id_company_store`는 왜 있나?**
`(id, companyStoreId)`가 unique한 게 요점이 아니라, **인덱싱되어 있는 것**이 요점이기 때문이다. foreign key는 들여다볼 대상이 필요하다. 인덱스를 지우면 FK가 약해지는 게 아니라 아예 거절된다(Postgres는 `CREATE TABLE` 시점에, SQLite는 처음 쓸 때). 이 인덱스는 내 데이터에 대해 아무 보장도 추가하지 않으면서, 여전히 구조를 떠받치고 있다.

**`Order`처럼 `CompanyStoreProduct`에도 composite PK가 필요한가?**
아니다. primary key는 그저 "row의 정체성"으로 지정된 unique 제약일 뿐이고, FK 타겟팅에 관해서는 Postgres가 둘 다 받아들인다. `orders`는 `id` 단독 참조가 없어서 composite PK를 감당할 수 있다. `company_store_products`는 `inventory_transactions`와 `company_store_product_stocks`가 그렇게 참조하니 감당할 수 없다. 같은 능력 — *"(id, 코너)로 나를 조회할 수 있게 하라"* — 에 도달하는 두 경로이고, 각각 진짜 이유가 있다.

**`companyId` 검사로 이미 커버되지 않나?**
두 코너가 같은 회사 소속이기 때문에 안 된다. 내가 지금까지 쓴 모든 테넌트 스코핑 검사가 이 row를 통과시킨다. 코너 레벨 무결성은 테넌트 레벨보다 엄격히 더 촘촘한 경계이고, 자기만의 메커니즘이 필요했다.

**왜 네 번이나 설명을 듣고서야 이해했을까?**
*결론*("그러니까 둘은 같은 코너여야 한다")에는 계속 고개를 끄덕이면서, *원시 개념*(두 컬럼 FK가 뭘 검사하는가)에 대한 틀린 모델을 조용히 붙들고 있었기 때문이다. 원시 개념이 깨져 있으면 결론을 아무리 반복해도 고쳐지지 않는다. 결국 통한 건 실행 가능한 모델을 만드는 것이었다 — 일회용 SQLite 데이터베이스 셋(naive 하나, 진짜 하나, 일부러 망가뜨린 하나) — 그리고 각 insert의 결과를 **실행 전에 예측하는 것**. 실제 엔진 앞에서 소리 내어 틀려보니 90초 만에 구멍이 어딘지 드러났다.

## 개념과 도구

| 항목 | 왜 등장했나 |
|---|---|
| **Composite primary key** — Prisma `@@id([id, companyStoreId])` | 코너를 order의 정체성 일부로 만들어, 자식이 그걸 다시 진술하게 강제 |
| **Composite unique index** — Prisma `@@unique([...], map: "UQ_csp_id_company_store")` | `SERIAL` PK를 건드리지 않으면서 placement에 코너 포함 조회 경로를 하나 더 부여 |
| **Multi-field relations** — `@relation(fields: [a, b], references: [x, y])` | Prisma가 두 컬럼 FK를 표현하는 방식; 두 relation에 걸친 공유 컬럼이 트릭의 전부 |
| **FK 타겟 규칙** (타겟은 unique 인덱스가 있어야 함) | "중복" 인덱스가 장식이 아니라 하중을 받는 구조물인 이유 |
| **`prisma migrate`가 생성한 SQL** | 이 패턴에 한해서는 raw `ALTER TABLE … ADD CONSTRAINT`가 Prisma DSL보다 훨씬 읽기 쉽다 — 공유 컬럼이 보이게 된 건 `migration.sql`을 읽고 나서였다 |
| **연습장으로서의 SQLite** | 여기서는 Postgres 의미론과 충분히 가깝고, 버려도 되는 `.db` 파일 하나가 설명을 *믿는 것*과 *검증하는 것*의 차이를 만들었다 |
| **`OwnershipService` / fetch-then-decide** (NestJS) | 어떤 FK로도 표현할 수 없는 것을 메우는 절차적 단계 — 다형적 `sourceId` |
| **`PrismaService` + `$transaction`** (NestJS) | 구조적 보장이 Phase 6 원장의 쓰기 경로와 만나는 지점 |

## 마무리

이 우회에서 출시된 기능은 없다. 출시된 건, 이제 내가 내 스키마를 *읽을 수* 있다는 사실이다. `orders_pkey`, `UQ_csp_id_company_store`, 그리고 네 컬럼짜리 `order_items` foreign key들은 베껴 쓴 의식(儀式)이기를 그만두고, 내가 언제든 다시 유도해낼 수 있는 하나의 아이디어가 됐다: **판별자를 키 안에 넣어라, 그리고 두 조회가 컬럼 하나를 공유하게 하라. 그러면 테넌트 필터가 빠지는 종류의 버그는 애초에 적어넣을 수가 없다.**

비용은 정직하다 — 모든 자식 테이블에 UUID 컬럼 하나 추가, 그리고 모든 insert가 `companyStoreId`를 끌고 다녀야 한다. 이득은 그것이 *런타임 비용이 0*이고 잊어버릴 수가 없다는 것인데, 이건 내가 손으로 쓴 어떤 가드에 대해서도 할 수 없는 말이다.

다음: **Phase 7 — 발주(restock orders).** `orders`, `order_items`, draft-and-confirm, 그리고 확정된 발주가 Phase 6 원장에 넘어가 실제로 재고를 움직이는 순간. 하루를 들여 이해한 이 제약이 바로 그 Phase 전체를 떠받치고 있는 것이다.
