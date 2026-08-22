# 한 번의 쓰기, 두 개의 진실: 초과판매 없이 실제 재고 움직이기

> Inventra Phase 6 — 진열대 위의 숫자가 원장(ledger)의 이벤트가 되고, 경쟁 상태(race condition)가 깔끔한 409가 되는 단계.
> 2026-08-22

## 들어가며

Inventra는 한국의 편집숍/코너 모델을 기반으로 한 멀티테넌트 재고관리 SaaS다 — 회사들이 물리적 매장 안에서 "코너"를 운영한다. 지금까지의 모든 Phase는 *구조*에 관한 것이었다. 당신이 누구인지(auth), 무엇을 건드릴 수 있는지(authz), 무엇을 파는지(catalog), 어디서 운영하는지(corners), 그리고 어떤 진열대에 무엇이 올라가는지(placement). Phase 6은 처음으로 *움직임*에 관한 Phase다 — 실제 재고를 움직인다. 판매가 일어나면 수량이 줄고, 입고하면 늘고, 파손이 나면 판매 가능한 재고 하나가 조용히 손상 재고로 바뀐다. `count = count - 1`처럼 들린다. 하지만 아니다. 이 Phase는 "그냥 숫자 하나 빼면 되잖아"가 원장, 실시간 잔고, 17개짜리 effect 테이블, 그리고 Phase 4부터 미뤄뒀던 단 하나의 동시성 가드로 변하는 지점이었다.

## 아키텍처 결정들

### 1. 두 개의 진실, 한 번의 쓰기 — 원장(ledger) *과* 실시간 잔고

**목표.** 서로 반대 방향으로 당기는 두 질문에 답하기: *"지금 진열대에 몇 개 있지?"* (빠르게, 끊임없이 묻는 질문) 와 *"어쩌다 그 숫자가 됐지?"* (완전하고 감사 가능한 히스토리).

**선택지.**
- **(a) 잔고만** — 변경 가능한 `availableQuantity` 컬럼 하나. 읽기는 즉각적이지만, 모든 움직임이 과거를 덮어쓴다. *왜*는 절대 답할 수 없다.
- **(b) 원장만** — append-only 움직임 목록. 현재 수량은 읽을 때마다 `SUM(...)`으로 유도. 히스토리는 완벽하지만, "진열대에 몇 개"가 앱에서 가장 뜨거운 읽기 위에 O(n) 집계가 된다.
- **(c) 둘 다** — 불변(immutable) 원장 행을 append *하고* 실시간 잔고를 update, 한 트랜잭션 안에서 함께.

**선택.** **(c).** 모든 움직임은 원자적으로 두 가지를 쓴다: append-only `InventoryTransaction` (그 *이벤트* — 타입, 수량, `quantityBefore`, `quantityAfter`, 누가, 그리고 선택적 source) 과 `CompanyStoreProductStock` 위의 잔고 (그 *현재의 진실*).

**이유.** 두 질문은 접근 패턴이 진짜로 다르다. 그러니 저장 방식도 진짜로 다르게 간다. 원장은 절대 update되거나 delete되지 않는다 — 그것이 감사 추적(audit trail)이고, 그 불변성이 핵심 전부다. 잔고는 이미 계산되어 있으므로 O(1)로 읽힌다. 둘을 하나의 `$transaction`으로 감싸면 둘은 절대 어긋날 수 없다: 이벤트와 새 잔고가 둘 다 반영되거나, 아무것도 반영되지 않거나.

**결과.** "현재 재고" 읽기는 좁은 행 하나만 건드린다. "누가 무엇을, 언제 팔았고, 그 전후 수량은 얼마였나"라는 질문은 아무것도 재구성하지 않고 원장이 답한다. 이벤트 소싱(event sourcing)의 좋은 아이디어 — 이벤트를 보존한다 — 를, 매 읽기마다 이벤트 소싱의 세금을 내지 않고 취한 것이다.

### 2. 뜨거운 재고 행을 차가운 배치 설정에서 분리하기

