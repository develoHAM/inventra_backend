# 소유 컬럼 없는 선반: 코너에 상품을 올리기

> Inventra Phase 5 — 카탈로그와 코너가 만나는 곳, 그리고 한 row가 company id 없이 소유되는 법을 배우는 곳.
> 2026-08-15

## 들어가며

Inventra는 한국의 편집숍/코너 모델을 기반으로 한 멀티테넌트 재고관리 SaaS다. 여러 회사가 물리적 매장 안의 "코너"를 운영한다. Phase 3는 카탈로그(*무엇을* 파는가)를, Phase 4는 코너(*누가 어디서 운영하는가*)를 만들었다. Phase 5는 그 둘의 연결이다: `CompanyStoreProduct` — 특정 코너의 선반에 재고 목표와 함께 올려진 상품. 평범한 CRUD처럼 보였다. 그런데 이번 단계는 *파생된(derived)* 소유에 대해, 그리고 soft-delete와 soft-delete를 모르는 데이터베이스 사이의 마찰에 대해 가장 많은 걸 가르쳐준 단계가 됐다.

## 아키텍처 결정들

### 1. 코너를 통한 소유 — company id가 없는 row

**목표.** 다른 모든 리소스처럼 placement를 테넌트 스코핑한다.
**문제.** `company_store_products`에는 `companyStoreId`와 `productId`는 있지만 **`companyId`가 없다**. 상품(`companyId`)이나 브랜드(`createdByCompanyId`)와 달리, placement에는 자기만의 소유 컬럼이 없다.
**선택지.** (a) 코너의 것을 비정규화해 `companyId`를 중복 추가; (b) 모든 쿼리를 join으로 스코핑(`where: { companyStore: { companyId } }`); (c) 코너를 먼저 resolve하고 — 이미 테넌트 스코핑돼 있으니 — 그 아래에서 작업.
**선택.** **(c)** — `CornersService`를 재사용한다. 모든 placement 연산은 corner 서비스의 이미-스코핑된 조회로 코너를 resolve한 뒤, `companyStoreId`로 placement를 필터한다. 코너가 *곧* 테넌트 경계다; 네 것임이 증명되면 그 선반도 네 것이다.
**이유.** 동기화할 비정규화 컬럼도, 쿼리마다 흩뿌려진 취약한 join도 없다. 소유는 이미 존재하는 곳에서, 딱 한 번 파생된다.
**결과.** 그리고 **중첩 URL**(`/corners/:cornerId/products`)에서 보너스가 떨어졌다: 코너 — 따라서 회사 — 가 *경로*에서 온다. 이건 ADMIN이 테넌트를 지정하는 방식을 바꿔놓았다(TIL 참고).

### 2. Soft-delete가 그걸 무시하는 unique 제약을 만나다

**목표.** placement를 하드 삭제하지 않고 "제거"하되(주문/재고 이력이 쌓이니까), 제거한 상품을 나중에 다시 올릴 수 있게 한다.
**마찰.** 테이블에는 `UNIQUE(product_id, company_store_id)`가 있다 — 코너당 상품 하나 — 그리고 이 제약은 **`deletedAt`을 모른다**. 그래서 soft-delete된 placement가 여전히 자리를 차지하고 있고, 같은 상품을 다시 insert하면 unique 인덱스에서 터진다.
**선택지.** (a) DB 제약을 없애고 비삭제 row들 사이에서 코드로 유일성 강제; (b) 재배치 시 409를 던지고 사용자가 수동으로 "재활성화"; (c) **revive** — create 시 `(product, corner)`에 soft-delete된 row가 있으면 insert 대신 그걸 un-delete.
**선택.** **(c) revive-on-replace.**
```ts
const existing = await this.prisma.companyStoreProduct.findFirst({
  where: { productId, companyStoreId: cornerId }, // soft-delete된 것 포함
});
if (existing && !existing.deletedAt) throw new ConflictException('Already placed');
if (existing) return this.prisma.companyStoreProduct.update({
  where: { id: existing.id },
  data: { ...fields, deletedAt: null, deletedByUserId: null }, // revive
});
return this.prisma.companyStoreProduct.create({
  data: { ...fields, companyStoreId: cornerId, productId },
});
```
**이유.** 제약을 유지하면 진짜 DB 불변식이 보존된다; revive는 "한때 제거한 상품을 다시 올리기"를 그냥 되게 하고, row의 하위 이력까지 보존한다. 제약을 없애면 데이터베이스 레벨의 보장을 애플리케이션 코드로 밀어올리게 된다.
**결과.** `create`는 세 가지 결과를 갖는다 — 409(live), revive(soft-delete됨), insert(신규) — 그리고 e2e는 삭제-후-재배치가 *같은 row id*를 돌려줌을 증명한다.

