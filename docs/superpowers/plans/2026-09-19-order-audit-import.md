# Slice 3b — Order & Audit Import Implementation Plan

> **Workflow:** teaching-first, per-task. Claude teaches the delta + gives full reference code; **the user writes production code**, **Claude writes + runs tests**. Auto-commit + push at green checkpoints. Verbose object literals (`{ id: id }`).

**Goal:** Upload a CSV/xlsx in the 3a layout to create or replace an order/audit + items, resolving barcodes → placements, reporting all row errors at once.

**Architecture:** `SpreadsheetService.parse` (pure, exceljs, both formats) → each service parses + validates + resolves barcodes, then **reuses its own `create`/`update`** for the write. 4 routes (order/audit × create/update).

**Tech Stack:** NestJS 11 (`FileInterceptor`, `ParseFilePipe`, `HttpCode`), exceljs, Prisma 7, Jest + supertest.

## Global Constraints
- Format from filename extension (`.csv`/`.xlsx`), else 400. Max 10 MB.
- Header row skipped; its column count must equal `*_EXPORT_COLUMNS.length`, else 400. Column positions looked up by `key` in `*_EXPORT_COLUMNS` (shared with export). Header text ignored (language-agnostic).
- Collect ALL row errors → `throw new BadRequestException({ message: 'Import failed', errors: [{ row, error }] })`; `row` = sheet line (header = 1). Nothing written on any error.
- Header fields from the first data row: `title` (req, ≤255), `description` (optional; blank → omitted), date (valid). Quantity: integer, order ≥ 1 / audit ≥ 0. Duplicate barcode across rows → error.
- On success, build the Create/Update DTO and call the existing `create`/`update` (reuse the `$transaction`). Import methods call `assertWorksCorner` first.
- Verbose object literals.

---

### Task 1: `SpreadsheetService.parse`

**File:** modify `src/spreadsheet/spreadsheet.service.ts`. Test: `spreadsheet.service.spec.ts` (Task 1b).

**Interface produced:** `parse(format: 'csv' | 'xlsx', buffer: Buffer): Promise<string[][]>`

**Reference — add to `spreadsheet.service.ts`:**
```ts
// add import at top:
import { Readable } from 'node:stream';

  async parse(format: SpreadsheetFormat, buffer: Buffer): Promise<string[][]> {
    const workbook = new ExcelJS.Workbook();
    let worksheet: ExcelJS.Worksheet | undefined;
    if (format === 'csv') {
      worksheet = await workbook.csv.read(Readable.from(buffer));
    } else {
      await workbook.xlsx.load(buffer);
      worksheet = workbook.worksheets[0];
    }
    if (!worksheet) return [];

    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as unknown[]; // 1-based; index 0 is empty
      rows.push(
        values
          .slice(1)
          .map((value) =>
            value === null || value === undefined ? '' : String(value),
          ),
      );
    });
    return rows;
  }
```

- [ ] User adds the method + import. `npm run build` clean.

---

### Task 1b: `parse` unit tests (Claude)

Extend `spreadsheet.service.spec.ts`:
- CSV buffer (`Buffer.from('name,qty\nWidget,10\n')`) → `[['name','qty'],['Widget','10']]`.
- Round-trip: `toBuffer('xlsx', cols, rows)` then `parse('xlsx', buf)` → header + data rows match (cells stringified).

- [ ] Write + `npm test` green.

---

### Task 2: Orders import — service + controller

**Files:** modify `src/orders/orders.service.ts` (+ `SpreadsheetService` already injected from 3a) and `src/orders/orders.controller.ts`. Test: `orders.service.spec.ts` (Task 3).

**Interfaces produced:**
- `importCreate(caller, cornerId, file): Promise<order>`
- `importUpdate(caller, cornerId, orderId, file): Promise<order>`

