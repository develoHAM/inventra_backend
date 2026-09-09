# 엔진에게 '잡아두기'를 가르치다

> Inventra Phase 9 — 재고 엔진이 네 번째 버킷을 배우고, 예약이 알고 보니 '판매가 되는 홀드'였으며, 빌드 도중의 질문 하나가 리소스 전체를 한 단계 위로 옮기는 단계.
> 2026-09-09

## 들어가며

Inventra는 한국의 편집숍/코너 모델을 기반으로 한 멀티테넌트 재고관리 SaaS다 — 회사들이 물리적 매장 안에서 "코너"를 운영한다. Phase 6은 재고를 *움직이는* 엔진을 만들었고, Phase 8은 재고를 *대사(reconcile)하는* 법을 가르쳤다. Phase 9는 재고를 **잡아두는(hold)** 법을 가르친다 — 구매 예약은 어떤 상품의 `reservedQuantity`만큼을 이름이 지정된 고객을 위해, 그가 찾아갈 때까지 따로 빼둔다. Phase 6 effect map에 손을 뻗어 새로운 것을 추가한 첫 Phase이고, 각각 답의 모양을 바꾸는 자잘한 모델링 결정들로 가득했다.

## 아키텍처 결정들

### 1. 생성 시 홀드 — 예약이 곧 홀드다

**목표.** 예약이 언제부터 재고를 보호하기 시작할지 정하기.

**선택지.** (a) **생성 시 홀드** — 예약 생성이 즉시 `available → reserved`를 옮겨서, 재고가 실제로 잡혀 있을 때만 행이 존재한다. (b) **두 단계** — 아무것도 잡지 않는 `PENDING` 요청을 만들고, 별도의 `confirm`이 `RESERVED`로 옮기며 재고를 잡는다("요청이 들어오고, 직원이 재고 확정 전에 심사"를 모델링).

**선택.** **(a) 생성 시 홀드.** `POST /reservations`가 가드된 `available → reserved`를 돌리고 행을 `RESERVED`로 시작한다. available이 부족하면 `409`이고 아무것도 저장되지 않는다.

**이유.** 워크업이나 전화 예약에서 "지금 잡아라"가 곧 그 연산이다 — "예약하고 싶다"와 "홀드가 활성이다"를 분리하는 건, 확정되지 않은 요청들이 사람의 심사 전에 진짜로 재고를 두고 경쟁할 때만 값어치를 하는데 이 매장 흐름은 아니다. 생성 시 홀드는 깔끔하고 검증 가능한 **불변식**도 준다: `reserved` 버킷은 언제나 활성 예약들의 합과 같다. 잡힌 모든 단위는 실제 행으로 뒷받침되고, 그 역도 성립한다.

**결과.** 네 상태가 아니라 두 상태 기계(`RESERVED → {FULFILLED, CANCELLED}`), 그리고 `PENDING`/`EXPIRED`는 요청 채널이나 만료 스윕이 실제로 필요해질 날을 위해 정의만-된-채-미사용으로 남겼다.

### 2. 이행(fulfillment)은 판매다

**목표.** 고객이 잡아둔 물건을 찾아갈 때 무슨 일이 일어나는지 기록하기.

**하마터면 배포할 뻔한 결함.** 첫 설계는 이행에 자체 트랜잭션 타입 `RESERVATION_FULFILL`(단순 `reserved −q`)을 줬다. 하지만 그건 **구매된 물건이 두 가지 방식으로 추적**됨을 뜻한다: 워크인 판매는 `SALE`(`available −q`), 예약 구매는 `RESERVATION_FULFILL`(`reserved −q`). "총 판매 수량"은 영원히 `SALE ∪ RESERVATION_FULFILL`이 되고 — 예약 구매는 절대 판매로 잡히지 않는다.

**선택지.** (a) `reserved`를 감소시키는 전용 `RESERVATION_FULFILL`. (b) 예약을 소매에서의 실체 그대로 모델링 — **판매로 전환되는 홀드**: 이행은 홀드를 풀고 그다음 판다.

**선택.** **(b).** 이행은 원자적으로 `RESERVATION_RELEASE`(`reserved → available`) **+ `SALE`**(`available → out`)을 기록한다.

**이유.** 이제 **모든 구매가 `SALE`**이다 — 워크인이든 예약이든 — 그래서 "판매 수량"이 한 쿼리다. 그리고 잃는 게 없다: 이행의 `SALE`은 `source = RESERVATION`을 달고(워크인 `SALE`은 `source = null`) 예약-출처 판매를 필터 가능하게 유지한다. 균일성 *과* 귀속 둘 다. 게다가 `SALE`을 재사용하므로 새 트랜잭션 타입이 하나 *덜* 필요하다.

**결과.** 원장이 정직한 이야기를 한다 — 그 단위는 잡혔고, 풀렸고, 팔렸다 — 그리고 판매를 세는 모든 리포팅 쿼리가 특수 처리 없이 그냥 동작한다.

