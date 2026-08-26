# 재고를 움직이지 않는 주문: 순수한 문서로서의 재입고 요청

> Inventra Phase 7 — "주문"이 명령이 아니라 요청임이 드러나고, 초록불이 켜진 수백 개의 유닛 테스트가 놓친 것을 e2e 테스트 하나가 잡아내는 단계.
> 2026-08-27

## 들어가며

Inventra는 한국의 편집숍/코너 모델을 기반으로 한 멀티테넌트 재고관리 SaaS다 — 회사들이 물리적 매장 안에서 "코너"를 운영한다. Phase 6은 실제 재고를 움직이는 엔진을 만들었다: 원장 + 실시간 잔고, 초과판매 방지. 그래서 Phase 7이 "주문"으로 올라왔을 때, 나는 이게 그 엔진의 첫 고객일 거라 생각했다 — 주문하면 재고가 움직인다. 아니었다. 이번 Phase 전체에서 가장 유용했던 질문은 내가 맨 처음 던진 질문이었고, 그 답이 모든 걸 다시 짰다: 여기서 주문은 **의도를 기록할 뿐 재고를 절대 건드리지 않는다**. 이것은 겉보기보다 일부러 덜 하는 문서를 만든 이야기이자, 모든 유닛 테스트를 통과하고도 진짜 데이터베이스가 관여하는 순간 잡힌 복합 키(composite key) 버그의 이야기다.

## 아키텍처 결정들

### 1. 명령이 아니라 문서

**목표.** 코너 직원이 진열대가 비었을 때 실제로 하는 일을 모델링하기: 재입고 요청을 넣는다.

**재구성.** 첫 직감은 주문을 이행하면 `RESTOCK` 트랜잭션이 생성되는 것 — 주문이 들어오면 재고가 올라간다 — 이었다. 하지만 그건 거짓말을 심는 것이다: 현실에서 재입고는 **보장되지 않는다**. 늦게 오거나, 일부만 오거나, 아예 안 온다. 10개를 요청해도 회사가 8개만 보낼 수 있다.

**선택지.** (a) 주문 이행 시 `RESTOCK` 움직임 자동 생성. (b) 주문은 **순수한 문서** — 요청을 기록만 하고, 실제 `RESTOCK`은 물건이 실제로 도착했을 때 손으로 입력. (c) 배송을 추적하려는 상태 기계(DRAFT → SUBMITTED → FULFILLED).

**선택.** **(b).** 주문은 헤더(제목, 메모, 문서 URL, 업무 날짜) + 라인 아이템(어느 placement를, 몇 개 요청)이다. 생성/수정/삭제 어느 것도 `CompanyStoreProductStock`을 읽거나 쓰지 않는다. 배송이 도착하면 사람이 Phase 6 엔진을 통해 실제 움직임을 기록하고 — 선택적으로 그 원장 행에 `source = ORDER`를 찍어 요청을 가리킨다.

**이유.** 요청을 원장에 결합하면 존재하지 않는 확실성을 강요하게 된다. 둘을 분리해 두면 **원장은 물리적으로 무엇이 움직였는지의 독립적 진실**로 남고, 주문은 무엇이 *요청되었는지*의 진실로 남는다 — 그리고 둘은 서로 어긋날 자유가 있다. 현실이 정확히 그렇게 하니까.

**결과.** 이번 Phase엔 `$transaction`+`updateMany` 엔진도, 초과판매 가드도, 상태 enum도 없다. 그냥 정직한 문서 하나. `source = ORDER` 연결 고리는 스키마에 실재하지만 뒤로 미뤄뒀다 — 나중의 이행(fulfillment) Phase를 위한 훅이지, 이번 Phase가 자동화하는 척하는 것이 아니다.

### 2. 전체 교체(replace-all) 아이템, 그리고 절반 만든 주문은 누구 것인가

**목표.** 접수된 요청을 수정(수량 고치기, 라인 빼기)하고 철회할 수 있게 하기.

**선택 + 마찰.** **soft-delete**를 갖춘 풀 CRUD(주문은 나중에 트랜잭션의 source로 참조될 수 있으니 진짜로 사라지면 안 된다). 라인 아이템은 자연스러운 설계가 **전체 교체**다: 수정 시 아이템 세트 전체를 담아 보내고 서버가 통째로 스왑한다. 그런데 좋은 질문이 나왔다 — 직원이 주문을 *만드는* 중에 손님이 들어오고 앱 프로세스가 죽으면? 전체 교체에서는 최종 제출 전까지 아무것도 저장되지 않으니, 추가하던 라인이 전부 날아간다.