**목표.** 하루에 수천 번 변경되는 잔고를, 배치(placement)의 설정을 끌고 다니지 않으면서 값싸게 변경하기.

**마찰.** 원래 Phase 5 설계는 수량 컬럼들을 `CompanyStoreProduct` *위에*, 배치의 정체성과 설정 바로 옆에 두었다. 그런데 이 두 종류의 데이터는 완전히 다른 온도에서 산다. `availableQuantity`는 매 판매마다 바뀐다. `targetStockQuantity`, `isActive`, `description`은 거의 안 바뀐다. Postgres의 MVCC는 어떤 `UPDATE`든 **행 전체**를 다시 쓴다 — 그래서 매 판매가 배치의 차가운 설정까지 다시 쓰고 있었고, 변한 적 없는 바이트들에 대해 dead tuple과 WAL을 만들어내고 있었다.

**선택지.** (a) 수량을 `CompanyStoreProduct`에 그대로 두기; (b) 뜨거운 잔고를 자신만의 1:1 테이블로 분리하기.

**선택.** **(b).** 외래키가 곧 기본키인, 공유 PK로 1:1 조인되는 새 `CompanyStoreProductStock`:

```prisma
model CompanyStoreProductStock {
  companyStoreProductId Int @id @map("company_store_product_id")
  targetStockQuantity   Int @default(0) @map("target_stock_quantity")
  availableQuantity     Int @default(0) @map("available_quantity")
  reservedQuantity      Int @default(0) @map("reserved_quantity")
  sampleQuantity        Int @default(0) @map("sample_quantity")
  damagedQuantity       Int @default(0) @map("damaged_quantity")
  companyStoreProduct CompanyStoreProduct @relation(fields: [companyStoreProductId], references: [id])
  @@map("company_store_product_stocks")
}
```

**이유.** 뜨거운 사실(hot fact)을 차가운 차원(cold dimension)에서 분리하면 자주 다시 쓰이는 행이 좁게 유지된다 — MVCC 부담이 줄고, WAL이 줄고, vacuum할 dead tuple이 줄어든다 — 반면 배치 메타데이터는 실시간 수량이 필요 없는 읽기들을 위해 캐시-안정적으로 남는다. 공유 PK/FK (`companyStoreProductId Int @id`)는 이것을 진짜 1:1로 만든다: 재고 행의 정체성이 곧 자신이 속한 배치이며, 대리키(surrogate key)도 없고, 한 배치에 재고 행이 둘 생길 가능성도 없다.

**결과.** 재고 행은 배치와 함께 생성되고(중첩 `stock: { create }`) 그 soft-delete 생명주기를 물려받는다. 덕분에 Phase 5의 다른 어떤 것도 사고방식을 바꿀 필요가 없었다 — 다만 쓰기 경로가 이제 "쓰이기 위해 만들어진" 테이블을 향하게 됐다.

### 3. Effect 맵 — 17개의 트랜잭션 타입을 분기가 아닌 데이터로

**목표.** 17가지 움직임(RESTOCK, SALE, TRANSFER_OUT, BREAKAGE, SAMPLE_ALLOCATION, ADJUSTMENT, …)을 지원하되 `record()`가 17갈래 `switch`가 되지 않게 하기.

**문제의 형태.** 타입들은 균일하지 않다. 대부분은 버킷 하나만 움직인다(`SALE`은 available을 감소). 일부는 버킷 *사이로* 재고를 옮긴다(`BREAKAGE`는 available에서 하나 빼서 damaged에 넣는다 — 물리적 개체는 여전히 존재하고, 다만 판매 불가일 뿐이다). 그리고 하나, `ADJUSTMENT`은 현재 값을 완전히 무시하고 실사(physical recount) 값으로 수량을 *설정*한다.

**선택지.** (a) `record()` 안의 커다란 `switch (dto.transactionType)`; (b) 각 타입을 그 *effect*에 매핑하는 선언적 테이블, 그리고 그 effect를 해석만 하는 `record()`.

