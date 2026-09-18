# Slice 3a — Order & Audit Export Implementation Plan

> **Workflow (this repo):** teaching-first, per-task. Claude teaches the delta, gives requirements + full reference code; **the user writes production code**, **Claude writes + runs tests**. Auto-commit + push at each green checkpoint. Verbose object literals (`{ id: id }`) — enforced by ESLint.

**Goal:** Download an order or audit + its line items as CSV (default) or `.xlsx`, in the fixed flat column layout from the spec.

**Architecture:** A shared `@Global() SpreadsheetModule` exposes `SpreadsheetService.toBuffer(format, columns, rows)` (exceljs, emits csv or xlsx from one workbook). `OrdersService`/`AuditsService` gain `exportOrder`/`exportAudit` that fetch the record with nested includes, map to rows, and call it; the controllers stream the result via `StreamableFile`.

**Tech Stack:** NestJS 11 (`StreamableFile`, `@Query`), `exceljs`, Prisma 7, Jest + supertest.

## Global Constraints
- CSV is the default; `?format=xlsx` opts into Excel; any other value → 400 (via `@IsIn`).
- **Localized headers:** `?lang=en|ko`, default `en`, any other value → 400. Columns are `{ key, label: { en, ko } }`; the service resolves `label[lang]` → the exceljs `header`. `key` stays stable/language-independent. `SpreadsheetService` never sees languages.
- Flat denormalized layout: one row per line item, header fields repeated. Columns exactly per spec.
- Export is a **read** — gate `orders.read` / `audits.read`, scope via `corners.findOne` then a corner-scoped record lookup.
- Timestamps as ISO 8601 strings; nullable fields (`description`, audit `appliedAt`) → empty string.
- Verbose object literals everywhere.

---

### Task 1: `exceljs` + `SpreadsheetService`

**Files:**
- `package.json` — add `exceljs` (Claude runs `npm install exceljs`).
- Create: `src/spreadsheet/spreadsheet.service.ts`, `src/spreadsheet/spreadsheet.module.ts`, `src/spreadsheet/dto/export-query.dto.ts`.
- Register `SpreadsheetModule` in `AppModule`.
- Test: `src/spreadsheet/spreadsheet.service.spec.ts` (Task 1b, Claude).

**Interfaces produced:**
- `SpreadsheetService.toBuffer(format: 'csv' | 'xlsx', columns: { header: string; key: string }[], rows: Record<string, unknown>[]): Promise<Buffer>`
- `ExportQueryDto { format?: 'csv' | 'xlsx' }`

**Reference — `src/spreadsheet/spreadsheet.service.ts`:**
```ts
import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

export type SpreadsheetFormat = 'csv' | 'xlsx';
export interface SpreadsheetColumn {
  header: string;
  key: string;
}

@Injectable()
export class SpreadsheetService {
  async toBuffer(
    format: SpreadsheetFormat,
    columns: SpreadsheetColumn[],
    rows: Record<string, unknown>[],
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Sheet1');
    worksheet.columns = columns.map((column) => ({
      header: column.header,
      key: column.key,
    }));
    worksheet.addRows(rows);

    const data =
      format === 'csv'
        ? await workbook.csv.writeBuffer()
        : await workbook.xlsx.writeBuffer();
    return Buffer.from(data as ArrayBuffer);
  }
}
```

**Reference — `src/spreadsheet/spreadsheet.module.ts`:**
```ts
import { Global, Module } from '@nestjs/common';
import { SpreadsheetService } from './spreadsheet.service';

@Global()
@Module({
  providers: [SpreadsheetService],
  exports: [SpreadsheetService],
})
export class SpreadsheetModule {}
```

**Reference — `src/spreadsheet/dto/export-query.dto.ts`:**
```ts
import { IsIn, IsOptional } from 'class-validator';

export type ExportLanguage = 'en' | 'ko';

export class ExportQueryDto {
  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx';

  @IsOptional()
  @IsIn(['en', 'ko'])
  lang?: ExportLanguage;
}
```

Register `SpreadsheetModule` in `AppModule` imports.

- [ ] `npm install exceljs`; user writes the three files + registers the module. `npm run build` clean.

---

### Task 1b: `SpreadsheetService` unit tests (Claude)

**File:** `src/spreadsheet/spreadsheet.service.spec.ts`
- `toBuffer('csv', …)`: decode `buffer.toString('utf8')`; first line equals the joined headers; a data line contains the expected values.
- `toBuffer('xlsx', …)`: buffer is non-empty and starts with the ZIP magic `PK` (`buffer.subarray(0, 2).toString() === 'PK'`).

- [ ] Write + `npm test` green.

---

### Task 2: Order export — service + controller

**Files:**
- Modify: `src/orders/orders.service.ts` (inject `SpreadsheetService`; add `exportOrder`).
- Modify: `src/orders/orders.controller.ts` (add the export route).
- Test: `src/orders/orders.service.spec.ts` (Task 3, Claude).