### 3. 형제 같은 두 인가 헬퍼, 일부러 떼어놓다

**목표.** 코너 연산을 올바른 사람에게 인가한다.
여기에 서로 다른 두 질문이 숨어 있었다:
- 코너의 **스태프 명부**를 관리할 수 있는 사람은? OWNER/ADMIN + 그 코너를 관리하는 MANAGER. 스태프는 절대 안 됨.
- 코너의 **선반**을 건드릴 수 있는 사람은? 위와 같음 — *더하기* 그 코너에 배정된 STAFF.

**선택지.** 플래그 하나 달린 헬퍼; 아니면 이름 붙은 헬퍼 둘.
**선택.** **둘.** `assertManages`(명부)와 `assertWorksCorner`(선반), 둘 다 `findOne` + 역할 검사 + 코너 반환.
```ts
async assertWorksCorner(caller, cornerId) {
  const corner = await this.findOne(caller, cornerId);       // 회사 스코핑 → 404
  if (caller.roleCode === 'MANAGER' && corner.managerUserId !== caller.id) throw new ForbiddenException();
  if (caller.roleCode === 'STAFF'   && caller.companyStoreId !== cornerId) throw new ForbiddenException();
  return corner;
}
```
**이유.** 불리언 플래그(`allowStaff`)는 두 보안 정책을 한 호출부로 뭉개고, 거기서 인자 하나 잘못 주면 조용히 접근이 넓어진다. 이름 둘은 의도를 놓칠 수 없게 만든다 — 그리고 심층 방어다: STAFF가 명부 엔드포인트에 (permission이 없어) 도달할 수 없더라도, 명부 헬퍼가 *또* 그들을 거부한다.
**결과.** placement는 `assertWorksCorner`를, 스태프 배정은 `assertManages`를 호출한다; 서로 혼동될 수 없다.

### 4. 혼자 남은 스태프와 배송 트럭

**목표.** STAFF가 선반을 바꿀 수 있는지 아예 정한다.
**결정을 지은 시나리오.** 배송이 도착했는데 코너에 있는 유일한 사람이 스태프다. placement를 만들 수 없다면, 매니저가 로그인할 때까지 선반이 현실을 반영하지 못한다.
**선택지.** STAFF 읽기 전용; STAFF가 회사 내 아무 코너나 쓰기; STAFF가 자기 배정 코너만 쓰기.
**선택.** **자기 배정 코너만 쓰기**(`caller.companyStoreId === cornerId`).
**이유.** 현실에 맞고(네가 배치된 코너를 네가 운영한다) 계층을 온전하게 유지한다 — 스태프가 갑자기 매니저(자기가 관리하는 코너로 row-스코핑됨)보다 강해지지 않는다. "아무 코너나 쓰기"는 STAFF가 MANAGER를 *앞지르게* 만드는데, 그건 거꾸로다.
**결과.** 이 때문에 `AuthUser`에 `companyStoreId`가 올라갔다 — 가드가 이제 그걸 select해서 STAFF-배정 검사가 비교할 대상을 갖는다. 실제 운영 워크플로를 열어준, 인증 계층의 작은 추가.

## TIL (Today I Learned)

**ADMIN 크로스테넌트 placement를 위해 create DTO에 `companyStoreId`(혹은 `companyId`)가 필요하지 않나?**
아니다 — 그리고 *왜* 인지 깨달은 게 이번 단계에서 가장 좋은 순간이었다. Phase 3–4에서 create 엔드포인트는 최상위(`POST /products`)라서 ADMIN이 대상 회사를 body에 명시해야 했다. 하지만 placement는 *중첩*(`POST /corners/:cornerId/products`)이다: 대상 코너가 URL에 있고, ADMIN의 스코핑 조회는 `{}`(회사 필터 없음)를 반환하니 ADMIN은 아무 코너나 id로 resolve할 수 있다. 회사는 resolve된 코너에서 떨어져 나온다. **중첩 리소스는 ADMIN의 타깃팅을 body 필드에서 경로로 옮긴다.**

