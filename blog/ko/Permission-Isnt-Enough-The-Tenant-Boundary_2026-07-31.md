# 권한만으로는 부족하다: Inventra의 테넌트 경계 만들기

*Phase 2는 인가의 "스코프(scope)" 절반을 추가했다 — 올바른 권한을 가졌더라도, 한 회사가 오직 자기 회사의 레코드만 건드릴 수 있게.*

**2026-07-31**

## 들어가며

Inventra는 멀티테넌트 재고관리 SaaS다. Phase 1은 *"이 사용자가 액션 X를 수행할 수 있는가?"*에 답하는 역할/권한 시스템을 만들었다. 하지만 그건 인가의 절반일 뿐이다. `products.update` 권한을 가진 Company A의 `MANAGER`가 Company B의 상품을 수정할 수 있어서는 **안 된다**. Phase 2는 그 나머지 절반 — **테넌트/레코드 소유권 경계** — 를 의존성 없는 작은 `OwnershipService`로 만들고, 기존 승인 플로우에 리트로핏(retrofit)해 패턴을 검증했다.

## 아키텍처 결정들

### 1. 피처 모듈을 기다리지 말고, 인프라를 지금 만들어 리트로핏

- **목표:** 코드베이스에 테넌트 스코핑을 자리 잡게 하기.
- **선택지:** (a) `OwnershipService`를 지금 만들어 이미 있는 것에 적용; (b) 첫 레코드 소유 피처 모듈(products)과 함께 만들기; (c) 소비자 없이 단독 인프라로 유닛 테스트만.
- **선택:** 지금 만들고, 이미 손으로 `companyId` 스코핑을 하고 있던 승인 플로우에 **리트로핏**.
- **이유:** 피처 모듈이 늘어나기 *전에* 패턴을 잡아두면 이후 모든 모듈이 같은 방식으로 테넌시를 강제한다 — 아무도 `companyId` 필터를 재발명하거나 깜빡하지 않는다. 그리고 리트로핏은 소비자 없는 추상화를 설계하는 대신, 서비스를 검증할 실제 소비자를 준다.
- **결과:** 재사용 가능한 스코핑 프리미티브와 더 깔끔한 승인 플로우를, 피처 모듈이 하나도 없는 시점에 이미 만들고 테스트했다.

### 2. Request-scoped 프로바이더가 아니라, 명시적 파라미터

이 페이즈에서 가장 흥미로운 결정이었고, 일부러 "더 화려한" 선택지를 버렸다.

- **목표:** `OwnershipService`가 *누가 요청하는지*(그의 `companyId`)를 알게 하기.
- **선택지:** (a) **request-scoped** 프로바이더(`Scope.REQUEST`) — 요청마다 인스턴스 하나, `request.user`를 한 번 읽어 테넌트를 *암묵적으로* 노출; (b) `AuthUser`를 명시적 파라미터로 받는 평범한 **싱글턴**.
- **선택:** **명시적 `AuthUser` 파라미터를 받는 싱글턴.**
- **이유:** request-scoped는 우아하지만 공짜가 아니다 — NestJS가 매 요청마다 그것(과 그것을 주입하는 모든 것)을 다시 만들고, 그 "scope bubbling"이 의존성 체인을 타고 위로 번진다. 그게 주는 이점(호출마다 caller를 넘기지 않아도 됨)은 호출 체인이 깊을 때만 값어치를 한다. 내 체인은 얕다: 컨트롤러가 `@CurrentUser()`를 집어 서비스 메서드 *하나*를 부른다. 그러니 명시적 파라미터는 거의 공짜고, 사용자는 이미 auth guard가 세팅한 `request.user`에 앉아 있다.
- **결과:** 놀랍도록 단순한, 의존성 없는 싱글턴 — 요청마다의 인스턴스화도, scope bubbling도 없고, `new OwnershipService()`만으로 유닛 테스트되는 서비스.

### 3. ADMIN은 "회사 없음"이 아니라 명시적 `roleCode`로 인식

