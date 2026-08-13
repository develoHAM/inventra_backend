# 이 코너, 누가 운영하지? 서브 리소스, 싱글턴, 그리고 row 단위 규칙

> Inventra Phase 4 — 회사가 매장 안의 코너를 운영하는 계층 만들기. 매니저 한 명과 스태프 여러 명이 있는 그 코너.
> 2026-08-13

## 들어가며

Inventra는 한국의 편집숍/코너 모델을 기반으로 한 멀티테넌트 재고관리 SaaS다. 여러 회사가 물리적 매장 안의 "코너"를 운영한다. Phase 3는 카탈로그(*무엇을* 파는가)를 만들었다. Phase 4는 그 아래 계층을 만든다 — **매장(store)**(어디서)과 **코너(corner)**(누가 어디서 운영하는가). 매장은 공유 공간이고, 코너는 그 안에 있는 한 회사의 존재이며, 매니저와 스태프를 가진다. 이번 단계는 새로운 프레임워크 기능보다는 *모델링*에 관한 것이었다 — REST의 형태, 소유 모델, 그리고 permission만으로는 표현할 수 없는 row 단위 규칙.

## 아키텍처 결정들

### 1. 또다시 두 개의 소유 모델 — 전역 매장, 소유된 코너

**목표.** 여러 회사가 공유하는 공간과, 그 안에 있는 각 회사의 사적인 존재를 모델링한다.
**선택지.** 전부 전역으로; 전부 회사 소유로; 아니면 분리.
**선택.** **매장은 전역**(ADMIN이 관리하는 참조 데이터, Phase 3의 Categories처럼); **코너는 회사 소유**이고 테넌트 스코핑을 받는다.
**이유.** 백화점은 여러 회사가 코너를 임대해 들어가는 하나의 물리적 건물이다 — 공유 인프라이고, 모두에게 동일한 사실이다. 코너는 사적이다. 편집숍 도메인이 이 분리에 그대로 대응된다.
**결과.** `StoresService`는 `CategoriesService`의 거의 복사본이 됐다(스코핑 없음; 쓰기는 permission 그랜트로 ADMIN에 한정). `CornersService`는 `OwnershipService.scopeToCompany`를 재사용한다 — 그리고 코너의 소유 컬럼이 `companyId`(헬퍼의 기본값)이기 때문에, 커스텀 컬럼명이 필요했던 Brands보다도 더 간단하다.

### 2. 매니저는 싱글턴, 스태프는 컬렉션

**목표.** "코너의 매니저를 지정한다"와 "스태프를 추가/제거한다"를 깔끔한 HTTP로 노출한다.
**선택지.** 전부 `PATCH /corners/:id`에 욱여넣기; 아니면 매니저 + 스태프를 서브 리소스로 모델링.
**선택.** **카디널리티로 형태가 결정되는 서브 리소스.** 매니저(코너당 하나)는 `PUT`하는 싱글턴, 스태프(코너당 여러 명)는 `POST`로 추가하고 `DELETE`하는 컬렉션.

| 관계 | 카디널리티 | 동사 |
|---|---|---|
| manager (`managerUserId`) | 하나 (0..1) | `PUT /corners/:id/manager` |
| staff (`User.companyStoreId`) | 여럿 (0..N) | `POST /corners/:id/staff`, `DELETE /corners/:id/staff/:userId` |

**이유.** `PUT`은 "이 단일 값 슬롯을 정확히 이걸로 교체해라"라는 뜻이고, 멱등(idempotent)하다 — 재시도해도 안전하다. `PATCH`는 리소스에 대한 부분 델타를 위한 것인데, 코너의 name/description을 수정하는 게 바로 그것이다. 동사를 관계의 *형태*에 맞추면 API가 예측 가능해진다.
**결과.** 작고 단일 목적인 엔드포인트 세 개, 각자 자기 검증과 자기 permission을 가진다 — 뭘 보냈는지에 따라 분기해야 하는 과부하된 `PATCH` 하나 대신.

### 3. MANAGER 역할이 드디어 관리한다 — 단, 자기 코너만

