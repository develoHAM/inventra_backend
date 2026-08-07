# 권한이 있는가, 그리고 네 것인가? 멀티테넌트 상품 카탈로그 만들기

> Inventra Phase 3 — 2단 인가(authorization)가 드디어 실제 기능과 만나는 지점.
> 2026-08-07

## 들어가며

Inventra는 한국의 편집숍/코너 모델을 기반으로 한 멀티테넌트 재고관리 SaaS다. 여러 회사가 물리적 매장 안의 "코너"를 운영하는 구조다. 앞선 두 단계는 데모로 보여줄 수 없는 배관 작업이었다. Phase 1은 인증(토큰 2개와 join code), Phase 2는 인가(`PermissionsGuard` + 테넌트 스코핑을 담당하는 `OwnershipService`)였다.

Phase 3는 그 배관에 처음으로 실제 물이 흐르는 단계다 — 카테고리, 브랜드, 상품으로 이루어진 **상품 카탈로그**. 이제부터 모든 요청은 두 개의 서로 다른 질문에 답해야 한다.

- **권한이 있는가? (Can you?)** — 해당 permission을 가지고 있는가? (`@RequirePermissions`)
- **네 것인가? (Is it yours?)** — 이 row가 네 회사의 것인가? (`OwnershipService`)

카탈로그는 이 두 질문이 처음으로 정면충돌하는 곳이고, 흥미로운 설계는 대부분 그 둘 *사이의 틈*에 있었다.

## 아키텍처 결정들

### 1. 리소스 셋, 소유 모델 둘

**목표.** 상품이 브랜드와 카테고리를 참조하는 카탈로그를 모델링한다 — 단, 모든 리소스가 특정 테넌트에 속하는 것은 아니다.

**선택지.** (a) 전부 회사 소유로; (b) 전부 전역으로; (c) 전역 참조 데이터 + 회사 소유 데이터를 섞는다.

**선택.** 혼합. **카테고리는 전역(global)** — 공유 계층 구조이고, ADMIN이 관리하며, 모든 역할이 읽을 수 있다. **브랜드와 상품은 회사 소유**이고 테넌트 스코핑을 받는다.

**이유.** "음료" 같은 카테고리는 모든 테넌트에게 동일한 사실이다. 회사마다 복제하면 그저 노이즈일 뿐이다. 반면 브랜드나 상품은 그 회사의 사적인 재고다. *데이터의 성격*이 소유 모델을 결정하는 것이지, 일관성에 대한 집착이 결정하는 게 아니다.

**결과.** 카테고리는 테넌트 스코핑을 아예 건너뛰고(쓰기는 permission으로 ADMIN 전용, 읽기는 전체 개방), 브랜드와 상품은 `OwnershipService`를 거친다. 하나의 도메인, 명확히 구분된 두 절반 — 그리고 상품은 그 둘을 각각 하나씩 참조하며 자연스럽게 잇는다.

### 2. 스코핑 헬퍼 하나, 소유 컬럼 둘

**목표.** 상품(소유 컬럼 `company_id`)과 브랜드(소유 컬럼 `created_by_company_id`)를 하나의 헬퍼로 테넌트 스코핑한다.

**선택지.** (a) 메서드 두 개; (b) 컬럼명을 파라미터화.

**선택.** Phase 2의 헬퍼에 선택적 필드명을 추가한다.

```ts
scopeToCompany(user: AuthUser, field = 'companyId'): Record<string, string> {
  if (user.roleCode === 'ADMIN') return {};              // ADMIN: 필터 없음, 전체 조회
  if (!user.companyId) throw new ForbiddenException();    // 회사 유저는 companyId 필수
  return { [field]: user.companyId };                     // 자기 회사로 고정
}
```

상품은 `scopeToCompany(caller)`, 브랜드는 `scopeToCompany(caller, 'createdByCompanyId')`를 호출한다.

**이유.** 로직은 완전히 동일하다 — ADMIN은 전부 보고, 회사 유저는 자기 `companyId`에 고정되며, 회사 없는 유저는 거부된다. 오직 *컬럼*만 다르다. 기본값 파라미터 덕분에 Phase 2의 모든 호출부는 수정 없이 그대로 컴파일된다.

**결과.** Prisma `where`에 그대로 펼쳐 넣으면 모든 조회에서 테넌트 경계가 강제된다.

```ts
where: { ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'), deletedAt: null }
```

