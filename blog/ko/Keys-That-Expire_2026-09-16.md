# 만료되는 키 (Keys That Expire)

> URL이 아니라 key를 저장한다 — Inventra가 MinIO와 presigned URL, 그리고 셀프서비스 방식으로 파일을 다루게 된 이야기.

*2026-09-16*

## 들어가며

[Inventra](https://github.com/develoHAM/inventra_backend)는 **NestJS 11 + Prisma 7 + PostgreSQL**로 만든 멀티테넌트 재고관리 SaaS다. 한국의 편집숍/매장 모델(회사가 실제 매장 안에서 "코너"를 운영하는 구조)을 본떴다. 지금까지 도메인은 사실상 완성됐다 — 상품, 진열(placement), 재고 원장, 발주, 실사(audit), 예약까지. 그런데 정작 **사진 한 장을 저장하지 못했다.**

이번 단계에서는 **파일 업로드 서브시스템**을 만들었다. 재사용 가능한 스토리지 기반을 먼저 깔고, 세 종류의 엔티티에 이미지 업로드를 붙였다 — **상품 이미지**, **브랜드 로고**, 그리고 **유저 아바타**. 작업하면서 깨달은 건, 파일 업로드에서 가장 어려운 건 업로드 자체가 아니라는 것이다. **무엇을 저장할지, 누가 건드릴 수 있는지, 그리고 "사소한" 설정 오타 하나가 어떻게 테스트 스위트 전체를 무너뜨리는지**가 진짜 어려운 부분이었다.

## 아키텍처 결정들

### 1. 바이트를 어디에 둘 것인가? → DB가 아니라 MinIO (S3 호환)

**목표:** 재시작해도 남아 있고, 한 대의 서버를 넘어 확장 가능한 이미지 저장소.

**선택지:**
- Postgres에 `bytea` 컬럼으로 저장.
- 서버 로컬 디스크에 파일 쓰기.
- AWS S3 직접 사용.
- **MinIO** — 셀프호스팅 가능한 S3 호환 오브젝트 스토리지 — 를 Docker로 실행.

**선택:** 로컬에서는 MinIO, 접근은 **AWS SDK v3**(`@aws-sdk/client-s3`)로.

**이유:** blob을 Postgres에 넣으면 hot 테이블과 WAL이 비대해진다. 로컬 디스크는 컨테이너가 죽으면 사라지고 수평 확장도 안 된다. MinIO는 S3 API를 *그대로* 구현하므로, 내 노트북의 MinIO를 상대로 돌던 코드가 프로덕션의 실제 AWS S3에서도 그대로 돈다 — 코드 변경 0, env 변수만 다르면 된다. 클라우드 패리티(parity)를 공짜로 얻으면서 DB는 가볍게 유지한다.

**결과:** `putObject`, `presignPutUrl`, `presignGetUrl`, `objectExists`, `deleteObject`를 가진 `StorageService`를 노출하는 단일 `@Global() StorageModule`. 이후 모든 슬라이스는 그냥 주입만 하면 된다.

### 2. URL이 아니라 **key**를 저장하고, 읽을 때 presign한다

**목표:** 기본적으로 비공개(private)인 이미지를 서빙하기.

**선택지:**
- 버킷을 public으로 열고 DB에 평범한 URL 저장.
- 수명이 긴 signed URL 저장.
- 오브젝트 **key**(`products/<id>/<uuid>.png`)만 저장하고, 행을 읽을 때마다 새 presigned GET URL 생성.

**선택:** key를 저장하고 **읽을 때 presign**.

**이유:** 저장된 URL은 부채(liability)다. public URL은 곧 파일이 비공개가 아니라는 뜻이다. 수명이 긴 signed URL은 만료되는 순간 죽은 값이 된다 — 만료를 안 시키면 그냥 public URL을 번거롭게 만든 셈이다. 진짜로 안정적인 건 **key**뿐이다. 읽을 때 presign하면 매 응답마다 현재 자격증명과 만료 시간으로 서명된, 수명 짧은 비공개 링크가 실린다.

**결과:** DB 컬럼(`imageUrl` / `logoUrl` / `profileImageUrl`)은 정본(canonical) key를 담고, 읽을 때 `X-Amz-Signature`가 붙은 새 presigned URL로 바꿔 준다. 구조적으로 비공개다.

### 3. 두 갈래의 업로드: proxied 그리고 presigned

**목표:** 클라이언트가 업로드하게 하고, 보낸 걸 검증하기.

**선택지:** proxied(바이트가 API를 통과), presigned(클라이언트가 MinIO로 직접 PUT), 또는 둘 다.

**선택:** 둘 다.

**이유:** proxied 경로(`POST /.../image`)는 아주 단순하고, API가 파일을 인라인으로 검증할 수 있다 — `ParseFilePipe`에 `MaxFileSizeValidator`(5 MB)와 `FileTypeValidator`(jpeg/png/webp)를 걸어 쓰레기 파일을 저장 전에 걸러낸다. presigned 경로(`presign → 클라이언트가 스토리지로 PUT → confirm`)는 바이트 스트림을 API에서 *완전히* 떼어낸다. 큰 파일과 확장성에 유리하다. 대신 서버가 바이트를 못 보므로, `confirm` 단계가 신뢰를 다시 세운다 — key가 올바른 prefix 아래에 있는지, 오브젝트가 실제로 존재하는지 확인한다.

**결과:** 안전성을 잃지 않으면서 유연성 확보. 가벼운 클라이언트는 한 방에 끝나는 proxied 경로를, 무거운 쪽은 presigned 핸드셰이크를 쓴다.

### 4. 셀프서비스 아바타: 잘못된 동작을 *표현 불가능하게* 만들기

**목표:** 유저가 자기 아바타를 설정하게 하되, *오직 자기 것만*.

**선택지:**
- `POST /users/:id/avatar`, `users.update` 권한 + 회사 스코핑으로 보호.
- `POST /users/me/avatar`, 대상이 항상 호출자(caller).
- 둘 다.

**선택:** 셀프서비스만. 이 라우트에는 **`:id`도 없고** **`@RequirePermissions`도 없다.**

**이유:** 이번 단계에서 가장 마음에 드는 결정이다. `:id` 파라미터가 없으면, 다른 유저의 id를 *받을 수 있는* 라우트 형태 자체가 존재하지 않는다 — 남의 아바타 수정이 *금지된* 게 아니라 **표현 불가능(unrepresentable)**하다. 이건 인가 체크보다 강한 보장이다. 틀릴 체크 자체가 없으니까. 이 엔드포인트는 전역 `JwtAuthGuard`에 인증을 맡기고(그래서 로그인은 필수), 모든 메서드는 토큰의 `caller.id`를 대상으로 한다.

**결과:** 크로스테넌트 표면 0, 새 권한 0, 그리고 `confirm` 가드가 여전히 key를 `users/<caller.id>/`에 고정한다.

### 5. 공유하는 DTO 한 쌍

presign 바디(`{ contentType }`)와 confirm 바디(`{ key }`)는 상품·브랜드·유저에서 동일하다. 세 번째로 복붙하는 대신 `src/storage/dto/`로 끌어올려 `PresignUploadDto` / `ConfirmUploadDto`로 만들었다. 상품은 일단 로컬 복사본을 유지한다 — 슬라이스 중간에 테스트된 코드를 리팩터링해봐야 얻는 게 없다. YAGNI는 양쪽으로 작동한다.

## TIL (오늘 배운 것)

### 파일 확장자를 왜 `'bin'`으로 기본값 처리하지?

key를 만드는 코드는 `const ext = IMAGE_EXT[contentType] ?? 'bin'`이다. 물어봤다 — 대체 `'bin'`이 언제 나오지? 답: **지금은 절대 안 나온다.** 두 진입점 모두 이 줄이 실행되기 전에 이미 비(非)이미지 타입을 거부한다 — proxied는 `FileTypeValidator`, presigned는 DTO의 `@IsIn([...])`. 그래서 `'bin'`은 살아있는 분기가 아니라 *페일세이프*다: `IMAGE_EXT` 맵과 허용 목록은 서로 일치해야 하는 두 리스트인데, 언젠가 어긋나면(누가 한쪽에만 `image/gif`를 추가하면) 이 fallback이 깨진 `.undefined` 대신 멀쩡한 `.bin` key를 만들어 준다. 미래의 유지보수 지뢰에 대비하는 토큰 하나짜리 보험이다.

### 한 글자짜리 자격증명 오타가 e2e 스위트 *전체*를 무너뜨렸다

e2e를 돌렸더니 **전부** 실패했다 — reservations, inventory, audits, orders. 파일과 무관한 것들인데. 모든 스택 트레이스가 같은 줄에서 끝났다: `StorageService.onModuleInit`이 `SignatureDoesNotMatch`를 던졌다.

원인: `docker compose`는 MinIO의 루트 자격증명을 `.env`(기본 env 파일)에서 읽는데, 테스트 프로세스는 요청을 `.env.test`의 `S3_SECRET_KEY`로 서명한다. 둘이 어긋나 있었다 — 하나는 `letsmakesomemoney98$`, 다른 하나는 `minioadmin`. MinIO는 *자기* 시크릿으로 서명을 다시 계산하고, 두 HMAC이 안 맞으니 요청이 거부된다.

그런데 왜 업로드를 전혀 안 하는 스위트까지 무너졌을까? `StorageModule`이 `@Global()`이라서 `StorageService`가 *모든* 모듈의 `AppModule`에서 부팅되고, 그 `OnModuleInit`의 버킷 확인이 `app.init()` 도중 — 어떤 테스트 본문보다 먼저 — 실행되기 때문이다. **전역 모듈의 부팅 시점 사이드이펙트는 공유되는 실패 표면이다.** 시크릿 하나 맞추자 전부 초록불이 됐다.

### S3가 같은 key면 덮어쓰는데, 왜 업로드 후 삭제를 하지?

같은 key로 PUT하면 이미지를 교체할 수 있을 거라 생각했다. S3는 실제로 덮어쓴다 — 하지만 우리는 업로드마다 일부러 **새 UUID**를 생성한다(`products/<id>/<uuid>.png`). 그래서 key는 사실상 불변이다. 왜? presigned URL과 그 앞단의 CDN이 *key 단위로* 캐싱하기 때문이다. key를 재사용하면 교체한 뒤에도 뷰어가 한참 동안 캐시된 옛 이미지를 계속 볼 수 있다. 새 key는 캐싱 문제를 아예 우회하고 교체를 원자적으로 만든다 — 새 오브젝트를 쓰고, 행이 그걸 가리키게 하고, 그다음 옛것을 지운다.

### `eslint --fix`는 네가 의도한 하나가 아니라 *전부*를 고친다

객체 리터럴을 장황하게(`{ id: id }`, `{ id }` 아님) 프로젝트 전역에 강제하고 싶어서 `object-shorthand` 룰을 추가하고 `npm run lint`를 돌렸다 — 이건 `eslint … --fix`다. shorthand를 펼쳤고 *동시에* 테스트에서 `as any` 캐스트 35개를 조용히 없앴다(한 번도 돌린 적 없던 `no-unnecessary-type-assertion` 룰 때문에). 교훈: `--fix`는 *전체* 룰셋의 자동수정을 적용한다. 딱 한 가지만 바꾸는 일회성 변환이라면, 원하는 룰만 담은 최소 임시 설정으로 돌리고 — 커밋 전에 diff를 확인하라.

## NestJS 개념 & 라이브러리

| 개념 / 라이브러리 | 왜 썼나 |
|---|---|
| `@Global()` 모듈 | 기능 모듈마다 `StorageModule`을 다시 import하지 않고 `StorageService`를 앱 전역에 노출. |
| `OnModuleInit` | 부팅 시 버킷 존재를 한 번 보장(HeadBucket → 없으면 CreateBucket). |
| `FileInterceptor` (`@nestjs/platform-express`) | 요청의 multipart `file` 필드 파싱(내부적으로 multer). |
| `ParseFilePipe` + `MaxFileSizeValidator` + `FileTypeValidator` | 핸들러 실행 전, 라우트별 선언적 업로드 검증 — 크기 + MIME. |
| `@UploadedFile()` | 파싱된 파일을 핸들러에 주입. |
| `APP_GUARD` + `JwtAuthGuard` | 전역 인증 — `@RequirePermissions`가 *없는* 라우트도 로그인 필수인 이유. |
| `@aws-sdk/client-s3` | MinIO를 상대로 한 S3 연산(put / head / delete / create-bucket). |
| `@aws-sdk/s3-request-presigner` (`getSignedUrl`) | presigned PUT/GET URL 생성 — 로컬에서 서명, 네트워크 왕복 없음. |
| `ConfigService` + Zod env 스키마 | `S3_ENDPOINT`/`S3_BUCKET` 등에 대한 타입 안전·검증된 접근. |
| `ParseIntPipe` vs `ParseUUIDPipe` | 브랜드는 정수 id, 상품/유저는 UUID — 파이프가 올바른 형태를 강제. |
| ESLint `object-shorthand: 'never'` | 앞으로 장황한 객체 리터럴 하우스 스타일을 강제. |

## 마무리

두 슬라이스를 지나며 Inventra는 재사용 가능한 스토리지 기반을 갖췄고, 상품·브랜드·유저에 비공개·presigned 이미지를 붙일 수 있게 됐다 — 마지막 아바타는 설계상 셀프서비스로. 반복된 주제는 **무엇을 영속화하는가**였다: URL이 아니라 key를 저장하고, key를 재사용하지 말고 새로 만들고, "오직 나 자신"을 가드가 아니라 *라우트 형태*로 표현하라.

**다음 — 슬라이스 3: 발주·실사 파일.** 여기서부터 흥미로워진다: 파일은 여전히 비공개·presigned지만, 이미 **적용(applied)된** 실사는 얼어붙은 역사다 — 그래서 가드는 이미 편집을 거부하는 것과 똑같이, 확정된 실사에 문서를 붙이는 것도 거부해야 한다. 불변성을, 끝까지.