**Interface produced:** `exportOrder(caller: AuthUser, cornerId: string, orderId: string, format?: 'csv' | 'xlsx'): Promise<{ buffer: Buffer; filename: string; contentType: string }>`

**Teaching delta:** export is a read (`corners.findOne` scope, not `assertWorksCorner`). The record fetch needs *nested includes* to reach the names + barcodes: `createdByUser`, `companyStore`, and `orderItems → companyStoreProduct → product`. Map to one row per item, then hand columns+rows to `SpreadsheetService`. The controller returns a `StreamableFile` — NestJS sets the download headers from `{ type, disposition }`.

**Reference — additions to `orders.service.ts`:**
```ts
// imports:
import { SpreadsheetService } from '../spreadsheet/spreadsheet.service';

// constructor gains a 3rd arg:
//   constructor(
//     private readonly prisma: PrismaService,
//     private readonly corners: CornersService,
//     private readonly spreadsheet: SpreadsheetService,
//   ) {}

  private readonly ORDER_EXPORT_COLUMNS = [
    { key: 'orderId', label: { en: 'Order ID', ko: '주문 ID' } },
    { key: 'title', label: { en: 'Title', ko: '제목' } },
    { key: 'description', label: { en: 'Description', ko: '설명' } },
    { key: 'orderDate', label: { en: 'Order Date', ko: '주문일자' } },
    { key: 'userName', label: { en: 'Created By', ko: '작성자' } },
    { key: 'createdAt', label: { en: 'Created At', ko: '생성일시' } },
    { key: 'companyStoreName', label: { en: 'Corner', ko: '코너' } },
    { key: 'productBarcode', label: { en: 'Barcode', ko: '바코드' } },
    { key: 'productName', label: { en: 'Product', ko: '상품명' } },
    {
      key: 'productOrderQuantity',
      label: { en: 'Order Quantity', ko: '주문 수량' },
    },
  ];

  async exportOrder(
    caller: AuthUser,
    cornerId: string,
    orderId: string,
    format: 'csv' | 'xlsx' = 'csv',
    lang: 'en' | 'ko' = 'en',
  ) {
    await this.corners.findOne(caller, cornerId);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, companyStoreId: cornerId, deletedAt: null },
      include: {
        createdByUser: { select: { name: true } },
        companyStore: { select: { name: true } },
        orderItems: {
          include: {
            companyStoreProduct: {
              include: { product: { select: { barcode: true, name: true } } },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const rows = order.orderItems.map((item) => ({
      orderId: order.id,
      title: order.title,
      description: order.description ?? '',
      orderDate: order.orderDate.toISOString(),
      userName: order.createdByUser.name,
      createdAt: order.createdAt.toISOString(),
      companyStoreName: order.companyStore.name,
      productBarcode: item.companyStoreProduct.product.barcode,
      productName: item.companyStoreProduct.product.name,
      productOrderQuantity: item.productOrderQuantity,
    }));

    const columns = this.ORDER_EXPORT_COLUMNS.map((column) => ({
      header: column.label[lang],
      key: column.key,
    }));
    const buffer = await this.spreadsheet.toBuffer(format, columns, rows);
    return {
      buffer: buffer,
      filename: `order-${order.id}.${format}`,
      contentType:
        format === 'csv'
          ? 'text/csv'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
```

**Reference — additions to `orders.controller.ts`:**
```ts
// imports: Query, StreamableFile from '@nestjs/common';
// import { ExportQueryDto } from '../spreadsheet/dto/export-query.dto';

  @RequirePermissions('orders.read')
  @Get(':orderId/export')
  async export(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Query() query: ExportQueryDto,
  ): Promise<StreamableFile> {
    const { buffer, filename, contentType } = await this.orders.exportOrder(
      caller,
      cornerId,
      orderId,
      query.format,
      query.lang,
    );
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }
```

- [ ] User writes both. `npm run build` clean.

---

### Task 3: Order export unit tests (Claude)

**File:** `src/orders/orders.service.spec.ts` — add a `spreadsheet` mock (`toBuffer: jest.fn().mockResolvedValue(Buffer.from('x'))`) as the 3rd constructor arg; add `describe('exportOrder')`:
- Builds one row per item with header fields repeated + barcode/name/qty mapped, ISO timestamps, `description` null → `''`; asserts the `columns` + `rows` passed to `toBuffer`.
- Default format → `filename` ends `.csv`, `contentType` `text/csv`; `format: 'xlsx'` → `.xlsx` + spreadsheet content-type.
- Default `lang` → EN headers passed to `toBuffer` (`header: 'Order ID'`, `key: 'orderId'`); `lang: 'ko'` → KO headers (`header: '주문 ID'`), same `key`s.
- Absent/other-tenant order → `NotFoundException`.

- [ ] Write + `npm test` green.

---