**선택.** **(b).** 컴파일러가 타입을 빠뜨리지 못하게 하는, 남김없이 타입 지어진(exhaustively typed) `EFFECTS` 테이블:

```ts
export type Effect =
  | { kind: 'delta'; deltas: { field: Bucket; sign: 1 | -1 }[]; primaryBucket: Bucket }
  | { kind: 'set'; field: 'availableQuantity' };

export const EFFECTS: Record<InventoryTransactionType, Effect> = {
  SALE:    dec(availableQuantity),
  RESTOCK: inc(availableQuantity),
  BREAKAGE: {
    kind: 'delta',
    deltas: [
      { field: availableQuantity, sign: -1 },  // guard-first: 감소를 먼저
      { field: damagedQuantity,   sign: +1 },
    ],
    primaryBucket: availableQuantity,
  },
  ADJUSTMENT: { kind: 'set', field: availableQuantity },
  // …총 17개
};
```

**이유.** 핵심 트릭은 `Record<InventoryTransactionType, Effect>`다: enum 값을 추가하고 매핑을 빠뜨리면 빌드가 깨진다 — 테이블이 *완전(total)함*이 증명된다. 각 effect는 독립적으로 단위 테스트할 수 있는 평범한 값이고, `record()`는 완전히 타입-불가지론적으로 남는다 — `delta`냐 `set`이냐를 해석할 뿐, `if (type === 'SALE')`는 절대 없다. `primaryBucket`은 움직임이 버킷 두 개를 건드릴 때 원장의 `before`/`after`가 *어느* 버킷을 추적해야 하는지를 지정한다(파손의 경우 그건 *available*이다 — 판매 가능 수량이 사람들이 신경 쓰는 숫자니까).

**결과.** 움직임 타입 추가는 한 줄짜리 행이고, 테이블이 다시 완전해질 때까지 컴파일러가 잔소리를 한다. 도메인 로직(각 타입이 *무엇을 의미*하는가)은 프레임워크가 전혀 없는 파일에, "모든 delta effect는 자신의 `primaryBucket`을 포함한다"를 단언하는 spec 테스트 옆에 앉아 있다.

### 4. 가드된 `updateMany` — 경쟁 상태가 409가 되는 방법

**목표.** 절대 초과판매하지 않기. 두 계산원이 같은 순간에 마지막 하나를 스캔해도 둘 다 성공해서는 안 된다.

**함정.** 뻔한 코드는 read-then-write다:

```ts
const stock = await tx.stock.findUnique(...);
if (stock.availableQuantity < q) throw new ConflictException();   // 확인(check)
await tx.stock.update({ data: { availableQuantity: { decrement: q } } }); // 그리고 실행(act)
```

이건 **TOCTOU** 경쟁이다 — 확인과 실행 사이의 틈. 두 트랜잭션이 "available 1"을 둘 다 읽고, 둘 다 확인을 통과하고, 둘 다 감소시켜서, 하나뿐이던 재고를 둘 팔아버린다.

**선택지.** (a) read-then-write (위처럼 깨진 방식); (b) 행을 잠그는 `SELECT ... FOR UPDATE`; (c) 애플리케이션 레벨 뮤텍스; (d) 조건부 `updateMany`로 확인을 쓰기 *안으로* 접어 넣기.

**선택.** **(d).** 데이터베이스가 이미 직렬화하는 바로 그 원자적 `UPDATE`의 일부로 가드를 만든다:

```ts
const { count } = await tx.companyStoreProductStock.updateMany({
  where: { companyStoreProductId: placementId, [field]: { gte: q } }, // WHERE 안의 가드
  data:  { [field]: { decrement: q } },
});
if (count === 0) throw new ConflictException('Insufficient stock');
```