- **목표:** 모든 회사를 아우르는 플랫폼 ADMIN이 테넌트 검사를 우회하게 하기.
- **선택지:** (a) 오직 플랫폼 admin만 회사가 없으니 `companyId === null`을 우회로 간주; (b) 역할의 `code`를 `AuthUser`에 추가하고 `roleCode === 'ADMIN'`일 때 우회.
- **선택:** **`roleCode`를 `AuthUser`에 추가**(auth guard가 join으로 로드)하고 명시적으로 검사.
- **이유:** "회사 없음"을 "god mode"와 동일시하는 건 암묵적 결합이라, 데이터 모델이 바뀌면 조용히 깨진다. 명시적 `roleCode === 'ADMIN'`은 의미하는 바를 정확히 말하고, 언젠가 교차 테넌트 접근이 한 역할 이상으로 확장돼도 안전하다.
- **결과:** 명확한 우회 조건 — 덤으로, `PermissionsService`는 지금 ADMIN 역할을 확인하려 DB 조회를 한 번 더 하는데, 이제 `roleCode`로 그걸 건너뛸 *수 있다*(이번 페이즈 밖으로 뺀 의도적 후속 작업).

### 4. 깨진 불변식엔 매직 센티넬 없이 fail closed

- **목표:** "불가능한" 케이스 처리 — 회사가 없는 비(非)admin 호출자.
- **선택지:** (a) 아무것도 매칭 안 되도록 `{ companyId: '__none__' }` 같은 센티넬 필터 반환; (b) `throw`.
- **선택:** **`ForbiddenException` throw.**
- **이유:** "진짜 멤버는 항상 회사에 속한다"는 불변식이다. 이게 깨지면 세션이 망가진 것이고, 안전한 대응은 **fail closed**(거부)다. 매직 센티넬은 코드 스멜이고 — 더 나쁘게는 — 실수로 *빈* 스코프를 반환했다면 쿼리가 *모든* 회사의 레코드를 매칭했을 것이다. throw는 스멜과 지뢰를 둘 다 없앤다.
- **결과:** 취약한 문자열 상수 대신, 명시적이고 자기설명적인 가드.

### 5. 교차 테넌트 접근은 403이 아니라 404

- **목표:** 다른 회사의 레코드에 손을 뻗을 때 호출자가 무엇을 보게 할지.
- **선택지:** `403 Forbidden` 또는 `404 Not Found`.
- **선택:** **`404 NotFoundException`.**
- **이유:** `403`은 정보를 흘린다 — "이 레코드는 존재하지만 네 것이 아니다"를 확인해 준다. `404`는 "여기 아무것도 없다"라고 말하고, 진짜로 없는 id와 구분되지 않는다. 멀티테넌트 시스템에서는 다른 테넌트 데이터의 *존재*조차 확인해 주고 싶지 않다.
- **결과:** 교차 테넌트 탐침이 아무것도 드러내지 않는다.

### 6. 한 서비스에 두 가지 강제 방식

- **목표:** 서로 다른 쿼리 패턴에서 소유권을 강제하기.
- **선택지:** 선제적 query-scoping만; 사후 assertion만; 둘 다.
- **선택:** **둘 다** — `scopeToCompany`(Prisma `where` 조각)와 `assertOwns`(fetch 후 검사).
- **이유:** query-scoping이 가장 안전하다 — `companyId`를 `where`에 넣으니 다른 테넌트의 행은 *애초에 fetch되지 않고* 미스는 자연스러운 404다. 하지만 때론 글로벌 id로 먼저 레코드를 조회해야 하고(REST `GET /products/:id`) 그 뒤에야 검사할 수 있는데, 그게 `assertOwns`의 역할이다. 서로 다른 호출 패턴엔 서로 다른 도구가 필요하다.
- **결과:** 지금 코드의 쿼리 방식과 미래 모듈의 방식 둘 다에 맞는 작은 서비스 하나.

```ts
@Injectable()
export class OwnershipService {
  scopeToCompany(caller: AuthUser): { companyId?: string } {
    if (caller.roleCode === 'ADMIN') return {};              // 모든 회사
    if (!caller.companyId) throw new ForbiddenException();   // fail closed
    return { companyId: caller.companyId };
  }

  assertOwns(caller: AuthUser, resourceCompanyId: string | null): void {
    if (caller.roleCode === 'ADMIN') return;
    if (resourceCompanyId !== caller.companyId) throw new NotFoundException();
  }
}
```

## TIL (오늘 배운 것)

