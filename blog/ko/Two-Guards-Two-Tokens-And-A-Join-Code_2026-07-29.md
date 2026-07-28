# 두 개의 Guard, 두 개의 Token, 그리고 Join Code: Inventra 인증 레이어 만들기

*멀티테넌트 재고관리 SaaS의 Phase 1이 인증과 인가를 갖추기까지 — 모든 설계 결정을 "이유를 알고" 내린 기록.*

**2026-07-29**

## 들어가며

Inventra는 브랜드가 대형 매장 안에서 "코너(corner)"를 운영하는 한국형 편집숍/입점 모델을 본뜬 멀티테넌트 재고관리 SaaS다. Phase 1의 목표는 이후 모든 기능이 딛고 설 토대, 즉 **인증(authentication, 너는 누구인가?)**과 **인가(authorization, 무엇을 할 수 있는가?)**를 만드는 것이었다.

마무리 시점엔 로컬 이메일/비밀번호 로그인, rotation과 탈취 감지가 붙은 access + refresh JWT, per-user override가 있는 역할 기반 권한 시스템, 두 갈래 온보딩 플로우(회사 오너와 직원), 그리고 플랫폼 슈퍼 관리자까지 갖췄다. 전부 **유닛 테스트 52개 + 12단계 e2e 테스트**로 덮여 있다. 이 글은 코드가 아니라 *결정*에 대한 이야기다.

## 아키텍처 결정들

### 1. 하나의 장수(長壽) 토큰이 아니라 access + refresh

- **목표:** 며칠간 유지되면서도 revoke 가능하고, 탈취돼도 오래 위험하지 않은 세션.
- **선택지:** (a) 오래 사는 JWT 하나; (b) 짧은 access만 쓰고 만료되면 재로그인; (c) 짧은 **access** + 긴 **refresh**.
- **선택:** access token(15분) + refresh token(7일), **서로 다른 두 개의 secret**으로 서명.
- **이유:** 탈취된 access token은 15분이면 무용지물이고, 장수 자격증명인 refresh token은 `/auth/refresh`에만 전송되므로 노출이 훨씬 적다. secret을 둘로 나누면 access secret이 새도 refresh token을 위조할 수 없다.
- **결과:** 매 요청마다 오가는 토큰의 노출 창은 짧게, 긴 세션은 revoke·rotation 가능하게.

### 2. Refresh token: 해시 저장 + rotation + 재사용 감지

- **목표:** refresh token이 유출됐을 때 피해를 최소화.
- **선택지:** DB에 저장하지 않는 stateless refresh; 원문 그대로 저장; **해시**를 저장하고 사용 시 rotation + 재사용 감시.
- **선택:** **SHA-256 해시**를 저장하고, refresh token을 **일회용**으로 만들며(리프레시할 때마다 기존 것 revoke, 새로 발급), 이미 revoke된 토큰이 들어오면 **그 유저의 모든 토큰을 revoke**하고 거부.
- **이유:** 해시로 저장하면 DB가 유출돼도 쓸 수 있는 토큰이 없다. rotation은 탈취된 토큰의 수명을 "7일"에서 "유저가 다음에 리프레시할 때까지"로 줄인다. 그리고 핵심 인사이트: 삭제가 아니라 **soft-revoke**(`revokedAt` 세팅)를 하기 때문에, 재생(replay)된 토큰을 "그냥 잘못된 토큰"과 구분할 수 있고 이는 곧 탈취 신호다.
- **결과:** 유출된 refresh token은 길어야 rotation 한 번, replay 공격이 들어오면 해당 유저를 전면 로그아웃.

```ts
if (stored.revokedAt) {
  // revoke된 토큰이 재생됨 → 탈취로 간주
  await this.prisma.refreshToken.updateMany({
    where: { userId: stored.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  throw new UnauthorizedException('Refresh token reuse detected');
}
```

### 3. Refresh token엔 SHA-256, 비밀번호엔 argon2id