**Reference — add to `orders.service.ts`** (needs `BadRequestException`, already imported; `CreateOrderDto` imported):
```ts
  private orderColIndex(key: string): number {
    return this.ORDER_EXPORT_COLUMNS.findIndex((column) => column.key === key);
  }

  private async buildOrderDtoFromFile(
    cornerId: string,
    file: Express.Multer.File,
  ): Promise<CreateOrderDto> {
    const ext = file.originalname.split('.').pop()?.toLowerCase();
    const format = ext === 'csv' ? 'csv' : ext === 'xlsx' ? 'xlsx' : null;
    if (!format) throw new BadRequestException('File must be .csv or .xlsx');

    const rows = await this.spreadsheet.parse(format, file.buffer);
    if (rows.length === 0) throw new BadRequestException('The file is empty');
    if (rows[0].length !== this.ORDER_EXPORT_COLUMNS.length)
      throw new BadRequestException('Unexpected column layout');
    const dataRows = rows.slice(1);
    if (dataRows.length === 0)
      throw new BadRequestException('The file has no data rows');

    const titleIdx = this.orderColIndex('title');
    const descIdx = this.orderColIndex('description');
    const dateIdx = this.orderColIndex('orderDate');
    const barcodeIdx = this.orderColIndex('productBarcode');
    const qtyIdx = this.orderColIndex('productOrderQuantity');

    const errors: { row: number; error: string }[] = [];

    const title = (dataRows[0][titleIdx] ?? '').trim();
    if (!title) errors.push({ row: 2, error: 'Title is required' });
    else if (title.length > 255)
      errors.push({ row: 2, error: 'Title exceeds 255 characters' });
    const descriptionRaw = (dataRows[0][descIdx] ?? '').trim();
    const orderDate = (dataRows[0][dateIdx] ?? '').trim();
    if (!orderDate || Number.isNaN(Date.parse(orderDate)))
      errors.push({ row: 2, error: 'Invalid order date' });

    // one file = one order: every later data row must repeat the same header cells
    dataRows.slice(1).forEach((dataRow, index) => {
      const line = index + 3; // rows 3..N (first data row was line 2)
      if ((dataRow[titleIdx] ?? '').trim() !== title)
        errors.push({ row: line, error: 'Title differs from the first data row' });
      if ((dataRow[descIdx] ?? '').trim() !== descriptionRaw)
        errors.push({
          row: line,
          error: 'Description differs from the first data row',
        });
      if ((dataRow[dateIdx] ?? '').trim() !== orderDate)
        errors.push({
          row: line,
          error: 'Order Date differs from the first data row',
        });
    });

    const barcodes = dataRows.map((dataRow) => (dataRow[barcodeIdx] ?? '').trim());
    const products = await this.prisma.product.findMany({
      where: {
        barcode: { in: barcodes.filter((barcode) => barcode.length > 0) },
        deletedAt: null,
      },
      select: { id: true, barcode: true },
    });
    const productIdByBarcode = new Map(
      products.map((product) => [product.barcode, product.id]),
    );
    const placements = await this.prisma.companyStoreProduct.findMany({
      where: {
        companyStoreId: cornerId,
        productId: { in: products.map((product) => product.id) },
        deletedAt: null,
      },
      select: { id: true, productId: true },
    });
    const placementIdByProductId = new Map(
      placements.map((placement) => [placement.productId, placement.id]),
    );

    const seenBarcodes = new Set<string>();
    const items: { companyStoreProductId: number; productOrderQuantity: number }[] =
      [];

    dataRows.forEach((dataRow, index) => {
      const line = index + 2; // sheet line (header is line 1)
      const barcode = (dataRow[barcodeIdx] ?? '').trim();
      const quantity = Number((dataRow[qtyIdx] ?? '').trim());

      if (!barcode) {
        errors.push({ row: line, error: 'Barcode is required' });
        return;
      }
      if (seenBarcodes.has(barcode)) {
        errors.push({ row: line, error: `Duplicate barcode "${barcode}"` });
        return;
      }
      seenBarcodes.add(barcode);

      const productId = productIdByBarcode.get(barcode);
      if (productId === undefined) {
        errors.push({ row: line, error: `Unknown barcode "${barcode}"` });
        return;
      }
      const placementId = placementIdByProductId.get(productId);
      if (placementId === undefined) {
        errors.push({
          row: line,
          error: `Barcode "${barcode}" is not placed on this corner`,
        });
        return;
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        errors.push({ row: line, error: 'Quantity must be an integer ≥ 1' });
        return;
      }
      items.push({
        companyStoreProductId: placementId,
        productOrderQuantity: quantity,
      });
    });

    if (errors.length > 0)
      throw new BadRequestException({ message: 'Import failed', errors: errors });

    const dto: CreateOrderDto = {
      title: title,
      orderDate: orderDate,
      items: items,
    } as CreateOrderDto;
    if (descriptionRaw) dto.description = descriptionRaw;
    return dto;
  }

  async importCreate(
    caller: AuthUser,
    cornerId: string,
    file: Express.Multer.File,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const dto = await this.buildOrderDtoFromFile(cornerId, file);
    return this.create(caller, cornerId, dto);
  }

  async importUpdate(
    caller: AuthUser,
    cornerId: string,
    orderId: string,
    file: Express.Multer.File,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const dto = await this.buildOrderDtoFromFile(cornerId, file);
    return this.update(caller, cornerId, orderId, dto);
  }
```