**이유.** `gte: q` 조건이 쓰기 *안*에 산다. 경쟁할 별도의 읽기가 없다 — 데이터베이스가 "충분한가?"와 "빼라"를 나눌 수 없는 하나의 연산으로 평가한다. 마지막 하나에 둘이 동시에 발사되면, 정확히 하나만 `WHERE`에 매칭되어 update되고(`count: 1`), 다른 하나는 아무것도 매칭하지 못해(`count: 0`) 우리는 그걸 `409 Conflict`로 바꾼다. (`updateMany`가 이걸 가능하게 하는데, 동시성 때문만은 아니다 — 매칭이 없을 때 단일 `update`는 `P2025`를 *던지지만*, `updateMany`는 내가 분기할 수 있는 `count`를 반환한다. TIL 참고.)

**결과.** 이것이 내가 Phase 4부터 일부러 미뤄뒀던, 정말로 필요한 Phase를 기다리던 그 패턴이다. 초과판매는 이제 구조적으로 불가능하고, 비용은 `if` 하나다. 버킷 간 이동은 감소를 **먼저** 나열한다(더하기 전에 가드) — 그래서 파손은 available에서 빼는 데 실패한 손상 재고를 결코 만들어낼 수 없다.

## TIL (Today I Learned)

**effect는 왜 `deltas` 목록과 별도의 `primaryBucket`을 둘 다 필요로 하나? primary가 그냥… 그 필드 아닌가?**
단일 버킷 이동에서는 맞다 — `SALE`은 `availableQuantity`를 감소시키고 그게 곧 원장이 추적하는 버킷이다. 하지만 버킷 간 이동은 *둘*을 건드린다: `BREAKAGE`는 `available`에서 빼고 `damaged`에 더한다. 원장의 `quantityBefore`/`quantityAfter`는 하나의 이야기만 담을 수 있으니, `primaryBucket`이 *어느* 것인지 말해준다 — 파손의 경우 의미 있는 before/after는 **available** 수량이다. 매장이 신경 쓰는 판매 가능 숫자니까. `deltas`는 *물리적으로 무엇이 움직이는가*, `primaryBucket`은 *원장이 무엇을 서술하는가*.

**`CreateTransactionDto`는 왜 `sourceType` / `sourceId`를 받지 않나?**
출처(provenance)는 클라이언트가 주장할 수 있는 게 아니어야 하기 때문이다. `source`는 *서버*가 설정한다 — 나중에 orders 모듈이 `record(..., { type: 'ORDER', id })`를 호출할 때, 움직임이 어디서 왔는지를 원장에 찍는다. API를 직접 때리는 사람은 그냥 "SALE, 수량 3"이라고 말할 뿐, "이건 주문 #42였다"를 위조할 수 없다. 그래서 `source`는 DTO 필드가 아니라 선택적 *메서드 파라미터*다 — 신뢰된 호출자는 넘기고, 신뢰되지 않은 입력은 절대 건드리지 못한다.

**`quantity`는 절대량인가, 적용할 양인가?**
둘 다 — 그리고 어느 쪽인지는 effect의 `kind`에 달렸다. `delta` 타입에서는 *적용할* 양이다(SALE 수량 3 = "셋을 빼라"). `set` 타입(`ADJUSTMENT`)에서는 실사의 *절대* 결과다("여기 실제로 5개 있으니, 그렇게 만들어라"). 그래서 원장은 `before = 원래 값`, `after = 5`를 기록한다. 같은 필드, 두 의미, effect가 구분해준다 — effect 테이블이 제 밥값을 하는 이유가 바로 이것이다.

**`companyStoreProductId`는 unique인데 — 왜 `update`가 아니라 `updateMany`인가?**
행의 *개수* 때문이 아니다 — 언제나 하나다. **조건부** `WHERE`와 **반환값** 때문이다. Prisma의 `update`는 unique id로 행을 지정하고 `where`가 아무것도 매칭 못 하면 *`P2025`를 던진다* — 게다가 `update`의 where에는 `availableQuantity: { gte: q }`를 애초에 넣을 수 없다. `updateMany`는 재고 가드를 `where`에 넣게 해주고, 던지는 대신 `{ count }`를 반환한다. 그래서 `count === 0`이 예외 대신 깔끔한 "재고 부족 → 409" 신호가 된다.