**request-scoped 프로바이더와 싱글턴의 진짜 차이는?** NestJS는 기본적으로 프로바이더 인스턴스를 하나 만들어 *모든* 요청에 공유한다 — 그래서 현재 호출자를 "기억"할 수가 없다. 동시에 수천 명을 서빙하니까. 그래서 사용자를 인자로 넘긴다. request-scoped는 *요청마다 새 인스턴스*라 `request.user`를 안전하게 담을 수 있다. 대가는 비용: 그것(과 그것을 주입하는 모든 것)이 매 요청마다 다시 만들어진다.

**"caller를 모든 메서드로 thread한다"는 게 무슨 뜻?** 같은 인자를 호출 체인을 따라 넘기는 것이다: 컨트롤러가 `A.do(caller)`를 부르고, `do`가 `B.help(caller)`를 부르고, 그게 `C.check(caller)`를 부르면, 경로의 모든 함수가 `caller`를 받아 다음으로 전달해야 한다. request-scoped 서비스는 그걸 면제해 주고, 명시적 파라미터에선 스코핑이 일어나는 곳마다 넘긴다(체인이 한 단계면 사소하다).

**Prisma에서 연관 테이블의 한 필드만 어떻게 가져오나?** 관계에 중첩 `select`: `select: { …, role: { select: { code: true } } }`. join이고, 결과는 `user.role: { code } | null`이다. 나는 code만 원했으니 그것만 선택했다 — 역할 행 전체가 아니라.

**여기서 헬퍼를 `async`로 만들면 왜 버그인가?** 내 첫 `OwnershipService`는 `async scopeToCompany`였다. 그런데 이건 쿼리에 *스프레드*해서 쓴다: `where: { id, ...scopeToCompany(caller) }`. `async` 함수는 **Promise**를 반환하니, 그 스프레드는 `{ companyId }`가 아니라 Promise의 내부 키를 흩뿌린다. 로직은 순수하고 동기적이다 — async로 만든 건 사용법을 깨뜨렸고, 이유 없이 곳곳에 `await`를 강요했다.

**다른 테넌트의 레코드에 왜 403이 아니라 404인가?** `403`은 레코드가 *존재함*을 확인해 주기 때문이다. 멀티테넌트에서 존재 자체가 외부에 넘기면 안 되는 정보라, 교차 테넌트 읽기는 "not found"와 똑같이 보이게 한다.

## NestJS 개념 & 라이브러리

| 개념 / 라이브러리 | 왜 썼나 |
|---|---|
| **Provider scopes** (`Scope.REQUEST` vs 기본 싱글턴) | 암묵적 request-scoped 컨텍스트 vs 명시적-파라미터 싱글턴을 저울질하고 싱글턴 선택 |
| **모듈 간 DI** (`imports`/`exports`) | `UsersModule`이 `AuthorizationModule`을 import해 export된 `OwnershipService` 주입 |
| **Prisma relation `select`** | 역할의 `code`를 join해 guard가 `roleCode`를 붙일 수 있게 |
| **Prisma `where`에 객체 스프레드** | `...scopeToCompany(caller)`로 테넌트 필터를 쿼리에 병합 |
| **HTTP 예외** (`NotFoundException` / `ForbiddenException`) | 교차 테넌트엔 404(존재 미노출); 깨진 불변식엔 403 fail-closed |
| **Jest** | mock 없이 순수 싱글턴 유닛 테스트(`new OwnershipService()`) |

## 마무리

Phase 2는 작지만 영향은 큰 페이즈였다: 인가의 **스코프** 절반을 더했다. `OwnershipService`는 "자기 회사의 레코드만 건드릴 수 있다"가 사는 단 하나의 장소를 코드베이스에 준다 — ADMIN 인식, 깨진 불변식엔 fail-closed, 교차 테넌트 탐침엔 404 — 그리고 승인 플로우가 이제 이걸 거쳐 간다. 의존성이 없고 유닛 테스트로 덮여 있다(스위트 전체 59개).

진짜 수확은 **패턴**이다: 앞으로의 모든 피처 모듈은 Phase 1의 `PermissionsGuard`(*할 수 있는가?*)와 Phase 2의 `OwnershipService`(*네 것인가?*)를 짝지어 쓴다. 다음은 바로 그 모듈들 — **products, 그다음 orders와 inventory** — 인가 이야기의 두 절반을 모두 처음으로 소비하는 곳이다.