- **목표:** 용도에 *맞는* 해시를 쓰기.
- **선택지:** 둘 다 같은 알고리즘; 용도별로 다른 알고리즘.
- **선택:** 비밀번호엔 **argon2id**, refresh token엔 **SHA-256**.
- **이유:** 비밀번호는 엔트로피가 낮고 사람이 정하므로 브루트포스를 어렵게 하는 *의도적으로 느리고 salt 붙은* 해시가 필요하다. 반면 refresh token은 이미 길고 무작위한 고엔트로피 문자열이라 추측 자체가 무의미하고, 필요한 건 DB에서 **빠르고 결정적으로(deterministic)** 조회할 수 있는 지문이다. argon2의 무작위 salt는 오히려 조회를 *망가뜨린다* — 같은 토큰이 매번 다르게 해시되니까.
- **결과:** 브루트포스에 강한 비밀번호 저장 + 빠르고 결정적인 refresh token 조회. 각 해시가 잘하는 일을 맡았다.

### 4. Join code를 통한 멤버 온보딩 (설계 변경)

이건 구현 도중 첫 설계를 스스로 의심하며 바꾼 결정이다.

- **목표:** 매니저·직원이 기존 회사에 합류하게 하기.
- **선택지:** (a) 내부자가 계정을 생성(`POST /users`); (b) 공개 목록에서 회사 선택; (c) 오너가 공유하는 **회사 join code**.
- **선택:** **join code**로 셀프 가입한 뒤, 오너가 승인하면서 역할을 부여. `POST /users`는 아예 제거.
- **이유:** 셀프 가입하는 낯선 사람은 아직 소속 회사가 없으니 회사를 *지목*해야 하는데, 공개 목록은 모든 테넌트를 노출하고 회사 ID 직접 입력은 스팸을 부른다. join code는 공유된 비밀값으로 정확히 한 회사에 매핑되며 디렉터리 노출이 없다. 게다가 join code 플로우 + 승인만으로 온보딩이 완결되니, 내부자 생성 경로를 또 두는 건 YAGNI 위반이었다.
- **결과:** 깔끔하고 테넌트 안전한 단일 온보딩 경로. 멤버십은 항상 *내부에서 부여*되지 *외부에서 요청*되지 않는다.

### 5. Nullable role — "역할 없음"은 "아직 멤버가 아님"

- **목표:** 가입은 했지만 아직 승인 전인 상태를 표현.
- **선택지:** 신규 멤버를 `STAFF` 기본값으로; 또는 `role_id`를 nullable로.
- **선택:** **Nullable `role_id`.** 셀프 가입한 멤버는 오너가 승인하며 역할을 줄 때까지 역할이 없다.
- **이유:** "역할 없음"은 "아직 진짜 멤버가 아님"을 그대로 인코딩하고, 승인을 신원과 권한이 *동시에* 부여되는 단 하나의 순간으로 만든다. 덤으로 권한 계산기는 null role에 대해 빈 집합을 반환한다 — 방어 심층화(defense in depth).
- **결과:** 유저 상태를 거짓말하는 placeholder 역할 대신, 정직한 상태 모델링.

### 6. 순환 FK 부트스트랩 — user-first

- **목표:** 서로를 참조하는 회사와 오너를 생성(`companies.created_by_user_id` ↔ `users.company_id`).
- **선택지:** deferrable FK 제약; 미리 시딩된 admin을 임시 앵커로; nullable `company_id`를 활용한 **user-first**.
- **선택:** 오너를 `company_id = NULL`로 생성 → 그 유저를 가리키는 회사 생성 → 유저의 `company_id`를 업데이트. 전부 하나의 트랜잭션.
- **이유:** 이미 `company_id`를 nullable로 만들어 뒀기 때문에(플랫폼 admin은 소속 회사가 없다) 유저가 잠깐 회사 없이 존재할 수 있다. deferrable 제약도, admin 앵커도 필요 없고, 원자적이다.
- **결과:** 특별한 DB 기능 없이 두 외래키를 모두 만족시키는, 전부-아니면-전무(all-or-nothing)의 깔끔한 가입 로직.

### 7. PENDING 유저는 인증은 되지만 행동은 못 한다

- **목표:** 방금 가입한 오너가 클라이언트에 들어와 "승인 대기 중" 화면을 보되, 실질 권한은 없게.
- **선택지:** PENDING은 아예 로그인 불가; PENDING이 전체 접근; 또는 PENDING은 **인증은 되지만 게이트로 막기**.
- **선택:** 두 관심사를 분리. `JwtAuthGuard`는 `PENDING`과 `ACTIVE`를 인증시키고(종료 상태/soft-delete만 거부), `PermissionsGuard`는 권한을 요구하는 라우트에서 `ACTIVE`를 요구. `GET /auth/me`는 권한이 필요 없어 PENDING도 도달 가능.
- **이유:** 인증("너는 누구인가")과 활성화("이제 행동해도 되는가")는 본질적으로 다른 질문이라, 다른 게이트를 가질 자격이 있다.
- **결과:** 대기 중 오너가 로그인하면 `/auth/me`가 `PENDING_APPROVAL`을 알려주고, 클라이언트는 대기 화면을 띄우며, admin이 `ACTIVE`로 바꾸기 전까지 모든 실제 행동은 `403`.