**Reference — add to `orders.controller.ts`** (imports: `HttpCode`, `ParseFilePipe`, `MaxFileSizeValidator`, `UploadedFile`, `UseInterceptors` from `@nestjs/common`; `FileInterceptor` from `@nestjs/platform-express`):
```ts
  @RequirePermissions('orders.create')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  importCreate(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.orders.importCreate(caller, cornerId, file);
  }

  @RequirePermissions('orders.update')
  @Post(':orderId/import')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  importUpdate(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.orders.importUpdate(caller, cornerId, orderId, file);
  }
```

- [ ] User writes both. `npm run build` clean.

---

### Task 3: Orders import unit tests (Claude)

`orders.service.spec.ts` `describe('import')` — a `csvBuffer(rows)` helper builds a header + data lines; `spreadsheet.parse` mock returns parsed arrays (or set `spreadsheet.parse = jest.fn()` returning `string[][]`); `file` = `{ originalname: 'o.csv', buffer: Buffer.from(...) }`.
- valid file → `create` called with `{ title, orderDate, items: [{ companyStoreProductId, productOrderQuantity }] }` (barcodes resolved via mocked `product.findMany` + `companyStoreProduct.findMany`); `importUpdate` → `update` called.
- collect-all: file with an unknown barcode (row 2), bad qty (row 3), duplicate (row 4) → `BadRequestException`; `err.getResponse().errors` has an entry per offending line; `create` NOT called.
- bad extension (`x.txt`) → 400; wrong column count → 400; header-only → 400.

- [ ] Write + `npm test` green.

---

### Task 4: Audits import — service + controller

Mirror Task 2 on `AuditsService`/`AuditsController`. Differences: `AUDIT_EXPORT_COLUMNS`, date key `auditedDate`, quantity key `productQuantity` with **min 0** (`!Number.isInteger(quantity) || quantity < 0`), item shape `{ companyStoreProductId, productQuantity }`, gates `audits.create`/`audits.update`, and `importUpdate` calls `this.update(...)` which throws **409 if applied**. Build a `CreateAuditDto` (`title`, `auditedDate`, `items`, optional `description`).

- [ ] User writes both. `npm run build` clean.

---

### Task 5: Audits import unit tests (Claude)

`audits.service.spec.ts` `describe('import')` mirroring Task 3, plus: quantity `0` is accepted (audit min 0); `importUpdate` onto an applied audit → `ConflictException` (the mocked `update`/`findFirst` returns `appliedAt` set → 409).

- [ ] Write + `npm test` green.

---

### Task 6: e2e + green checkpoint + commit (Claude)

Extend `test/orders.e2e-spec.ts` + `test/audits.e2e-spec.ts` (reuse fixtures + the export cases):
- **Round-trip:** export an order to CSV → re-`POST …/orders/import` (create) → 201, new order with the same item(s) (assert quantity + item count).
- **Error list:** import a CSV with a bogus-barcode row → 400 with `body.errors` naming that line.
- **xlsx create:** build/import an `.xlsx` → 201.
- **Update:** `POST …/orders/:orderId/import` → 200, items replaced.
- **Audit:** create + update; update-import onto an applied audit → 409.

- [ ] Write; **human runs `npm run test:e2e`**. On green: commit + push; update STATUS (Slice 3b done → import/export feature complete; offer the `/phase-blog`).

---

## Self-Review
- **Spec coverage:** parse (T1/1b), orders import (T2/T3), audits import (T4/T5), e2e (T6). ✅
- **Type consistency:** `parse` returns `string[][]`; item shapes `{ companyStoreProductId, productOrderQuantity }` (order) / `{ …, productQuantity }` (audit); reuse of `create`/`update` matches their existing signatures. ✅
- **No placeholders:** orders reference is complete; audits is "mirror + explicit diffs". ✅
- **Constructor:** `SpreadsheetService` already injected into both services (3a) — no constructor churn this slice.