**목표.** 매장 매니저가 자기 코너의 인원을 운영하게 하되, 남의 것까지 운영하지는 못하게 한다.
**선택지.** 거친 permission(아무 매니저나 아무 코너에 스태프 배치); 아니면 row 단위 규칙.
**선택.** **row 단위.** MANAGER는 `corners.assign`을 가지지만, 서비스가 조건을 더한다: 실제로 자기가 관리하는 코너의 스태프만 건드릴 수 있다.

```ts
private assertCanManageStaff(caller: AuthUser, corner: { managerUserId: string | null }) {
  if (caller.roleCode === 'MANAGER' && corner.managerUserId !== caller.id)
    throw new ForbiddenException('You can only manage staff of corners you manage');
  // OWNER / ADMIN은 통과
}
```

**이유.** 이건 Phase 3의 생성자 스코프 상품 삭제와 똑같은 형태다 — 이분법적 permission(*이 역할이 배치할 수 있는가?*) + row 단위 소유 검사(*이 row가 네 것인가?*). 그리고 시드된 MANAGER 역할이 문자 그대로 말하는 바다: *"company_store와 그 구성원을 관리한다."* 다만 *매니저 자체를 임명*하는 것은 OWNER/ADMIN 전용으로 남는다 — 매니저가 스스로를 임명하면 안 되니까 — 그래서 `PUT /manager`는 MANAGER 호출자에게, 같은 `corners.assign`을 가지고 있어도 403을 던진다.
**결과.** permission 하나, 동작 두 가지, 서비스 안의 `roleCode`/row 검사 몇 줄로 갈린다. permission 테이블은 단순하게 유지되고, 미묘함은 row가 있는 곳에 산다.

### 4. Fetch-then-decide, 세 서비스에 걸쳐 재사용

**목표.** 서비스들을 서로 얽히게 하지 않으면서 코너의 `storeId`와 배정 대상 유저를 검증한다.
**선택.** 각 소유 서비스가 **row-or-null 조회**를 노출하고, `CornersService`가 에러를 결정한다. `StoresService.findActive(id)`와 `UsersService.findActiveMember(userId, companyId)`는 절대 예외를 던지지 않는다; Corners가 그 `null`을 `400`으로 바꾼다.
**이유 / 결과.** Phase 3와 같은 패턴 — 소유 서비스가 조회와 그 스코핑을 소유하고, 호출자가 정책을 소유한다. 여기에 작은 DI 교훈도 딸려 왔다: `CornersModule`이 `UsersService`를 주입하려면 `UsersModule`이 먼저 `exports: [UsersService]`를 해야 했다. provider는 export하기 전까지 자기 모듈 안에서만 사적이다.

## TIL (Today I Learned)

**매니저 지정에 `PUT`이야 `PATCH`야?**
`PUT`. 매니저는 단일 값 슬롯이다; 지정한다는 건 그걸 통째로 *교체*하는 것이고, 같은 유저로 두 번 해도 결과가 같은 멱등 연산이다 — 둘 다 `PUT`의 일이다. `PATCH`는 리소스에 대한 부분 업데이트용이다(코너 name 수정 같은). "통째로 교체"냐 "델타 병합"이냐에 동사를 맞춰라.

**ADMIN만 삭제할 수 있는 매장에 `deletedByUserId`가 필요한가?**
뺄 뻔했다 — 어차피 admin만 삭제하면 "누가"는 고정된 것처럼 보인다. 두 가지가 마음을 돌렸다: `users` 테이블은 *여러* admin을 허용하고, *공유* 매장을 삭제하는 것은 시스템에서 가장 파급이 큰 삭제다(모든 회사의 코너가 거기 매달려 있다). "40개 회사가 의존하던 그 공간을 어느 admin이 지웠는가"야말로 감사 컬럼이 존재하는 이유다. 그래서 남겼다. 교훈: 감사 컬럼의 가치는 그 행동을 트리거할 수 있는 사람 수가 아니라 그 행동의 *폭발 반경*에 비례한다.

