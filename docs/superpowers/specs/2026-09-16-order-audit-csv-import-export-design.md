# Order & Audit Spreadsheet Import/Export (Design)

> The "order/audit file" work turned out **not** to be a stored attachment (like the product/brand/avatar image slices) but a **data interchange** feature: export an order/audit + its line items as a spreadsheet, and later import one back. It does **not** use `StorageService`, presigned URLs, or the `fileUrl` column.

**Date:** 2026-09-16 (rev. 2026-09-18 — localized headers)
**Split:** **Slice 3a — export** (this spec's build target) → **Slice 3b — import** (next; consumes 3a's column contract).

---

## Goal

Let a user download an order (or audit) with its line items as a **CSV** (default) or **Excel `.xlsx`** file, with **human-readable, localized headers** (English + Korean) — and, in 3b, upload a file in the same layout to create the order/audit + items.

## Why this shape

The user's mental model is "the order + order-details query as a spreadsheet." A joined `order ⋈ order_items ⋈ product` result is a **flat, denormalized table**: one row per line item, with the order-header fields repeated on each row. That flat table is also the *only* layout that is byte-identical between CSV and XLSX, which keeps the future import parser format-agnostic.

## Format

- **CSV is the default** (`?format=csv` or omitted) — best spreadsheet-tool compatibility.
- **`?format=xlsx`** opts into Excel.
- Any other `format` value → **400**.
- Both are produced from a single **`exceljs`** workbook: `workbook.csv.writeBuffer()` and `workbook.xlsx.writeBuffer()`. One dependency, one table definition, two outputs.

## Localization

- Column **headers are localized**; the **`key` (internal field name) stays stable** and language-independent.
- Language via **`?lang=en|ko`**; **default `en`**; any other value → **400**.
- Each column is defined as `{ key, label: { en, ko } }`; at export time the service resolves `label[lang]` into the exceljs `header`. `SpreadsheetService` stays language-agnostic — it only ever receives resolved `{ header, key }` columns.
- Adding a language later = add a key to each `label` object (+ widen the `lang` allow-list).

## Column contract (flat layout — shared by CSV + XLSX, in this order; consumed by import 3b)

**Order export** — one row per order item:

| `key` (stable) | EN header | KO header | Source |
|---|---|---|---|
| `orderId` | Order ID | 주문 ID | `order.id` |
| `title` | Title | 제목 | `order.title` |
| `description` | Description | 설명 | `order.description` (null → `''`) |
| `orderDate` | Order Date | 주문일자 | `order.orderDate` (ISO 8601) |
| `userName` | Created By | 작성자 | `order.createdByUser.name` |
| `createdAt` | Created At | 생성일시 | `order.createdAt` (ISO 8601) |
| `companyStoreName` | Corner | 코너 | `order.companyStore.name` |
| `productBarcode` | Barcode | 바코드 | `item.companyStoreProduct.product.barcode` |
| `productName` | Product | 상품명 | `item.companyStoreProduct.product.name` |
| `productOrderQuantity` | Order Quantity | 주문 수량 | `item.productOrderQuantity` |

**Audit export** — one row per audit item:

| `key` (stable) | EN header | KO header | Source |
|---|---|---|---|
| `auditId` | Audit ID | 실사 ID | `audit.id` |
| `title` | Title | 제목 | `audit.title` |
| `description` | Description | 설명 | `audit.description` (null → `''`) |
| `auditedDate` | Audit Date | 실사일자 | `audit.auditedDate` (ISO 8601) |
| `userName` | Created By | 작성자 | `audit.createdByUser.name` |
| `createdAt` | Created At | 생성일시 | `audit.createdAt` (ISO 8601) |
| `appliedAt` | Applied At | 적용일시 | `audit.appliedAt` (ISO 8601; `''` if not yet applied) |
| `companyStoreName` | Corner | 코너 | `audit.companyStore.name` |
| `productBarcode` | Barcode | 바코드 | `item.companyStoreProduct.product.barcode` |
| `productName` | Product | 상품명 | `item.companyStoreProduct.product.name` |
| `productQuantity` | Counted Quantity | 실사 수량 | `item.productQuantity` (the counted total → `availableQuantity` on apply; audits are single-bucket) |