**그럼 `count`는 `updateMany`에서만 돌아오나?**
그렇다. `update`는 갱신된 *레코드*를 반환한다(아니면 던진다). `updateMany`/`deleteMany`/`createMany`는 `{ count }`를 반환한다 — 배치 결과다. "내 가드된 쓰기가 뭔가에 적중했나?"가 궁금할 때 배치 API의 count가 답이다. 단일 레코드 API였다면 같은 걸 알기 위해 예외를 catch해야 했을 것이다.

**primary 버킷에 sign이 있다고 `!`로 단언하고 싶지 않았다. 올바른 실패 방식은?**
`primaryBucket`이 effect의 `deltas`에 없다면, 그건 사용자 오류가 아니다 — *나*의 오류, 절대 배포되면 안 되는 잘못 설정된 테이블이다. 그래서 non-null 단언(`primarySign!`) 대신, 문제의 타입을 지목하는 진단 메시지와 함께 `InternalServerErrorException`을 던진다. 깨진 불변식이 호출자의 것이 아니라 서버의 것이므로 5xx다 — 그리고 "모든 delta effect는 자신의 primaryBucket을 포함한다"를 단언하는 spec 테스트 덕분에 이 분기는 실무상 도달 불가능해야 한다. 이 throw는 테스트라는 멜빵에 더하는 벨트다.

## NestJS 개념 & 라이브러리

| 개념 / 도구 | Phase 6에서 등장한 이유 |
|----------------|------------------------------|
| **`PrismaClient.$transaction` (interactive)** | 원장 insert + 잔고 이동을 전부-아니면-전무의 한 단위로 감싸기. |
| **가드된 `updateMany` + `{ count }`** | 초과판매 확인을 원자적 쓰기 안으로 접어 넣기; `count === 0` ⇒ 409. |
| **공유 PK/FK로 만든 Prisma 1:1** | 배치 id로 키를 잡은 `CompanyStoreProductStock` — 진짜 1:1, 뜨거운 행을 차가운 행에서 분리. |
| **중첩 라우트 컨트롤러** | `/corners/:cornerId/products/:placementId/transactions` — 움직임이 코너와 배치를 경로에서 물려받음. |
| **`@RequirePermissions` (RBAC)** | 새로 시드된 두 권한 — `transactions.read` / `transactions.create` (총 35개). |
| **`OwnershipService` / `assertWorksCorner`** | Phase 5의 유도된 소유권 재사용 — 쓰기는 코너에서 일하는 사람, 읽기는 그 테넌트만. |
| **`ValidationPipe` + `@IsEnum`/`@IsInt`/`@Min`** | 알 수 없는 `transactionType`이나 음수 수량을 경계에서 400으로 거절. |
| **남김없는 `Record<Enum, T>`** | 17개 타입 effect 맵의 컴파일러-강제 완전성. |

## 마무리

Phase 6은 재고를 "덮어쓰는 숫자"에서 "기록하는 이벤트"로 바꿨다. 산출물: 뜨거움/차가움으로 분리된 데이터 모델, O(1) 실시간 잔고 옆의 append-only 원장, 컴파일러가 정직하게 지켜주는 선언적 17-타입 effect 맵, 그리고 초과판매가 테스트로 잡아야 할 버그가 아니라 구조적 불가능이 된 단 하나의 원자적 쓰기. **단위 테스트 140개 + e2e 39개, 전부 green.**

가장 만족스러운 부분은 마지막 조각이 세 Phase 전에 파둔 홈에 딱 맞아 들어갔다는 것이다. 원자적 `updateMany` 패턴은 Phase 4에서 이름 지어졌고, 정말로 필요한 Phase가 올 때까지 일부러 선반에 올려뒀다 — 그리고 재고 움직임이 바로 그 Phase다.

**다음 — Phase 7: 주문(orders).** `record(..., source)`를 실전에서 처음 호출할 바로 그것: 재고를 움직이면서 *동시에* 그 움직임이 어디서 왔는지를 원장에 찍는 주문 라인. 이번 Phase에 만들어 비워둔 provenance 파라미터가 곧 첫 진짜 호출자를 만난다.