단건 조회도 *스코핑된* `findFirst`를 쓰기 때문에, 다른 테넌트의 id는 그냥 `null` → 404가 된다. 존재 여부 노출도 없다 — 남의 회사 브랜드가 존재하는지조차 확인할 수 없다.

### 3. Fetch-then-decide: 에러는 누구의 것인가?

가장 마음에 드는 결정이고, 만들다가 던진 질문에서 그대로 나왔다.

**목표.** 상품 생성 시 참조하는 브랜드가 호출자의 회사 소유인지, 그리고 카테고리가 존재하는지 검증해야 한다. 이 검증은 어디에 살아야 하는가?

**선택지.** (a) `ProductsService`가 브랜드/카테고리 테이블에 직접 접근; (b) `BrandsService`/`CategoriesService`가 없으면 *예외를 던지는* `assert…()` 메서드를 노출; (c) 그냥 **row 또는 null**을 돌려주는 조회를 노출하고, `null`의 의미는 `ProductsService`가 결정.

**선택.** (c). 각 소유 서비스는 절대 예외를 던지지 않는 조회를 노출한다.

```ts
// BrandsService — 회사로 스코핑, row 또는 null 반환
findInCompany(brandId: number, companyId: string) {
  return this.prisma.brand.findFirst({
    where: { id: brandId, createdByCompanyId: companyId, deletedAt: null },
  });
}
```

```ts
// ProductsService.create — 여기서 "없음"은 400이라고 결정한다
const brand = await this.brands.findInCompany(data.brandId, companyId);
if (!brand) throw new BadRequestException('Invalid brand');

const category = await this.categories.findActive(data.categoryId);
if (!category) throw new BadRequestException('Invalid category');
```

**이유.** "없음(not found)"은 호출자에 따라 의미가 다르다. URL로 브랜드를 조회하는 사람에게 없는 브랜드는 **404**다. 상품 생성 입장에서 없는(혹은 다른 테넌트의) 브랜드는 **400**이다 — *네가 잘못된 참조를 넘겼어*. 만약 `BrandsService`가 `NotFoundException`을 던졌다면, `ProductsService`는 상태 코드를 고치려고 catch-후-rethrow를 해야 한다. 소유 서비스가 **찾고**(테넌트 스코핑까지 내장한 채), 호출 서비스가 **결정하게** 두면 각 에러 의미가 있어야 할 자리에 정확히 놓인다.

**결과.** 관심사가 깔끔하게 분리된다: 브랜드/카테고리는 *조회*(와 그 스코핑)를, 상품은 *생성 정책*을 소유한다. 게다가 `BrandsService.findInCompany`는 재사용된다 — `update()`도 바뀐 브랜드를 상품의 회사 기준으로 같은 호출로 재검증한다.

### 4. 생성자 스코프 삭제: RBAC를 넘어선 row 단위 규칙

**목표.** 매니저가 상품을 삭제하게 하되, 자기가 만든 것만.

**선택지.** (a) `products.delete.own` permission을 새로 만든다; (b) row를 가져온 뒤 서비스에서 확인한다.

**선택.** MANAGER는 그냥 `products.delete`를 가지고, 서비스가 row 단위 가드를 더한다.

```ts
async remove(caller: AuthUser, id: string) {
  const product = await this.findOne(caller, id); // 회사 스코핑 → 남의 것이면 404
  if (caller.roleCode === 'MANAGER' && product.createdByUserId !== caller.id) {
    throw new ForbiddenException('You can only delete products you created');
  }
  return this.prisma.product.update({
    where: { id },
    data: { deletedAt: new Date(), deletedByUserId: caller.id },
  });
}
```

**이유.** permission은 *이분법적* 질문에 답한다: "이 역할이 상품을 삭제해도 되는가?" "…단, 자기 것만"은 표현할 수 없다. 그건 특정 row에 달린 사실이기 때문이다. Row 단위 사실은 row를 가져온 뒤, 서비스 안에 있어야 한다.

**결과.** OWNER는 회사의 어떤 상품이든 삭제하고, MANAGER는 자기 것만 삭제한다. 응답은 **404가 아니라 403** — 의도적이다. 그 상품은 매니저에게 *보인다*(자기 회사 소속이니까). 단지 남의 것을 삭제하지 못할 뿐이다. 여기서 404는 거짓말이 된다.

### 5. Soft delete, 그리고 방아쇠를 당긴 사람

**목표.** 카탈로그 row를 절대 하드 삭제하지 않는다. 동시에 *누가* 지웠는지도 기록한다.