**`assertCanManageStaff`가 일하는 동안 `assertManages`는 왜 죽은 코드였나?**
`assertManages`(`findOne` + 검사 + 코너 반환을 합친 것)를 추가해놓고 아직 연결하지 않았기 때문이다 — `addStaff`/`removeStaff`는 여전히 옛 *순수* `assertCanManageStaff`를 호출하고 있었다. 해법은 리팩터: 그들을 `assertManages`로 향하게 하고 옛것을 지운다. 교훈: 새 헬퍼를 추가하는 것과 호출부를 이주시키는 것은 두 단계이고, 반만 해두면 딱 "이거 왜 안 쓰이지?" 냄새가 난다.

**unique 제약이 재생성을 막는 row를 어떻게 soft-delete하나?**
제약과 싸우지 마라 — row를 *재사용*해라. `deletedAt`을 무시하는 `UNIQUE(product, corner)`는 soft-delete된 row가 여전히 자리를 소유한다는 뜻이니, "다시 올리기"는 "un-delete하기"가 돼야 한다. Revive-on-replace. (다른 고전적 답은 `WHERE deleted_at IS NULL`에 대한 partial unique index지만, revive는 row의 이력을 온전히 남기고, 어차피 우리가 원한 게 그거였다.)

## NestJS 개념 & 라이브러리

| 개념 / 라이브러리 | 왜 썼나 |
|---|---|
| 중첩 라우트 (`@Controller('corners/:cornerId/products')`) | placement는 코너의 선반; 코너(와 테넌트)가 경로에서 온다. |
| 크로스모듈 DI + `exports` | `PlacementsModule`이 `CornersService` + `ProductsService`를 주입; 두 모듈이 export해야 했다. |
| Fetch-then-decide (`findInCompany`, `assertWorksCorner`) | 소유 서비스가 resolve/검증; 호출자가 400/403/404를 결정. |
| `@RequirePermissions('placements.*')` + row 검사 | 가드에서 거친 RBAC, 서비스에서 row 단위(관리/배정) 규칙. |
| Prisma soft-delete + revive | `deletedAt`/`deletedByUserId`; un-delete로 unique 제약을 화해시킴. |
| `@nestjs/mapped-types` `OmitType`/`PartialType` | `UpdatePlacementDto`가 `productId`를 뺀다 — placement의 상품은 바꾸지 않는다. |
| `class-validator` (`@IsUUID`, `@IsInt`, `@Min`, `@IsBoolean`) | placement 필드의 경계 검증. |
| `ParseUUIDPipe` + `ParseIntPipe` | `cornerId`는 UUID, `placementId`는 int. |
| Jest + supertest | 유닛은 두 소유 서비스를 mock; e2e는 전체 중첩 흐름을 구동. |

## 마무리

Phase 5는 *파생된* 것들에 관한 것이었다: 컬럼 대신 코너에서 파생된 소유, body 대신 URL에서 파생된 ADMIN 타깃, 옛것을 되살려 파생된 "새" placement. 카탈로그와 코너가 드디어 연결됐다 — 상품이 특정 선반에 재고 목표와 함께 앉을 수 있고, 실제로 그 코너를 운영하는 사람이 큐레이션한다.

**다음 — Phase 6: 재고 트랜잭션(inventory transactions).** 지금까지 모든 수량은 *계획*(`targetStockQuantity`)이었다. Phase 6는 실제 재고 — `currentQuantity`, `sampleQuantity`, `reservedQuantity` — 를 하나의 중앙 집중 쓰기로 움직인다. Phase 4부터 미뤄온 원자적 `updateMany`/`$transaction` 패턴이 드디어 타협 불가가 되는 지점이다: 두 요청이 같은 선반을 동시에 차감하면, check-then-act 경쟁은 곧 초과 판매(oversell)이고, 초과 판매는 곧 환불이다.