**선택지.** (a) 전체 교체, 그리고 **클라이언트**가 로컬 초안을 보관. (b) 세분화된 서버 엔드포인트(`POST/DELETE …/items/:id`)로 각 라인을 추가 즉시 영속화.

**선택.** **(a).** 서버는 전체 교체 핸들러 하나만 유지하고, 진행 중 내구성은 클라이언트의 `localStorage`가 맡는다 — 이건 앱 프로세스가 죽어도 살아남는다. 바로 그 시나리오다.

**이유.** 세분화 설계는 플랫폼이 이미 푸는 문제를 풀기 위해 표면적(엔드포인트 3개 추가, 테스트 추가)을 늘린다: 브라우저 초안은 프로세스 죽음보다 오래 산다. 내구성을 값싼 곳으로 밀어라.

**결과.** 하나의 `update`가, 단일 `$transaction` 안에서 헤더를 다시 쓰고 아이템을 스왑한다:
```ts
await tx.orderItem.deleteMany({ where: { orderId, companyStoreId } });
await tx.orderItem.createMany({ data: items.map(/* … */) });
```
주문은 언제나 **최소 한 줄**을 갖는다 — 경계에서 강제(`@ArrayMinSize(1)`)하므로, 수정이 빈 유령 요청을 남길 수 없다.

### 3. ADMIN의 권한을 데이터베이스로 옮기기

**목표.** 이건 작업 중간의 질문에서 나왔다: *ADMIN 권한도 DB 레벨에서 관리할 수 있나?*

**현 상태.** ADMIN은 **코드 레벨 와일드카드**였다. `PermissionsService`가 특수 처리했다: 역할이 ADMIN이면 테이블의 *모든* 권한을 반환하고 오버라이드 조회는 통째로 건너뛴다. 유지보수 제로에는 좋지만(ADMIN은 새 권한이 추가되는 즉시 자동 상속), ADMIN의 실제 권한은 DB에서 보이지 않았고, 모든 역할 중 유일하게 다르게 처리되는 역할이었으며, 특정 admin에게 특정 권한 하나를 `DENY`할 방법이 없었다.

**선택지.** (a) 와일드카드 유지. (b) ADMIN 배열에 모든 권한을 손으로 나열. (c) seed에서 권한 목록으로부터 ADMIN 권한을 **파생**하고, 특수 케이스를 없애 ADMIN도 다른 역할처럼 자기 행을 읽게 한다.

**선택.** **(c).** seed가 ADMIN에게 전체 세트를 계산해서 부여한다:
```ts
const ROLE_PERMISSIONS = {
  ADMIN: PERMISSIONS.map((permission) => permission.code), // 드리프트 없음
  OWNER: [ /* … */ ],
  // …
};
```
그리고 `PermissionsService`의 와일드카드 분기는 삭제된다 — ADMIN은 이제 모두와 똑같은 "행 + 오버라이드" 경로를 탄다.

**이유.** 손으로 나열하는 건 드리프트 지뢰다: 권한을 추가하고 ADMIN에게 부여하는 걸 잊으면, ADMIN이 조용히 접근을 잃는다. 목록에서 파생하면 DB가 진실의 원천으로 남으면서 **동시에** 드리프트가 불가능하다. seed가 매번 ADMIN의 전체 세트를 다시 계산하니까.

**결과.** ADMIN의 권한은 이제 `role_permissions`에서 감사 가능하고, 다른 모든 역할과 균일하며 — 의도된 동작 변화로 — 사용자 레벨 `GRANT`/`DENY` 오버라이드가 마침내 admin에게도 적용된다. 특수 케이스 분기 하나가 사라졌다.

### 4. 유닛 테스트가 볼 수 없는 복합 키 버그

**목표.** 없다 — 이건 결정이 아니라 교훈이다.