### Task 4: Audit export — service + controller

Same shape as Task 2, on `AuditsService`/`AuditsController`, gated `audits.read`, with the audit columns (includes `appliedAt`).

**Reference — additions to `audits.service.ts`** (inject `SpreadsheetService` as the 4th arg — after prisma, corners, inventory):
```ts
  private readonly AUDIT_EXPORT_COLUMNS = [
    { key: 'auditId', label: { en: 'Audit ID', ko: '실사 ID' } },
    { key: 'title', label: { en: 'Title', ko: '제목' } },
    { key: 'description', label: { en: 'Description', ko: '설명' } },
    { key: 'auditedDate', label: { en: 'Audit Date', ko: '실사일자' } },
    { key: 'userName', label: { en: 'Created By', ko: '작성자' } },
    { key: 'createdAt', label: { en: 'Created At', ko: '생성일시' } },
    { key: 'appliedAt', label: { en: 'Applied At', ko: '적용일시' } },
    { key: 'companyStoreName', label: { en: 'Corner', ko: '코너' } },
    { key: 'productBarcode', label: { en: 'Barcode', ko: '바코드' } },
    { key: 'productName', label: { en: 'Product', ko: '상품명' } },
    {
      key: 'productQuantity',
      label: { en: 'Counted Quantity', ko: '실사 수량' },
    },
  ];

  async exportAudit(
    caller: AuthUser,
    cornerId: string,
    auditId: string,
    format: 'csv' | 'xlsx' = 'csv',
    lang: 'en' | 'ko' = 'en',
  ) {
    await this.corners.findOne(caller, cornerId);
    const audit = await this.prisma.inventoryAudit.findFirst({
      where: { id: auditId, companyStoreId: cornerId, deletedAt: null },
      include: {
        createdByUser: { select: { name: true } },
        companyStore: { select: { name: true } },
        inventoryAuditItems: {
          include: {
            companyStoreProduct: {
              include: { product: { select: { barcode: true, name: true } } },
            },
          },
        },
      },
    });
    if (!audit) throw new NotFoundException('Audit not found');

    const rows = audit.inventoryAuditItems.map((item) => ({
      auditId: audit.id,
      title: audit.title,
      description: audit.description ?? '',
      auditedDate: audit.auditedDate.toISOString(),
      userName: audit.createdByUser.name,
      createdAt: audit.createdAt.toISOString(),
      appliedAt: audit.appliedAt ? audit.appliedAt.toISOString() : '',
      companyStoreName: audit.companyStore.name,
      productBarcode: item.companyStoreProduct.product.barcode,
      productName: item.companyStoreProduct.product.name,
      productQuantity: item.productQuantity,
    }));

    const columns = this.AUDIT_EXPORT_COLUMNS.map((column) => ({
      header: column.label[lang],
      key: column.key,
    }));
    const buffer = await this.spreadsheet.toBuffer(format, columns, rows);
    return {
      buffer: buffer,
      filename: `audit-${audit.id}.${format}`,
      contentType:
        format === 'csv'
          ? 'text/csv'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
```

**Reference — `audits.controller.ts`** — same as orders, `audits.read`, `:auditId/export`, calls `this.audits.exportAudit(...)`.

- [ ] User writes both. `npm run build` clean.

---

### Task 5: Audit export unit tests (Claude)

`src/audits/audits.service.spec.ts` — add `spreadsheet` mock (4th arg); `describe('exportAudit')` mirroring Task 3 plus an `appliedAt` case (applied → ISO; not applied → `''`).

- [ ] Write + `npm test` green.

---

### Task 6: e2e + green checkpoint + commit (Claude)

`test/*.e2e-spec.ts` (extend the orders + audits suites, or add a small `exports.e2e-spec.ts`):
- `GET …/orders/:id/export` (default) → 200, `Content-Type` starts `text/csv`, body's first line equals the order header contract and body contains a seeded product barcode.
- `?format=xlsx` → `Content-Type` is the spreadsheet type; body starts with `PK`.
- `?lang=ko` → the first line is the KO header row; `?format=bogus` / `?lang=bogus` → 400.
- Same for audit export.

- [ ] Write; **human runs `npm run test:e2e`**. On green: commit (`feat(orders,audits): CSV/xlsx export`) + push; update STATUS (relabel Files track, 3a done, 3b next).

---

## Self-Review
- **Spec coverage:** SpreadsheetService (T1) + test (T1b); order export (T2) + test (T3); audit export incl. appliedAt (T4) + test (T5); e2e + done (T6). ✅
- **Type consistency:** `format: 'csv' | 'xlsx'` throughout; `toBuffer` signature stable; column key strings match the row object keys in both services. ✅
- **No placeholders:** all code shown. ✅
- **Constructor churn:** `orders.service.spec.ts` (3rd arg) and `audits.service.spec.ts` (4th arg) need the spreadsheet mock — flagged in T3/T5.