### 8. 전역 Guard 두 개, 순서를 강제

- **목표:** 보호를 "잊지 않고 붙여야 하는 것"이 아니라 기본값으로.
- **선택지:** 라우트별 `@UseGuards`; 또는 `APP_GUARD`로 전역 등록.
- **선택:** 두 개의 전역 `APP_GUARD` — `JwtAuthGuard` 다음 `PermissionsGuard` — 에 `@Public()`로 opt-out.
- **이유:** 기본-보호(default-on)라면 새 라우트는 *명시적으로* 선언하지 않는 한 보호된다. `PermissionsGuard`는 `JwtAuthGuard`가 붙여주는 유저에 의존하므로 순서가 중요한데, NestJS는 `APP_GUARD` 순서를 모듈 import 순서로 결정하기에 `AuthModule`을 `AuthorizationModule`보다 먼저 import한다.
- **결과:** 모든 라우트가 기본적으로 인증+인가된다. Guard를 깜빡해도 *안전하게* 실패하지, 열린 채로 실패하지 않는다.

### 9. 토큰 전송: httpOnly 쿠키가 아니라 request body

- **목표:** 클라이언트와 토큰을 주고받기.
- **선택지:** refresh token을 `httpOnly; Secure; SameSite` 쿠키에(웹 SPA에 최적); 또는 request body/`Authorization` 헤더에.
- **선택:** **Request body / header.**
- **이유:** 전형적인 XSS vs CSRF 트레이드오프다. 쿠키는 refresh token을 XSS로부터 지켜주지만 CSRF·CORS 처리가 필요하고 브라우저에만 맞는다. body/header 전송은 **클라이언트 비의존적**(웹·모바일·서버 간)이고 **CSRF 면역**이지만, 웹 클라이언트가 refresh token을 신중히 저장해야 한다. Inventra의 클라이언트 종류가 아직 확정되지 않았기에 균일하고 단순한 쪽을 택하고 트레이드오프를 문서로 남겨 재검토하기로 했다.
- **결과:** 모든 클라이언트에 하나의 API 형태, 쿠키/CSRF 장치 불필요 — 브라우저 SPA가 주력이 되면 httpOnly 쿠키로 옮긴다는 의식적 메모와 함께.

## TIL (오늘 배운 것)

만들면서 실제로 막혔던 질문들:

**Node의 `createHash`는 정확히 어떻게 동작하나?** 한 번의 호출로 해시하지 않는다. 데이터를 먹이고 마무리하는 *Hash 객체*를 반환한다: `createHash('sha256').update(token).digest('hex')`. `createHash`의 두 번째 인자는 key가 아니라 options 객체다 — 처음엔 digest 문자열이 아니라 마무리 안 된 객체를 반환하는 실수를 했다.

**JWT 옵션의 `sub` vs `subject`?** `sub`은 *claim*(payload에 들어감)이고, `subject`는 그 claim을 대신 세팅해 주는 *sign 옵션*이다. 결국 같은 곳에 들어가고, 둘 다 세팅하면 `jsonwebtoken`이 에러를 던진다. 나는 커스텀 claim들과 함께 `sub`을 payload에 직접 넣었다.

**`ValidationPipe`는 어떤 DTO를 만들지 어떻게 아나?** 컨트롤러 핸들러의 파라미터에서 안다 — `@Body()`가 출처를 표시하고, 타입 주석(`dto: LoginDto`)이 `emitDecoratorMetadata`를 통해 런타임에 `metadata.metatype`으로 읽힌다. 파이프는 전역에 한 번 등록되지만 파라미터마다 올바른 DTO를 다시 찾아낸다.

**`class-validator`는 어디서 연결되나? config에 적은 적이 없는데.** 암묵적으로 연결된다: `ValidationPipe`가 `class-validator`와 `class-transformer`를 직접 import하고(peer dep), `@IsEmail()` 같은 데코레이터 각각이 규칙을 공유 메타데이터 레지스트리에 등록하면 요청 시점에 `validate()`가 그걸 읽는다. 둘을 잇는 config 줄은 없다 — 결합이 파이프 안에 산다.