Notes:
- **`productBarcode` is the line-item business key.** Import (3b) resolves each row's barcode → product → the placement on that corner. The internal placement id is intentionally *not* in the sheet.
- **Headers are decorative/localized, so import keys by column ORDER**, not by header text (a KO sheet and an EN sheet have the same column order). Read-only context columns (`orderId`/`auditId`, `userName`, `createdAt`, `companyStoreName`, `productName`) are informational; import uses barcode + quantity + the editable header fields.
- **No items** → header row only (zero data rows).

## Architecture (Slice 3a — export)

### `SpreadsheetService` (shipped in cycle 1) — `src/spreadsheet/`
`@Global() SpreadsheetModule` exposing `toBuffer(format: 'csv'|'xlsx', columns: { header, key }[], rows): Promise<Buffer>`. Language-agnostic.

### `ExportQueryDto` — `src/spreadsheet/dto/export-query.dto.ts`
`{ format?: 'csv' | 'xlsx'; lang?: 'en' | 'ko' }` — both `@IsOptional() @IsIn([...])`. Exports an `ExportLanguage = 'en' | 'ko'` type.

### `OrdersService` / `AuditsService`
- A `LocalizedColumn[]` constant (`{ key, label: { en, ko } }`) per entity, in the contract order.
- `exportOrder(caller, cornerId, orderId, format = 'csv', lang = 'en')` / `exportAudit(caller, cornerId, auditId, format = 'csv', lang = 'en')`:
  1. `corners.findOne(caller, cornerId)` (scoped 404).
  2. Fetch record with nested includes (`createdByUser { name }`, `companyStore { name }`, items → `companyStoreProduct → product { barcode, name }`); 404 if absent.
  3. Resolve columns: `COLUMNS.map((c) => ({ header: c.label[lang], key: c.key }))`.
  4. Map items → row objects (keyed by `key`).
  5. `spreadsheet.toBuffer(format, columns, rows)`.
  6. Return `{ buffer, filename, contentType }` — `filename` = `order-<id>.<ext>` / `audit-<id>.<ext>`; `contentType` = `text/csv` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

### `OrdersController` / `AuditsController`
- `GET /corners/:cornerId/orders/:orderId/export` and `.../audits/:auditId/export`.
- Gated `orders.read` / `audits.read`.
- `@Query() ExportQueryDto`; service defaults `format→'csv'`, `lang→'en'`.
- Return `new StreamableFile(buffer, { type: contentType, disposition: \`attachment; filename="${filename}"\` })`.

## Error model
- **400** — `format` not `csv`/`xlsx`, or `lang` not `en`/`ko` (ValidationPipe on `@IsIn`).
- **403** — caller lacks `orders.read` / `audits.read`.
- **404** — absent/other-tenant corner or absent order/audit.

## Testing (Claude owns)
- **Unit — `SpreadsheetService`:** (done) CSV header+rows; xlsx `PK` magic.
- **Unit — `exportOrder` / `exportAudit`:** with mocked prisma record + mocked `SpreadsheetService`, assert the resolved `columns` (EN by default; KO when `lang='ko'`) + `rows` (one per item, header fields repeated, barcode/name/qty mapped, ISO timestamps, nulls → `''`, audit `appliedAt` applied vs `''`), and the returned `filename`/`contentType`; 404 when absent.
- **e2e:** `GET …/export` (default) → 200, `Content-Type: text/csv`, first line = the EN header row, body contains a seeded barcode; `?lang=ko` → first line is the KO header row; `?format=xlsx` → xlsx content-type + `PK`; `?format=bogus` / `?lang=bogus` → 400. Order + audit.

## Non-goals (3a)
- Import (3b — parse a file in this layout, key rows by column order, resolve barcodes → placements, create/replace the order/audit + items, per-row validation + error reporting).
- Corner-wide export (one order/audit per call).
- Spreadsheet styling.

## Definition of done (3a)
`SpreadsheetService` (done); `ExportQueryDto` with `lang`; localized export methods + routes; unit green; e2e green (order + audit, csv default + xlsx + `lang=ko` + bad-format/lang 400); committed + pushed; STATUS updated (relabel "order/audit file" → "order/audit import/export", 3a done, 3b next).