**선택.** soft delete 대상 테이블마다 `deletedAt`과 `users`를 가리키는 nullable `deletedByUserId` FK를 둔다. 삭제 시 둘 다 찍고, 모든 읽기는 `deletedAt: null`로 필터한다. 이건 앞으로 모든 리소스의 컨벤션이 됐다.

**이유 & 결과.** soft delete만으로는 "이거 사라졌나?"에는 답해도 "누가 지웠나?"에는 답 못 한다 — 멀티테넌트·멀티롤 시스템에서 삭제 감사 로그는 그 값어치를 한다. 걸리는 지점 하나: `User`는 이미 `createdByUser`로 `Product`/`Brand`와 관계를 맺고 있어서, *같은* 두 모델 사이의 *두 번째* 관계에는 이름을 붙여야 Prisma가 구분한다.

```prisma
model Product {
  deletedByUserId String? @map("deleted_by_user_id") @db.Uuid
  deletedByUser   User?   @relation("ProductDeletedBy", fields: [deletedByUserId], references: [id])
}
```

### 6. 크로스테넌트 1급 운영자로서의 ADMIN

**목표.** 플랫폼 관리자는 모든 회사를 넘나들며 작업해야 한다.

원래 스펙에서는 ADMIN이 브랜드/상품을 *만들 수 없다*고 했다 — row를 소유할 회사가 없으니까. 구현 도중 뒤집었다: ADMIN은 **완전한 크로스테넌트 CRUD**를 가지며, 생성 시 대상 회사를 명시하기만 하면 된다.

**선택.** 아주 작은 resolver가 소유 회사를 결정한다.

```ts
resolveCompanyForCreate(caller: AuthUser, requestedCompanyId?: string): string {
  const companyId = caller.roleCode === 'ADMIN' ? requestedCompanyId : caller.companyId;
  if (!companyId) throw new BadRequestException('companyId is required');
  return companyId;
}
```

**이유.** 회사 유저는 절대 다른 테넌트를 사칭할 수 없어야 하므로, 그들의 회사는 항상 토큰에서 온다 — DTO의 `companyId`는 그들에게 무시된다. 반면 ADMIN은 *바로 그* 크로스테넌트 운영자다: 명시적으로 대상을 지정해야 한다(빠뜨리면 400). 함수 하나가 두 규칙을 모두 인코딩한다.

**결과.** DTO에는 ADMIN만 의미 있게 쓸 수 있는 선택적 `companyId`가 실린다. `UpdateProductDto`는 그것을 아예 제외한다(`PartialType(OmitType(CreateProductDto, ['companyId'] as const))`) — 수정으로 상품을 다른 회사에 넘기는 일은 없다.

## TIL (Today I Learned)

**`OmitType(CreateBrandDto, ['companyId'] as const)`에서 `as const`는 왜?**
그게 없으면 TypeScript는 배열 타입을 `string[]`로 추론한다. 그래서 `OmitType`은 "어떤 문자열들"을 제거한다고만 알 뿐, 결과 타입은 여전히 `companyId`가 *있을 수도* 있다고 생각한다. `as const`는 리터럴을 `readonly ['companyId']` 튜플로 만들어, 타입 시스템이 정확히 그 키만 빼서 정밀하게 타입이 잡힌 DTO를 준다. "문자열 배열"과 "바로 이 특정 키"의 차이다.

**소유 서비스가 예외 대신 `null`을 반환하게 둔 이유?**
없음이 무슨 뜻인지는 *호출자*가 알지, 조회하는 쪽은 모르기 때문이다. 찾지 못한 브랜드는 URL 조회에는 404지만 상품 생성에는 400이다. 날것의 사실(row 또는 null)을 돌려주고, 각 호출자가 그것을 올바른 HTTP 이야기로 번역하게 하자. 예외를 던지면 해석 하나를 못박아버려서, 나머지 모두가 catch-후-rethrow를 하게 만든다.

**`if (!caller.companyId) throw new ForbiddenException()` — 잠깐, 이건 ADMIN도 거부한다.**
상품 생성을 "회사가 반드시 있어야 함" 검사로 뭉뚱그려 막을 뻔했다. 그런데 ADMIN은 정당하게 회사가 *없다*(`companyId: null`). 그 뭉뚱그린 검사는 가장 많은 걸 할 수 있는 그 역할을 403으로 막아버린다. 해법은 결정을 `resolveCompanyForCreate`로 흘려보내는 것 — 이 함수는 `companyId`를 보기 *전에* `roleCode`로 분기한다. 교훈: "반드시 X가 있어야 함" 검사야말로 ADMIN의 null-회사 예외가 발목을 잡는 지점이다.

