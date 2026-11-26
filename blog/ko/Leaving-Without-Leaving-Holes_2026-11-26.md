# 떠나도 구멍은 남기지 않는다

> 한 사람이 여러 지점에서 일하게 하는 건 테이블 하나면 됐습니다. 떠나게 하는 데는 모든 출구에 거는 잠금, 누가 회사를 이어받을지 정하는 규칙, 그리고 애플에게 "우리를 잊어 달라"고 요청하는 일까지 필요했습니다.

*2026-11-26*

## 들어가며

[Inventra](https://github.com/develoHAM/inventra_backend)는 **NestJS 11 + Prisma 7 + PostgreSQL**로 만드는 멀티테넌트 재고 관리 SaaS입니다. 한국의 백화점 입점 매장 구조를 모델로 삼았습니다. 회사들이 백화점 안에서 지점("코너")을 운영하고, 오너·매니저·스태프가 재고를 함께 관리합니다.

이번 트랙은 **구성원 관리 개편 3부작의 마지막, "여러 지점, 그리고 떠나기"** 입니다. 빠진 게 두 가지 있었습니다. 주중엔 홍대, 주말엔 잠실에서 일하는 파트타이머를 지점 하나에만 기록할 수 있었습니다. 그리고 아무도 떠날 수 없었습니다. "이 회사에서 나가기"도, 오너가 그만둔 사람을 내보내는 방법도, 계정 삭제(애플은 토큰 폐기까지 요구합니다)도, 회사를 닫는 방법도 없었죠. 모든 결정을 이끈 규칙은 하나였습니다. **떠나더라도 구멍을 남기지 않는다.** 일하는 사람은 있는데 오너가 없는 회사를 만들지 않는다는 뜻입니다.

**8일** 동안 진행했습니다. 승인했던 설계를 사흘째에 버렸고, 태스크 5개와 마이그레이션 1개, 중간에 제가 요청한 스타일 커밋 하나가 들어갔습니다. 유닛 테스트는 1238개에서 **1403개**로, e2e는 271개에서 18개 스위트 **324개**로 늘었습니다.

## 아키텍처 결정

### 1. 역할은 사람에게, 지점은 그냥 목록으로

**목표:** 매니저나 스태프가 지점 여러 곳에서 일할 수 있고, 한 곳도 없어도 되게 하기.

**선택지:**

| | 방식 | 결과 |
|---|---|---|
| 1 | 지점 배정마다 역할을 두고, 회사 전체 역할도 따로 저장해 동기화 | 탈락: 같은 사실을 두 번 저장. 동기화를 한 번만 빼먹어도 역할이 어긋남 |
| 2 | 지점 배정마다 역할을 두고, 회사 전체 역할은 배정들로부터 **매번 계산** | **승인했다가 이틀 뒤 폐기** |
| 3 | 오너와 매니저만 두기: 지점에서 일하면 누구나 그 지점을 관리 | 탈락: 주말 파트타이머가 회사 전체 카탈로그를 수정하게 됨 |
| 4 | **역할은 사람에게, 지점은 단순한 목록으로** | 채택 |

**결정:** 4번. `profiles.role_id`는 그대로 두고, 각자 일하는 곳은 새 테이블 `profile_branches`가 담습니다.

**이유:** 2번은 제가 검토하면서 던진 질문 하나에 무너졌습니다. *민지는 강남점 매니저다. 강남점이 문을 닫는다. 민지는 여전히 매니저인가?* 2번에서는 아닙니다. 역할이 지점 행에 붙어 있으니 지점과 함께 사라지고, 공유 카탈로그를 수정할 권한도 같이 사라집니다. 그때 원칙이 분명해졌습니다. **권한은 그 권한이 보호하는 대상과 같은 수준에 둔다.** 카탈로그는 회사 전체의 것이니 "카탈로그 수정 가능"은 사람에게 속하고, 지점 업무는 지점 단위이니 "어디서 일할 수 있나"는 목록에 속합니다.

덕분에 두 번째 고민도 풀렸습니다. 원래는 지점이 최소 하나는 있어야 하고, 누군가의 마지막 지점이 되는 곳은 삭제를 막으려 했습니다. 역할이 사람에게 있으니 지킬 게 없습니다. 민지는 역할을 유지하고, 오너가 지점을 배정해 줄 때까지 모든 지점 라우트에서 403을 받을 뿐, 막히는 일은 없습니다.

**결과:** 마이그레이션 하나로 이번 작업 전체를 처리했습니다. 기존 컬럼을 지우기 전에 손으로 쓴 복사 단계를 끼워 넣었습니다.

```sql
CREATE UNIQUE INDEX "UQ_profile_branches_profile_branch"
  ON "profile_branches"("profile_id", "company_store_id") WHERE (deleted_at IS NULL);

-- Copy (hand-written): each live profile's live branch becomes its first assignment.
INSERT INTO "profile_branches" ("profile_id", "company_store_id")
SELECT p."id", p."company_store_id"
FROM "profiles" p
JOIN "company_stores" cs ON cs."id" = p."company_store_id"
WHERE p."deleted_at" IS NULL AND cs."deleted_at" IS NULL;

-- Moved to the end by hand: the old column goes only after the copy above.
ALTER TABLE "profiles" DROP COLUMN "company_store_id";
```

가드는 요청마다 `branchIds`를 새로 읽기 때문에, 누군가를 지점에 추가하면 새 토큰 없이 바로 다음 클릭부터 반영됩니다.

### 2. 모든 출구에 절차는 하나

**목표:** 회사를 떠나는 세 가지 방법(스스로 나가기, 내보내지기, 계정 삭제)이 모두 같은 규칙을 따르게 하기. 배정이 끝나고, 이력이 남고, 마지막 오너라면 후임이 정해지거나 회사가 닫힙니다.

**선택지:** 서비스 세 개가 각자 규칙을 복사해 갖거나, **절차 하나를 두고 호출하는 쪽이 각자의 트랜잭션 안에서 실행**하거나.

**결정:** 절차 하나. `LeavingService.leaveInTransaction(transaction, { profileId, companyId, actorProfileId, reason, ownerSuccessorProfileId? })`.

**이유:** 버그는 규칙 안에 숨어 있습니다. 복사본 세 개는 언젠가 서로 달라지고, 처음 달라지는 순간이 곧 오너 없는 회사입니다. 공유가 가능했던 건 설계 디테일 두 가지 덕분입니다.

- **트랜잭션을 여는 대신 받습니다.** 계정 삭제는 회사마다 한 번씩, 전부 하나의 트랜잭션 안에서 이 절차를 실행합니다. 그래서 모든 회사를 떠나거나, 한 곳도 떠나지 않거나 둘 중 하나입니다.
- **이벤트를 직접 보내지 않고 돌려줍니다.** 나중에 롤백될 트랜잭션 안에서 알림을 보내면 일어나지도 않은 일을 알리게 됩니다. 그래서 절차는 이벤트를 모아 돌려주기만 하고, 호출한 쪽이 커밋한 뒤에 보냅니다.

```ts
const outcome = await this.prisma.$transaction((transaction) =>
  this.leaveInTransaction(transaction, { …, reason: 'LEFT_COMPANY' }),
);
// Only now, after the commit: never announce a leave that rolled back.
for (const event of outcome.events) {
  this.eventEmitter.emit(event.name, event.payload);
}
```

**결과:** 내보내기(태스크 4)는 절차에 분기 하나만 추가했고, 계정 삭제(태스크 5)는 절차를 하나도 고치지 않았습니다. 삭제할 때 모든 회사를 떠나는 부분은 같은 호출을 도는 짧은 반복문입니다.

### 3. 마지막 오너는 후임을 지명하거나, 시스템이 고르거나, 회사가 닫힌다

**목표:** 마지막 ACTIVE 오너가 회사를 오너 없이 남기지 않고 떠날 수 있게 하기.

**선택지:** 마지막 오너는 떠나지 못하게 막기, 반드시 후임을 지명하게 하기, 또는 **지명할 수 있되 안 하면 시스템이 고르고, 고를 사람이 없으면 회사를 닫기**.

**결정:** 세 번째. 지명된 후임은 같은 회사의 ACTIVE 매니저나 스태프여야 합니다(그 외에는 400 `This person cannot take over as owner`). 지명하지 않으면 `pickSuccessor`가 고르고, `changed_by` 없이 `AUTO_PROMOTED`로 기록합니다. 사람이 내린 선택이 아니기 때문입니다.

```ts
export function pickSuccessor(
  candidates: { profileId: string; createdAt: Date; roleCode: string }[],
): string | null {
  const ranked = [...candidates].sort((first, second) => {
    const firstRank = first.roleCode === 'MANAGER' ? 0 : 1;
    const secondRank = second.roleCode === 'MANAGER' ? 0 : 1;
    if (firstRank !== secondRank) {
      return firstRank - secondRank; // managers first
    }
    const byTenure = first.createdAt.getTime() - second.createdAt.getTime();
    if (byTenure !== 0) {
      return byTenure; // the earliest joiner first
    }
    return first.profileId < second.profileId ? -1 : 1; // a fixed tie-break
  });
  return ranked[0]?.profileId ?? null;
}
```

**이유:** 떠나지 못하게 막으면 사람을 회사에 가둡니다. 지명을 강제하면 물어볼 사람이 없는 순간, 예를 들어 계정 삭제 때 바로 막힙니다. 고르는 규칙은 순수 함수로 두어서, 나중에 트랜잭션을 건드리지 않고 바꿀 수 있습니다.

**결과:** `GET /profiles/me/leave-preview`는 아무것도 바꾸기 전에 누가 이어받을 수 있는지, 시스템이라면 누구를 고를지, 회사가 닫히는지를 미리 보여 줍니다. 회사를 닫는 건 지금은 되돌릴 수 없습니다. 회사와 지점은 소프트 삭제되므로 모든 기록에 이름이 남습니다.

### 4. 경쟁 상태는 미리 확인하지 않고, 트랜잭션 안에서 건 잠금으로 막는다

**목표:** 오너 두 명이 동시에 떠날 때, 둘 다 "아직 다른 오너가 있다"고 판단하지 않게 하기.

**선택지:** 트랜잭션 전에 오너 수를 세기(간단하지만 틀림), 또는 **회사 행을 먼저 잠그고, 잠근 뒤에 세기**.

**결정:** 회사를 떠나는 모든 경로는 회사 행에 먼저 쓰고, 그 쓰기가 행을 잠급니다.

| 시점 | 요청 1: 오너 A가 떠남 | 요청 2: 오너 B가 떠남 |
|---|---|---|
| t1 | 회사를 잠금 | 잠금을 기다림 |
| t2 | 세어 보니 B가 아직 오너 → 떠남 | |
| t3 | 커밋 | 잠금을 얻고 세어 보니 **아무도 없음** → 후임 또는 폐업 |

내보내기 검사의 위치도 같은 규칙으로 정했습니다. 마지막 ACTIVE 오너를 내보내면 409인데, 이 검사는 remove 엔드포인트 앞단의 `if`가 아니라 **절차 안, 잠금 뒤**에 있습니다. 앞단에서 세면 다른 오너가 막 떠나 커밋하기 전의 숫자를 읽게 됩니다.

**이유:** 미리 하는 확인은 "*지금* 오너가 몇 명인가?"에 답하지만, 그 답으로 행동할 즈음엔 그 "지금"이 이미 지나 있습니다.

**결과:** e2e에서 `Promise.all`로 두 오너를 동시에 떠나게 하고, 회사에 구성원은 있는데 오너가 없는 상태가 절대 생기지 않는지 확인합니다. 같은 생각으로 두 가지 문제를 더 풀었습니다.

- **데드락.** 계정 삭제는 `companyId` 순서로 회사를 떠납니다. 김 씨가 A를 잠그고 B를 기다리는 동안 이 씨가 B를 잠그고 A를 기다리면, 둘은 영원히 서로를 기다립니다. 모두가 같은 순서로 잠그면 두 번째 사람은 그냥 첫 번째를 기다릴 뿐입니다.
- **스펙에 없던 경쟁 상태.** 계정 삭제를 공부하던 중, 구글 로그인을 *연결*하는 쪽은 계정 잠금을 걸지 않는다는 걸 발견했습니다. 삭제 4단계 직후에 연결이 끼어들면 삭제된 계정에 로그인 행이 영원히 남고, 그 유니크 인덱스는 모든 행을 세기 때문에 그 구글 계정으로는 다시 가입할 수 없게 됩니다. 이제 두 연결 메서드 모두 살아 있는 계정을 먼저 잠그고(개수 0 → 401), e2e에서 삭제와 연결을 동시에 보내 아무것도 남지 않는지 확인합니다.

### 5. 내보내기는 권한뿐 아니라 역할까지 확인한다

**목표:** 오너와 관리자만 구성원을 내보낼 수 있게 하기. 다른 사람은 안 되고, 오너끼리도 서로 내보낼 수 없습니다.

**선택지:** `profiles.remove` 권한만 믿기, 또는 **서비스에서 역할도 확인하기**.

**결정:** 두 겹 모두. 쿼리가 필요 없는 역할 검사를 맨 앞에 둡니다.

```ts
// The role, not just the permission: a personal GRANT of profiles.remove
// gets a manager past the guard, but never past this.
if (caller.roleCode !== 'OWNER' && caller.roleCode !== 'ADMIN') {
  throw new ForbiddenException('Only owners and the admin can remove members');
}
```

그다음 순서는 이렇습니다. 자기 자신은 안 됨(400, `/profiles/me/leave`를 안내), 호출한 사람의 회사로 범위를 좁힌 조회(다른 회사 구성원은 403이 아니라 **404**, 존재 여부조차 알려 주지 않음), 오너는 오너를 내보낼 수 없음(403), 그리고 상태 검사는 맨 마지막. 내보낼 수 없는 사람의 상태는 아무도 알 수 없게 하려는 것입니다.

**이유:** 권한은 한 사람에게 따로 부여할 수 있습니다(`profile_permissions`). "오너만 내보낼 수 있다" 같은 업무 규칙이 권한 하나로 뚫려서는 안 됩니다. 승인도 이미 같은 규칙을 따르고 있습니다.

**결과:** 두 가지 결정이 함께 따라왔습니다.

- **`DELETE /profiles/:id`가 아니라 `POST /profiles/:id/remove`, 응답은 204.** 지워지는 건 없습니다. 프로필은 `DEACTIVATED`로 남고, 모든 기록이 여전히 그 프로필을 가리킵니다.
- **권한 네 개 은퇴.** `profiles.create`, `profiles.update`, `profiles.delete`, `companies.update`는 몇 달째 시드되어 있었지만 **어떤 라우트도 확인한 적이 없었습니다.** 시드 목록에서 빼는 것만으로는 부족합니다. 시드의 `upsert(…, update: {})`는 추가만 할 뿐이니까요. 그래서 시드에 은퇴 단계를 넣었습니다. 두 부여 테이블 모두 `ON DELETE RESTRICT`로 권한을 가리키므로 부여 기록부터 지웁니다.

```ts
await prisma.$transaction([
  prisma.rolePermission.deleteMany({ where: { permission: { code: { in: retiredCodes } } } }),
  prisma.profilePermission.deleteMany({ where: { permission: { code: { in: retiredCodes } } } }),
  prisma.permission.deleteMany({ where: { code: { in: retiredCodes } } }),
]);
```

### 6. 계정 삭제: 무엇을 지우고, 무엇은 표시만 할까

**목표:** 삭제된 계정으로는 다시는 로그인도, 토큰 갱신도, 푸시 수신도 못 하게 하고, 그 전화번호와 로그인 수단으로는 새로 가입할 수 있게 하기. 하지만 **기록의 이름은 남깁니다.** 이력 행이 `ON DELETE RESTRICT`로 프로필을 가리키기 때문입니다.

**선택지:** 전부 하드 삭제(이력이 깨짐), 전부 소프트 삭제(재가입이 막힘), 또는 **행마다 따로 판단**.

**결정:** 유니크 인덱스가 삭제된 행을 무시하는지를 기준으로 정했습니다.

| 대상 | 유니크 규칙 | 그래서… |
|---|---|---|
| 전화번호 (계정에 있음) | `deleted_at IS NULL`인 행만 셈 | 계정을 소프트 삭제하면 번호가 풀림 |
| 카카오·구글 신원, 비밀번호 로그인 이메일 | **모든** 행을 셈 | 로그인 수단을 하드 삭제 |
| 프로필 | 이력이 가리킴 | `DEACTIVATED`로 남김 |
| 세션 | — | 폐기 표시 |
| 기기 토큰 | — | 삭제: 더는 푸시가 가지 않음 |

`DELETE /me`는 새로 받은 전화 인증(용도 `DELETE_ACCOUNT`, 계정 본인의 번호, 한 번만 사용) 뒤에서 이 모든 걸 하나의 트랜잭션으로 처리합니다.

```
1. lock the live account, reading its phone in the same statement
2. spend the proof (inside the transaction: a later failure gives it back)
3. leave every company, in companyId order
4. read the login methods, then delete them
5. revoke every live refresh token
6. delete the device tokens
7. set deleted_at; clear last_profile_id
```

1단계는 `updateManyAndReturn` 하나로 잠금과 전화번호 읽기를 한 번에 합니다. `[]`가 돌아오면, 두 번째 삭제 요청이 여기서 기다렸다가 이미 삭제된 계정을 발견한 것입니다(401).

**이유:** "어디서나 소프트 삭제"는 이 프로젝트의 관례지만, 관례는 기본값이지 법이 아닙니다. 결정 기준은 언제나 "유니크 인덱스가 이 행을 아직 보는가?"였습니다.

**결과:** 삭제된 계정의 e2e는 모든 자격 증명을 확인합니다. 예전 액세스 토큰과 리프레시 토큰은 401, 비밀번호 로그인도 401, `device_tokens`는 비어 있고, 그다음 같은 번호와 이메일로 다시 가입하고 같은 카카오 신원을 다시 연결할 수 있습니다.

### 7. 바깥세상과는 커밋한 뒤에만 이야기한다

**목표:** 애플은 계정을 삭제할 때 Sign in with Apple 토큰도 폐기하라고 요구합니다. 구글·카카오·페이스북에도 알릴 수 있습니다.

**선택지:** 트랜잭션 안에서 각 제공자를 호출하기, 또는 **커밋 뒤에 최선을 다해(best-effort) 호출하기**.

**결정:** 커밋 뒤에, 절대 예외를 던지지 않는 메서드 하나로.

| 트랜잭션 안에서 호출하면… | 문제 |
|---|---|
| 제공자가 몇 초씩 걸림 | 그동안 계정 잠금과 회사 잠금이 계속 잡혀 있음 |
| 그 뒤 트랜잭션이 롤백됨 | 애플은 이미 우리를 잊었는데 계정은 여기 그대로 남음 |

연결 해제 로직은 이미 `LoginMethodsService`의 private 메서드로 있었습니다(연결 해제 기능이 사용). 이를 별도의 `ProviderDisconnectService.disconnectQuietly`로 옮기고 `SocialAuthModule`에서 export했습니다. 연결 해제와 계정 삭제가 한 벌을 함께 쓰고, 삭제 쪽은 로그인 수단 서비스 전체가 아니라 딱 그 메서드만 받습니다.

**이유:** 그 시점에 계정은 실제로 삭제된 상태입니다. 구글이 잠깐 내려갔다고 500을 돌려주면, 사실은 성공했는데 사용자에게 "실패했다"고 말하는 셈입니다. 대신 실패는 우리가 볼 수 있게 로그로 남깁니다.

**결과:** 제공자 장애가 삭제를 막거나 되돌릴 수 없습니다. 스펙이 "동작하더라도 실패"로 꼽아 둔 상황을 정확히 피한 것입니다.

### 8. 계정 삭제는 아무도 import하지 않는 작은 모듈로

**목표:** `DELETE /me`가 머물 곳 정하기. 전화 인증, 제공자 연결 해제, 떠나기 절차, 관리자 확인까지 네 모듈이 필요합니다.

**선택지:** `AccountsModule`(가장 자연스러워 보이는 곳), `ProfilesModule`, `SocialAuthModule`, 또는 **새 모듈**.

**결정:** 네 모듈을 import하고, 아무도 import하지 않는 `AccountDeletionModule`.

**이유:** `AccountsModule`에 두면 연결 해제를 쓰려고 `SocialAuthModule`을 import해야 하는데, `SocialAuthModule`은 이미 `AccountsModule`을 import합니다. 순환입니다. `ProfilesModule`도 동작은 했겠지만, 그 모듈은 로그인이 아니라 한 회사 안의 한 사람에 관한 것입니다. 아무도 import하지 않는 모듈은 순환의 일부가 될 수 없습니다.

**결과:** 배선 테스트가 데이터베이스·스토리지·큐만 바꿔 끼운 실제 모듈 그래프를 만들어 보므로, export가 빠지면 앱 시작이 아니라 `npm test`에서 실패합니다.

### 9. 제가 요청한 가독성 규칙 두 가지

중간에 모든 파일에 영향을 주는 규칙 두 가지를 요청했습니다.

- **모든 `if`, `else`, 반복문 본문에 중괄호.** 한 줄짜리 `return`도 예외 없이, ESLint `curly: ['error', 'all']`로 강제합니다. 49개 파일을 고친 별도 커밋으로 넣어서, 기능 커밋은 읽기 쉽게 남겼습니다.
- **모든 Prisma `select`와 `where`는 쿼리 바로 그 자리에.** `PROFILE_SELECT` 같은 공유 상수는 줄 수를 아껴 주지만, 쿼리가 어떤 필드를 읽는지 보려면 다른 파일로 가야 했습니다. 눈에 보이는 반복이 찾아가야 하는 간접 참조보다 낫습니다.

## TIL (오늘 배운 것)

**"스태프와 매니저는 지점이 최소 하나는 있어야 하지 않나? 누군가의 마지막 지점이 되는 곳은 삭제를 막아야 하지 않나?"**
역할이 사람에게 있으면 그럴 필요가 없습니다. 그런 규칙은 지점에 저장된 무언가를 지키려고 존재합니다. 지점에 저장된 게 없으니, 그 사람은 역할을 유지한 채 새 지점을 기다리고, 삭제가 막히는 일도 없습니다.

**"어떤 역할은 지점에서 일하면서 카탈로그도 수정하고, 스태프는 쓰기만 한다. 이건 어디에 둬야 하나?"**
사람에게 둡니다. 카탈로그는 모든 지점이 함께 쓰니, 카탈로그에 대한 권한이 어떤 지점 행을 가졌는지에 좌우되면 안 됩니다. 4번 방식이 정답이 된 결정적인 질문이었습니다.

**"`isMarked`는 뭘 하는 거지?"**
데코레이터가 라우트에 붙여 둔 메타데이터를 읽습니다. `@Public()`과 `@AccountRoute()`는 그냥 `SetMetadata(KEY, true)`입니다. 가드가 `Reflector`에게 핸들러나 그 클래스에 그 키가 있는지 묻고, 그에 따라 요청을 통과시키거나 회사 확인을 건너뜁니다.

**"`select`를 한 번 정의해 두는 것 말고는 인라인밖에 방법이 없나?"**
아니요, 둘 다 됩니다(`satisfies Prisma.ProfileSelect`로 타입을 붙인 공유 객체도 문제없습니다). 인라인은 기술적 제약이 아니라 가독성을 위한 선택이었습니다.

**"왜 `filter`가 아니라 `flatMap`을 썼지?"**
`filter`는 타입 술어(type predicate)를 따로 쓰지 않으면 요소 타입을 그대로 두기 때문에, TypeScript는 여전히 `role`이 `null`일 수 있다고 봅니다. `flatMap`에서 `[]`(버림)나 `[item]`(남기면서 모양 바꿈)을 돌려주면 걸러내기와 변환을 한 번에 하고, 무엇이 나오는지 TypeScript가 정확히 압니다.

**"프로필 상태에는 뭐가 있고, 각각 무엇이 만드나?"**
다섯 가지입니다. `PENDING_APPROVAL`(합류하거나 회사를 만들 때), `ACTIVE`(승인), `DEACTIVATED`(나가기, 내보내기, 계정 삭제, 폐업). 그리고 `SUSPENDED`와 `REJECTED`는 enum에는 있지만 **아직 이를 설정하는 엔드포인트가 없습니다.** 떠나기 절차는 그래도 이 둘을 받아 주므로, 나중에 정지 기능이 생겨도 절차를 다시 쓸 필요가 없습니다.

**"계정 삭제에는 왜 컨트롤러와 서비스가 따로 필요하지?"**
Nest에서는 *클래스를 어디서 만들 수 있는지가 그 클래스에 필요한 것들로 정해지기* 때문입니다. 프로바이더는 자기 모듈이 제공하거나 import한 것만 받을 수 있습니다. 삭제에는 모듈 네 개가 필요하고, 순환 없이 넷을 모두 import할 수 있는 곳은 새 모듈뿐입니다. 컨트롤러는 자기 모듈이 보는 것만 주입받을 수 있으니 서비스를 따라갑니다.

**"`@Inject(SOCIAL_VERIFIERS)`는 뭘 하는 거지?"**
네 번 설명을 듣고서야 이해했으니, 통했던 버전을 적어 둡니다. Nest는 보통 생성자 매개변수의 **타입**을 보고 무엇을 넘길지 정합니다. `PrismaService` 같은 클래스는 그걸로 충분합니다. 그런데 verifier 맵의 타입은 `Record<…>`이고, 이건 TypeScript에만 존재하다가 코드가 실행될 때는 사라지기 때문에 Nest가 단서로 삼을 게 없습니다. 그래서 대신 **이름**을 붙여 주고, 같은 이름을 두 곳에 씁니다.

```ts
// 1. The module stores the value under a name
{ provide: SOCIAL_VERIFIERS, useFactory: buildSocialVerifiers }

// 2. The constructor asks for it by that name
@Inject(SOCIAL_VERIFIERS) private readonly verifiers: Record<SocialProvider, SocialIdentityVerifier>
```

경험칙: 클래스는 `@Inject`가 필요 없고, 그 밖의 것은 필요합니다. (`design:paramtypes`와 인젝터가 그 목록의 한 칸을 덮어쓰는 과정을 다룬 자세한 설명도 틀리진 않았지만, 저한테는 도움이 안 된 설명이었습니다.)

**"`ConfigService<Env, true>`는 뭐지?"**
`Env`는 검증을 거친 환경 변수의 형태라서, `get('LOGIN_TOKEN_ENCRYPTION_KEY')`가 그 키가 있다는 걸 압니다. `true`는 앱이 시작할 때 값들이 이미 검증됐다는 뜻이라서, `get`이 `string | undefined`가 아니라 `string`을 돌려줍니다.

그리고 물어볼 생각조차 못 했다가, diff를 검토하면서 배운 것들입니다.

| 대상 | 배운 점 |
|---|---|
| `:id`에 `ParseUUIDPipe` | 형식이 잘못된 id는 쿼리 전에 400. 이게 없으면 Postgres가 값을 거부하고 클라이언트는 500을 받음 |
| `@HttpCode(204)` | 따로 지정하지 않으면 Nest는 POST에 201, 나머지(DELETE 포함)에 200으로 응답 |
| `as const` + `Record<EventName, …>` | 이벤트 이름을 추가하면 채널을 정할 때까지 컴파일 에러. 타입 시스템이 표를 빠짐없이 지켜 줌 |
| `$transaction([...])` 대 `$transaction(async (tx) => …)` | 배열 형태는 서로 독립적인 쿼리를 한 트랜잭션에서 실행, 함수 형태는 읽고 확인하고 쓰는 흐름용 |
| DTO에 `import type` | 컴파일도 되고 앱도 뜨는데, **검증이 조용히 건너뛰어짐**: 파이프에 클래스 대신 `Object`가 보이기 때문 |

## NestJS 개념과 라이브러리

| 개념 / 라이브러리 | 사용한 이유 |
|---|---|
| **모듈: `imports` / `exports`** | 삭제에 필요한 것이 네 모듈에 흩어져 있음. 말단(leaf) 모듈로 순환 import를 피함 |
| **커스텀 프로바이더: `useFactory` + `@Inject(TOKEN)`** | 소셜 verifier 맵은 환경마다 다르게 만들어지고, 클래스가 아님 |
| **`emitDecoratorMetadata`** | 주입받는 클래스와 DTO가 왜 값(value) import여야 하는지 |
| **`SetMetadata` + `Reflector`** | `@AccountRoute()` 덕분에 `DELETE /me`는 회사를 열지 않아도 동작 |
| **`ParseUUIDPipe`, `ValidationPipe` + class-validator** | 잘못된 입력은 서비스가 돌기 전에 400 |
| **`@HttpCode`** | 내보내기와 계정 삭제는 204, 나가기는 요약과 함께 200 |
| **`@nestjs/event-emitter`** | `member.left`, `member.removed`, `member.roleChanged`, 모두 커밋 뒤에만 발행 |
| **Prisma 인터랙티브 `$transaction`** | 모든 출구가 공유 절차를 감싼 트랜잭션 하나 |
| **Prisma `updateManyAndReturn` / `createManyAndReturn({ skipDuplicates })`** | 잠금, 처리 결과 확인, 중복 감지를 에러를 잡지 않고 개수로 |
| **Postgres 부분 유니크 인덱스** | 한 사람당 한 지점에 살아 있는 배정 하나, 삭제된 계정은 전화번호를 풀어 줌 |
| **Postgres 행 잠금(`UPDATE`로 걸기)** | 회사 잠금 먼저, 계정 잠금 먼저, 어디서나 같은 잠금 순서 |
| **ESLint `curly: all`** | 어디서나 중괄호, 강제로 |
| **Jest: 타임라인 배열, `it.each`, `Reflect.getMetadata`, `Test.createTestingModule` 배선 테스트** | 단계의 정확한 순서, 모든 거절, 라우트 메타데이터, 모듈 배선을 데이터베이스 없이 검증 |
| **supertest + `Promise.all`** | 두 사람이 동시에 떠나기, 삭제와 연결을 동시에 |

## 마무리

이번 3부에서는 **한 사람이 여러 지점에서 일하기**(`profile_branches`), 후임 지명이나 폐업까지 포함한 **회사 떠나기**, 오너와 관리자의 **구성원 내보내기**, 그리고 전화 인증 뒤에서 소셜 제공자 연결까지 해제하는 **계정 삭제**를 만들었습니다. 엔드포인트 6개가 새로 생기고 1개가 사라졌고, 마이그레이션은 하나, 유닛 테스트 1403개와 e2e 324개가 모두 통과합니다.

이로써 구성원 관리 개편이 끝났습니다. 역할과 지점, 로그인 하나로 여러 회사, 그리고 이제 떠나는 방법까지요. 다음에 무엇을 할지는 아직 정하지 않았습니다. 스펙의 "나중을 위해" 목록에 가장 유력한 후보가 있습니다. 계정 삭제 시 개인정보를 지우는 일입니다. 언젠가 개인정보 보호법(PIPA)이 요구할 단계이고, 이번에는 일부러 "기록의 이름은 일단 남긴다"로 미뤄 둔 부분입니다.