**무슨 일이 있었나.** `OrderItem`에는 **`companyStoreId` 컬럼을 공유하는** 두 개의 복합 외래키가 있다: 주문으로의 FK(`[orderId, companyStoreId]`)와 placement로의 FK(`[companyStoreProductId, companyStoreId]`). 내 레퍼런스 코드는 각 중첩 라인 아이템을 원시 스칼라로 만들었다:
```ts
orderItems: { create: items.map((i) => ({
  companyStoreId: cornerId,                 // ⛔
  companyStoreProductId: i.companyStoreProductId,
  productOrderQuantity: i.productOrderQuantity,
})) }
```
모든 유닛 테스트가 통과했다. 그런 다음 e2e가 돌았고 Prisma가 던졌다: `Unknown argument 'companyStoreId'`. 중첩된 `order.create → orderItems.create`에서는 부모 주문이 이미 `companyStoreId`를 고정하므로, Prisma의 checked 입력은 **그걸 다시 설정하도록 허용하지 않는다** — placement를 *관계(relation)*로 붙이길 원한다:
```ts
orderItems: { create: items.map((i) => ({
  productOrderQuantity: i.productOrderQuantity,
  companyStoreProduct: {
    connect: { id_companyStoreId: { id: i.companyStoreProductId, companyStoreId: cornerId } },
  },
})) }
```

**교훈.** 유닛 테스트는 `prisma.order.create`를 목(mock) 처리했다 — *어떤* 객체든 기꺼이 받는 `jest.fn()`. 목은 내 코드가 **내가 기대하라고 시킨 형태**를 호출하는지 검증할 뿐, 그 형태를 Prisma의 실제 입력 타입에 대해 검증할 수는 없다. 오직 진짜 데이터베이스를, 엔드투엔드로 구동해야만 그게 된다. 이것이 바로 유닛과 통합 테스트 사이의 이음매이고, Phase 7은 그걸 빨간 잉크로 그었다: 초록불 유닛 테스트 148개, 버그 1개, 47번째 e2e가 잡음.

## TIL (Today I Learned)

**여기서 "주문"이 대체 뭘 의미하나 — 하나 접수하면 재고가 움직이나?**
아니다, 그게 설계 전부였다. 그건 *요청* 문서다. 물리적 재고는 물건이 실제로 도착했을 때 Phase 6의 원장을 통해 별도의 수동 단계로 움직인다. 재입고는 결코 보장되지 않으므로 주문과 움직임을 일부러 분리했다 — 분리는 원장이 "실제로 일어난 일" 대 "그저 요청된 일"에 대해 정직하게 남게 한다.

**중첩 `items` 배열에 왜 `@ValidateNested`와 `@Type`이 둘 다 필요한가?**
HTTP로 오는 JSON은 그냥 평범한 객체라서 — class-validator는 각 요소가 `OrderItemDto`인지 모른다. 그래서 `@Type(() => OrderItemDto)` 없이는 내부 `@IsInt()`/`@Min(1)`이 절대 안 돌고 잘못된 라인이 통과한다. `@Type`은 어느 클래스를 인스턴스화할지 알려주고, `@ValidateNested({ each: true })`가 그 실제 인스턴스들을 검증한다. `@ArrayMinSize(1)`과 짝지으면 그게 "유효한 아이템 ≥1" 보장 전부이고, 서비스가 돌기도 전에 강제된다.

**왜 유닛 테스트는 통과했는데 e2e는 실패했나?**
목 처리된 `prisma.order.create`는 건네는 무엇이든 받기 때문이다 — 유닛 테스트는 내 서비스가 내가 주장한 객체를 *만드는지*만 확인한다. 그 객체가 Prisma의 생성된 입력 타입에 대해 유효하지 않다는 걸 알 수 없다. 공유된 `companyStoreId` 복합 FK는 실제 스키마 제약이라, 진짜 데이터베이스에 대해서만 문다. 목은 내 의도를 테스트하고, 통합 테스트는 현실을 테스트한다.

**ADMIN 권한도 DB 레벨에서 관리할 수 있나?**
그렇다 — ADMIN 권한을 손으로 나열하는 대신 seed가 권한 목록에서 *파생*(`PERMISSIONS.map(...)`)하게 하면, 새 권한 부여를 잊는 드리프트 위험 없이 ADMIN이 다른 모든 역할처럼 `role_permissions`에 산다. 의도적으로 받아들인 트레이드오프: 이제 `DENY` 오버라이드가 admin에게도 적용된다. 전에는 admin이 절대적이었다.