### 3. Effect map 확장 — 네 번째 버킷

**목표.** 엔진이 `reserved`를 건드릴 수 있게 하기 (이전엔 못 했다 — `Bucket` 타입이 `available | sample | damaged`였다).

**선택지.** (a) `ReservationsService` 안에 전용 reserved-버킷 로직 작성. (b) **Phase 6 effect map 확장** — `Bucket`을 `reservedQuantity` 포함으로 넓히고 새 움직임을 데이터로 추가.

**선택.** **(b).** 홀드는 `BREAKAGE`나 `SAMPLE_ALLOCATION`과 구조적으로 동일하다 — 버킷 간, 가드-먼저 움직임 — 그저 다른 버킷으로 갈 뿐:
```ts
RESERVATION_HOLD: {                          // available → reserved
  deltas: [{ field: 'availableQuantity', sign: -1 },   // 가드: available 충분한가?
           { field: 'reservedQuantity',  sign: +1 }],
  primaryBucket: 'availableQuantity',
},
RESERVATION_RELEASE: {                        // reserved → available
  deltas: [{ field: 'reservedQuantity',  sign: -1 },   // 가드: 잡힌 게 충분한가?
           { field: 'availableQuantity', sign: +1 }],
  primaryBucket: 'reservedQuantity',
},
```

**이유.** 이것들이 effect map의 두 행일 뿐이라서, Phase 6 기계 전체를 공짜로 상속한다 — `$transaction`, 가드된 `updateMany`(그래서 초과예약이 초과판매와 똑같은 깔끔한 `409`), 원장 append. 새 원자적-쓰기 코드가 없다. 그리고 `EFFECTS`는 **컴파일러-강제 total `Record<InventoryTransactionType, Effect>`**라, enum 값을 추가하는 순간 두 effect가 둘 다 존재할 때까지 빌드가 컴파일을 거부한다 — 타입 시스템이 하나를 잊게 놔두지 않는다.

**결과.** "엔진에게 홀드를 가르쳐라"가 데이터 두 항목과 넓어진 union으로 줄었다. 이름조차 자체 교정을 받았다 — 타입은 명사(`RESERVATION_HOLD`, `RESERVATION_RELEASE`와 짝)로 나머지 enum과 맞췄지, 동사 `RESERVE`가 아니다.

### 4. 코너 레벨, placement-중첩이 아니라

**목표.** 예약 리소스가 URL 트리에서 어디에 살지 정하기.

**시작점.** placement-중첩 — `/corners/:cornerId/products/:placementId/reservations`, 예약이 한 placement의 재고에 관한 것이니 transactions 엔드포인트를 미러링.

**그걸 옮긴 질문.** *"카운터 직원이 코너의 모든 예약을 보고 싶으면?"* — 모든 상품에 걸친 픽업 데스크 뷰. placement-중첩은 모든 placement를 순회하지 않고는 그걸 못 준다.

**선택.** **리소스 전체를 코너 레벨로 이동** — `/corners/:cornerId/reservations`. 코너-전체 목록이 기본 `GET`이 되고, placement별은 `?companyStoreProductId=` 필터(그리고 활성 픽업 목록용 `?status=RESERVED`)가 된다. `companyStoreProductId`는 생성 바디에 타고, `fulfill`/`cancel`은 `:reservationId`만 받는다(행이 이미 자기 placement를 안다).

**이유.** 예약은 placement를 *참조하는* 코너-스코프 레코드다 — 한 placement 재고의 *이벤트인* 트랜잭션과 달리. 실세계의 주된 뷰가 코너-전체이니, 그게 자연스러운 모양이어야지 팬아웃으로 조립하는 게 아니어야 한다. 이 이동은 작은 질문도 깔끔하게 풀었다: 코너 레벨에서 `companyStoreProductId`는 진짜로 요청 바디에 속한다.

**결과.** `GET /corners/:cornerId/reservations` 하나가 카운터의 실제 질문에 답하고, placement별·상태별 뷰는 필터로 떨어져 나온다.

## TIL (Today I Learned)

**생성 시 홀드 대 두 단계 — 실제로 뭐가 다른가?** *재고가 언제부터 보호되기 시작하는가.* 생성 시 홀드는 예약이 존재하는 순간 보호한다(행과 홀드가 같은 것). 두 단계는 "예약하고 싶다"(`PENDING`, 아무것도 보호 안 함)와 "홀드가 활성"(`RESERVED`)을 분리한다 — 사람이 확정하기 전에 미확정 요청들이 재고를 두고 경쟁할 때만 값어치가 있다. 요청 시 그냥 물건을 잡아두는 매장에는 그 중간 상태가 안 쓰는 기계다.