**유닛 테스트가 못 본 버그: `@Controller()` vs `@Controller('brands')`.**
`BrandsController`가 prefix 없이 `@Controller()`로 선언돼 있었다 — 그래서 라우트가 `/brands`가 아니라 앱 루트(`POST /`, `GET /:id`)에 마운트됐다. 86개 유닛 테스트는 전부 초록불이었다. *서비스*를 직접 호출할 뿐 라우터는 건드리지 않으니까. e2e는 그걸 즉시 잡았다: `POST /brands`가 404를 반환했다. 그게 바로 end-to-end 테스트의 존재 이유다 — 유닛 테스트가 일부러 stub 처리한 배선(라우팅, 가드, 파이프)을 실제로 돌려본다. 초록불 유닛은 필요조건이지 충분조건이 아니다.

**Prisma named relations: `deletedByUser`에 왜 이름이 필요한가.**
*같은* 두 모델을 잇는 관계가 둘일 때(`User` ↔ `Product`, 하나는 `createdBy`, 하나는 `deletedBy`), Prisma는 어느 FK가 어느 관계인지 추론하지 못한다. 이름을 붙이면(`@relation("ProductDeletedBy", …)`) 그 쌍이 구분된다 — 그리고 `User` 쪽도 짝이 맞는 역관계를 갖는다(`deletedProducts Product[] @relation("ProductDeletedBy")`).

## NestJS 개념 & 라이브러리

| 개념 / 라이브러리 | 왜 썼나 |
|---|---|
| `@Controller('prefix')` | 컨트롤러 핸들러를 특정 경로 아래 마운트하는 라우트 prefix — 브랜드에서 빠뜨렸던 바로 그것. |
| `@RequirePermissions()` + `PermissionsGuard` | "권한이 있는가?" 계층 — 라우트별 선언적 RBAC, 전역 가드가 검사. |
| `OwnershipService` (커스텀 provider) | "네 것인가?" 계층 — `companyId` 기반 테넌트 스코핑, 브랜드/상품에 주입. |
| 크로스모듈 DI (`imports`/`exports`) | `ProductsModule`이 `BrandsModule` + `CategoriesModule`을 import해 스코핑된 조회를 재사용. |
| `@nestjs/mapped-types` (`PartialType`, `OmitType`) | `CreateXDto`에서 `UpdateXDto`를 파생하며 `companyId`를 제거 — DRY한 DTO. |
| `class-validator` DTO (`@IsInt`, `@IsUUID`, `@IsOptional` 등) | 서비스가 돌기 전, 경계에서 선언적으로 요청을 검증. |
| `ParseIntPipe` / `ParseUUIDPipe` | 라우트 파라미터를 변환+검증(브랜드/카테고리는 int id, 상품은 uuid). |
| `@CurrentUser()` (커스텀 파라미터 데코레이터) | 요청에서 인증된 `AuthUser`(`roleCode`, `companyId` 포함)를 꺼낸다. |
| Prisma named relations + soft delete | 테이블마다 `User` 관계 두 개(`createdBy`/`deletedBy`)와 `deletedAt` 필터 읽기. |
| Jest (유닛) + supertest (e2e) | 유닛은 Prisma를 mock해 서비스 로직을, e2e는 실제 HTTP로 배선을 테스트. |

## 마무리

Phase 3는 두 개의 가드를 실제 기능으로 바꿔놓았다. 이제 카탈로그는 모든 요청에 두 질문을 강제한다 — *권한이 있는가?* 그리고 *네 것인가?* — RBAC 계층, 테넌트 스코핑 계층, 그리고 그 둘 중 어느 것으로도 표현할 수 없는 row 단위 정책(생성자 스코프 삭제)까지 깔끔하게 나눠서. 그 과정에서 에러는 호출자가 소유하게 두는 법, ADMIN의 null 회사를 1급 케이스로 다루는 법, 그리고 유닛 테스트가 구조적으로 못 잡는 배선 버그는 e2e를 믿는 법을 배웠다.

**다음 — Phase 4: 매장 배치(store placement).** 상품은 존재하지만 아직 *어디에도* 놓여 있지 않다. Phase 4는 카탈로그 상품을 물리적 매장 코너에 배치한다(`CompanyStoreProduct`). Phase 0에서 미리 깔아둔 복합 외래 키(composite foreign key)가 드디어 제 값을 하는 지점이다.