**`createMany` 대 중첩 `create` — 왜 받는 필드가 다른가?**
서로 다른 생성 입력 타입을 쓰기 때문이다. 중첩 `order.create → orderItems.create`는 `OrderItemCreateWithoutOrderInput`을 쓰는데, 부모가 관리하는 키를 생략하고 다른 관계는 `connect`로 원한다. 하지만 (수정-스왑이 쓰는) `orderItem.createMany`는 `OrderItemCreateManyInput`을 받는다 — `orderId`, `companyStoreId`, `companyStoreProductId`를 직접 받는 평평한 대량 스칼라 삽입. 같은 테이블, 두 형태 — 하나는 부모 아래 중첩돼 있고 다른 하나는 아니니까.

## NestJS 개념 & 라이브러리

| 개념 / 도구 | Phase 7에서 등장한 이유 |
|----------------|------------------------------|
| **중첩 DTO 검증** (`@ValidateNested` + `@Type` + `@ArrayMinSize`) | 라인 아이템 배열을 검증하고 요청 경계에서 ≥1을 강제 — 레포 최초의 중첩 DTO 바디. |
| **`PartialType(CreateOrderDto)`** | 수정 DTO: 모든 필드 선택적, 단 `items`는 있으면 여전히 완전 검증. |
| **`$transaction` 전체 교체** | 헤더 + 아이템 세트 전체를 원자적으로 스왑(`deleteMany` + `createMany`). |
| **Prisma 중첩 `create` + 관계 `connect`** | 각 라인의 placement를 공유 스칼라 대신 복합 유니크 `id_companyStoreId`로 붙임. |
| **`createMany` 대 중첩-생성 입력 타입** | 중첩 여부에 따라 같은 테이블에 두 개의 다른 생성 형태. |
| **중첩 라우트 컨트롤러 + `ParseUUIDPipe`** | `/corners/:cornerId/orders/:orderId` — 두 id 모두 경로에서. |
| **`@RequirePermissions`** | 새 권한 4개, `orders.{create,read,update,delete}` (총 39). |
| **`CornersService.assertWorksCorner` / `findOne`** | Phase 5의 유도된 소유권 재사용 — 쓰기는 코너 종사자, 읽기는 그 테넌트. |
| **seed 파생 역할 부여** (`PERMISSIONS.map(...)`) | ADMIN 권한을 드리프트 없이 DB 행으로 실체화; 와일드카드 분기 제거. |

## 마무리

Phase 7은 재입고-요청 서브시스템을 내놨다: 풀 CRUD + soft-delete를 갖춘 중첩 `Order` + `OrderItem` 애그리게이트, 단일 트랜잭션 안의 전체 교체 라인 수정, 경계에서의 아이템 ≥1 불변식, 그리고 ADMIN의 권한을 코드 분기에서 감사 가능한 DB 행으로 옮긴 조용하지만 의미 있는 리팩터. **유닛 테스트 148개 + e2e 47개, 전부 초록불.**

이번 Phase의 진짜 기념품은 복합 키 버그다. 테스트 피라미드에 층이 하나 이상인 이유의 깔끔한 증명이다: 유닛 테스트는 내 *로직*에 대해 빠르고 확신에 찬 피드백을 줬고, 하나하나 다 옳았다 — 하지만 그것들은 데이터베이스를 목으로 치워버리므로, 데이터베이스에만 존재하는 제약에 구조적으로 눈이 멀어 있었다. e2e는 더 느리고 쓰기도 덜 즐거웠지만, 건물 안에서 그걸 잡을 수 있는 유일한 것이었다.

**다음 — Phase 8: 재고 실사(inventory audits).** `InventoryAudit`와 `InventoryAuditItem` 테이블은 주문과 똑같은 코너-중첩·복합-FK 형태로 이미 스캐폴딩돼 있다. 하지만 실사는 가만히 앉아 있는 문서가 아니다 — 물리적 재고 카운트를 대사(reconcile)하는 것이야말로 Phase 6의 `record(..., { type: 'AUDIT' })`가 마침내 첫 진짜 호출자를 만나는 지점이다. 각 카운트된 라인을 진짜 수량으로 설정하면서. 이번 Phase에 재고를 움직이지 않던 엔진이 곧 일하러 나간다.