**`prisma generate` 대 `prisma migrate dev`.** 이걸 어렵게 배웠다: enum 값을 추가한 뒤 (나 혹은 에디터가) `prisma generate`를 돌렸고, 빌드가 초록불이 됐고, 스키마 변경이 끝났다고 착각했다. 아니었다. **`generate`**는 *스키마로부터* TS 클라이언트를 재생성해 코드가 컴파일되게 한다; **`migrate dev`**는 스키마를 *데이터베이스*에 대해 diff하고, SQL 마이그레이션을 쓰고, 적용한다. 클라이언트는 새 enum과 컬럼을 알았지만 Postgres는 몰랐다. 유닛 테스트(목)는 통과, 빌드도 통과, 실제 insert만이 실패했을 것이다. generate는 코드를 컴파일되게, migrate는 데이터베이스를 실제가 되게 만든다.

**`createdAt`과 `updatedByUserId`가 필요한가?** 둘 다 아니다, 좋은 이유로. `reservedAt`이 이미 생성 타임스탬프다, 도메인 이름으로. 그리고 일반적 `updatedByUserId`는 관례에 어긋나고(코드베이스는 전이별로 행위자를 이름 짓는다 — `deletedByUserId`, `appliedByUserId`) *동시에* 중복이다: 모든 예약 재고 움직임은 `recordWithinTransaction`을 통과하고, 그건 행위자와 `source = RESERVATION`을 찍으니 "누가 이걸 이행/취소했나"가 이미 원장에 산다. `createdByUserId`는 제 밥값을 한다("예약을 넣었다"에 해당하는 원장 행이 없으니); 전이-행위자들은 아니다.

**`companyStoreProductId`가 생성 DTO에 속하나?** 전적으로 라우트 레벨에 달렸다 — 그리고 그게 힌트다. placement-중첩 라우트에서는 경로에서 오니 *아니오*; 코너-레벨 라우트에서는 바디에서 오니 *예*. 이 질문이 나온다는 것 자체가 리소스가 코너-레벨이 되고 싶다는 신호였다.

## NestJS 개념 & 라이브러리

| 개념 / 도구 | Phase 9에서 등장한 이유 |
|----------------|------------------------------|
| **컴파일러-total `Record<Enum, T>`** | enum 값 추가가 effect map이 매핑할 때까지 빌드를 깬다 — 타입 시스템이 완전성을 강제. |
| **Prisma enum 마이그레이션** | 새 enum 값은 `migrate dev`(스키마→DB)가 필요하다, `generate`(스키마→클라이언트)만으로는 안 됨. |
| **`@Query()` + 쿼리 DTO + `@Type`** | 코너-전체 목록 필터(`?companyStoreProductId`/`?status`)를 쿼리 문자열에서 검증·강제. |
| **액션 서브리소스** (`POST :id/fulfill` / `cancel`) | 예약의 비-CRUD 상태 전이. |
| **`recordWithinTransaction` 재사용** | 예약은 Phase 8 헬퍼의 세 번째 호출자; `ReservationsModule`이 `InventoryService`를 주입. |
| **가드된 `updateMany`** | Phase 6에서 상속 — 초과예약이 초과판매와 같은 깔끔한 `409`. |
| **리소스 고도(중첩 대 코너-레벨)** | 예약은 placement *이벤트가 아니라* placement를 *참조*하므로 코너 레벨에 산다. |

## 마무리

Phase 9는 구매 예약을 내놨다: 가드된 `available→reserved`의 생성 시 홀드, 모든 구매가 `SALE`이 되도록 풀고-그다음-파는 이행, 픽업 데스크 목록을 갖춘 코너-레벨 리소스, 그리고 — 핵심으로 — Phase 6 effect map을 네 번째 버킷으로 확장한 첫 사례. **유닛 테스트 166개 + e2e 62개, 전부 초록불, e2e는 첫 실행에 통과.**

만족스러운 부분은 새 *기계*가 얼마나 적게 들었는가다. 엔진에게 완전히 새로운 행동 — 재고를 잡아두기 — 를 가르치는 게 union을 넓히고 테이블에 두 행을 추가하는 걸로 줄었다. 어려운 부분들(원자적 쓰기, 초과판매 가드, 불변 원장)이 재사용되도록 지어졌으니까. Phase 6 투자가 세 번째 배당을 내는 것이다.

**다음 — Phase 10: 횡단 관심사(cross-cutting concerns).** 일부러 남겨둔 느슨한 실이 있다: `expiresAt`. 예약은 만료를 가질 수 있지만, 아직 아무것도 그걸 풀지 않는다. 자연스러운 첫 잡(job)은 스케줄된 **자동 만료 스윕** — `expiresAt`을 지난 `RESERVED` 홀드를 찾아 풀어주는(`RESERVATION_RELEASE` → `EXPIRED`) `@nestjs/schedule` 태스크로, 똑같은 엔진을 한 번 더 재사용한다. 이번 Phase에 잡아두기를 배운 엔진이 곧 타이머에 맞춰 놓아주기를 배운다.