**`{ provide: APP_GUARD, useClass: JwtAuthGuard }`는 뭘 하나?** *DI 컨테이너가 만든* 전역 guard를 등록한다. 그래서 guard가 `Reflector`, `TokenService`, `PrismaService`를 주입받을 수 있다. `main.ts`에서 `new JwtAuthGuard()`를 하면 그 모든 의존성을 손으로 만들어 넘겨야 한다.

**모듈의 `imports` vs `providers` vs `exports`?** `imports`엔 **모듈**이, `providers`/`exports`엔 **서비스**가 들어간다. 서비스를 직접 import하지 않는다 — 그 서비스를 *export한 모듈*을 import한다. TypeScript 파일의 `import`/`export`와 똑같되, DI 컨테이너용이다.

**Prisma의 `create`/`update`가 `null`을 반환할 수 있나?** 아니다 — 실패 시 **throw**한다(`update`는 행이 없으면 `P2025`). `null`은 `findUnique`/`findFirst`만 반환한다. 그래서 쓰기(write) 주변엔 null 체크가 없지만, `findUnique` 역할 조회엔 필요했다(`findUniqueOrThrow`로 처리).

**컨트롤러에서 `return await` vs `return promise`?** Nest는 둘 다 await하므로 단순 pass-through면 동일하다. 하지만 `try/catch`가 있으면 `await`가 중요하고(await 안 한 return은 reject 전에 블록을 빠져나감), async 스택 트레이스도 더 좋아진다.

**Prisma 7 + Jest e2e: "dynamic import callback invoked without `--experimental-vm-modules`".** Prisma 7은 연결 시점에 dynamic `import()`로 쿼리 엔진을 로드한다. 유닛 테스트는 Prisma를 mock해서 안 걸리지만, e2e는 진짜 클라이언트를 띄워서 걸린다. 해결책은 Jest를 `node --experimental-vm-modules`로 돌리는 것이었다.

## NestJS 개념 & 라이브러리

| 개념 / 라이브러리 | 왜 썼나 |
|---|---|
| **Modules & DI** | 서비스·컨트롤러·전역 guard를 연결하고, 무엇이 어디서 보이는지 범위 지정 |
| **Guards** (`CanActivate`, `ExecutionContext`) | 핸들러 실행 전 authN → authZ 강제 |
| **`APP_GUARD`** | guard를 전역 등록해 보호를 기본값으로 |
| **커스텀 데코레이터** (`SetMetadata`, `createParamDecorator`) | `@Public()`, `@RequirePermissions()`, `@CurrentUser()` |
| **`Reflector`** | 데코레이터가 붙인 라우트 메타데이터 읽기 |
| **Pipes** (`ValidationPipe`) | 핸들러 전에 요청 body 검증 + 정제 |
| **class-validator / class-transformer** | 선언적 DTO 규칙 + body를 타입 인스턴스로 변환 |
| **@nestjs/jwt** | access·refresh token 서명/검증 |
| **argon2** | 느리고 salt 붙은 비밀번호 해싱 |
| **node:crypto** | `randomUUID`(jti) + `createHash`(SHA-256 토큰 지문) |
| **Prisma 7** | `$transaction`, 중첩 write, driver adapter, migration |
| **Jest + supertest** | 격리된 유닛 테스트(mock) + 실제-HTTP e2e |

## 마무리

Phase 1은 완성되고 테스트된 인증 레이어를 만들어냈다: 신원과 토큰, 2단계 guard 파이프라인, per-user override가 있는 RBAC, join code 온보딩, 승인 라이프사이클, 그리고 PENDING 게이트 — 실제 DB를 상대로 e2e까지 검증했다. 코드보다 값진 건, 모든 결정을 *이유를 알고* 내리게 만들었다는 점이고, 테스트는 실제 버그(`jti` 불일치, 빠진 재사용 검사, 연결 안 된 모듈)를 잡아내며 제 몫을 했다.

다음은 **Phase 2**: "너는 X를 할 권한이 있다"를 "너는 *네 테넌트의 바로 이 레코드에* X를 할 권한이 있다"로 바꾸는 request-scoped `OwnershipService` — 인가의 나머지 절반인 스코프(scope)다. 거기서 보자.