**`update`/`delete`에서 검사와 쓰기 사이의 경쟁 상태는 어떻게 다루나?**
`findOne`(검사)과 `update({ where: { id } })`(실행) 사이에 TOCTOU 틈이 있다. 핵심 깨달음은, 여기서는 코너의 `companyId`가 불변이기 *때문에* 안전하다는 것이다 — 검사가 "네 것"임을 증명했다면 쓰기 시점에도 여전히 네 것이라, 그 창(window) 안에서 테넌트 경계가 넘어갈 수 없다. 남는 경쟁은 무해한 것뿐이다(방금 삭제된 row를 수정하는 정도). 정말 빈틈없이 막아야 할 때의 방법은 가드를 쓰기 안으로 접어 넣는 것이다 — `updateMany({ where: { id, ...scope, deletedAt: null }, data }).count` — 검사와 실행을 하나의 원자적 SQL 문으로 만든다. 이건 Phase 5 재고를 위해 아껴둔다. 거기서는 lost update가 곧 잘못된 재고 수량이고, 진짜 돈이다.

**`tsc`가 통과했으니 타입은 괜찮은 거지?**
아니다. `company_stores.name`을 NOT NULL로 만들었는데 `CreateCornerDto.name`은 optional로 남겨뒀고, `tsc`는 초록불이었다 — Prisma의 `create` 입력이 `XOR<…>` 조건부 타입이라 그런 종류의 불일치를 가려버린다. 하지만 런타임에서, `name`을 빠뜨린 요청은 검증을 통과해버리고 깔끔한 `400` 대신 DB에서 `500`을 낸다. 타입 체크 초록불 ≠ 동작 정상. DTO는 결국 손으로 조여야 했다.

## NestJS 개념 & 라이브러리

| 개념 / 라이브러리 | 왜 썼나 |
|---|---|
| 서브 리소스 라우트 (`:id/manager`, `:id/staff`의 `@Put`/`@Post`/`@Delete`) | 일대일 vs 일대다 관계를 싱글턴 vs 컬렉션으로 모델링. |
| `@RequirePermissions('corners.assign')` + row 검사 | 가드에서 거친 RBAC, 서비스에서 세밀한 row 규칙. |
| `OwnershipService.scopeToCompany` (기본 컬럼) | 코너의 소유 컬럼은 `companyId` — 기본값 — 이라 스코핑이 한 줄. |
| 크로스모듈 DI + `exports` | `CornersModule`이 `StoresService` + `UsersService`를 주입; provider는 공유하려면 export해야 한다. |
| `@nestjs/mapped-types` `PartialType`/`OmitType` | `UpdateCornerDto`가 `companyId`/`storeId`/`managerUserId`를 빼서 `PATCH`가 코너를 옮기거나 매니저 규칙을 우회하지 못하게. |
| `class-validator` (`@IsUUID`, `@IsNotEmpty` 등) | 경계 검증 — 그리고 NOT NULL / optional-DTO 교훈이 문 곳. |
| `ParseUUIDPipe` | 매장/코너 id는 UUID. |
| Prisma `updateMany` (+ `count`) | 원자적 검사-실행 가드 — Phase 5용으로 아껴둠. |
| Prisma named relations + soft delete | 매장/코너의 `deletedByUser`; `deletedAt` 필터 읽기. |
| Jest + supertest | 유닛은 Prisma를 mock; e2e는 실제 HTTP로 라우팅 + 가드를 통과. |

## 마무리

Phase 4는 모델링 단계였다. 새로운 프레임워크 기계장치는 없었다 — 대신 *형태*에 관한 세 가지 교훈: HTTP 동사를 관계의 카디널리티에 맞춰라(싱글턴은 `PUT`, 컬렉션은 `POST`/`DELETE`); 특정 row에 의존하는 규칙은 permission 아래, 서비스로 밀어 넣어라; 그리고 타입 체크 초록불이 런타임 초록불은 아니라는 것. 이제 코너는 매니저와 인원을 가지고, 매니저는 자기 구역만 운영하고 남의 것은 못 건드리도록 스코핑되어 있다.

**다음 — Phase 5: 상품 배치(product placement).** 카탈로그가 있고(Phase 3), 코너가 있고(Phase 4), 이제 둘이 만난다: `CompanyStoreProduct`가 특정 코너의 선반에 상품을 재고 목표와 함께 올린다. 미뤄둔 원자적 `updateMany` 가드가 더 이상 선택이 아니게 되는 지점이다 — 재고 수량은 경쟁 상태가 돈으로 환산되는 곳이다.
