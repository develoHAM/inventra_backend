# Order & Audit Spreadsheet Import/Export (Design)

> The "order/audit file" work turned out **not** to be a stored attachment (like the product/brand/avatar image slices) but a **data interchange** feature: export an order/audit + its line items as a spreadsheet, and later import one back. It does **not** use `StorageService`, presigned URLs, or the `fileUrl` column.

**Date:** 2026-09-16
**Split:** **Slice 3a — export** (this spec's build target) → **Slice 3b — import** (next; consumes 3a's column contract).

---

## Goal

Let a user download an order (or audit) with its line items as a **CSV** (default) or **Excel `.xlsx`** file, in a fixed column layout — and, in 3b, upload a file in that same layout to create the order/audit + items.

## Why this shape

The user's mental model is "the order + order-details query as a spreadsheet." A joined `order ⋈ order_items ⋈ product` result is a **flat, denormalized table**: one row per line item, with the order-header fields repeated on each row. That flat table is also the *only* layout that is byte-identical between CSV and XLSX, which keeps the future import parser format-agnostic.

## Format

- **CSV is the default** (`?format=csv` or omitted) — best spreadsheet-tool compatibility.
- **`?format=xlsx`** opts into Excel.
- Any other `format` value → **400**.
- Both are produced from a single **`exceljs`** workbook: `workbook.csv.writeBuffer()` and `workbook.xlsx.writeBuffer()`. One dependency, one table definition, two outputs.

## Column contract (the canonical layout — shared by CSV + XLSX, consumed by import 3b)

**Order export** — one row per order item:

| Column | Source |
|---|---|
| `orderId` | `order.id` |
| `title` | `order.title` |
| `description` | `order.description` |
| `orderDate` | `order.orderDate` (ISO 8601) |
| `userName` | `order.createdByUser.name` |
| `createdAt` | `order.createdAt` (ISO 8601) |
| `companyStoreName` | `order.companyStore.name` |
| `productBarcode` | `item.companyStoreProduct.product.barcode` |
| `productName` | `item.companyStoreProduct.product.name` |
| `productOrderQuantity` | `item.productOrderQuantity` |

**Audit export** — direct analog, one row per audit item:

| Column | Source |
|---|---|
| `auditId` | `audit.id` |
| `title` | `audit.title` |
| `description` | `audit.description` |
| `auditedDate` | `audit.auditedDate` (ISO 8601) |
| `userName` | `audit.createdByUser.name` |
| `createdAt` | `audit.createdAt` (ISO 8601) |
| `appliedAt` | `audit.appliedAt` (ISO 8601; empty cell if not yet applied) |
| `companyStoreName` | `audit.companyStore.name` |
| `productBarcode` | `item.companyStoreProduct.product.barcode` |
| `productName` | `item.companyStoreProduct.product.name` |
| `productQuantity` | `item.productQuantity` |

Notes:
- **`productBarcode` is the line-item business key** (globally unique per `Product`). Import (3b) resolves each row's barcode → product → the placement on that corner (`CompanyStoreProduct` unique on `[productId, companyStoreId]`). The internal placement id is intentionally *not* in the sheet.
- **Read-only context columns** (`orderId`/`auditId`, `userName`, `createdAt`, `companyStoreName`, `productName`) are informational on export; import ignores them for writes (it keys on barcode + quantity + the editable header fields).
- **No items** → header row only (zero data rows). Orders/audits are normally created with items, so this is an edge case.

## Architecture (Slice 3a — export)

### `SpreadsheetService` (new, shared) — `src/spreadsheet/`
A `@Global() SpreadsheetModule` exposing a generic, injectable `SpreadsheetService`:
- `toBuffer(format: 'csv' | 'xlsx', columns: { header: string; key: string }[], rows: Record<string, unknown>[]): Promise<Buffer>` — builds a one-sheet `exceljs` workbook (`worksheet.columns = columns`, `addRows(rows)`) and returns the CSV or XLSX buffer.

Keeping generation generic + injectable means Orders and Audits share it and it mocks cleanly in service unit tests.

### `OrdersService` / `AuditsService`
- Add `exportOrder(caller, cornerId, orderId, format)` / `exportAudit(caller, cornerId, auditId, format)`:
  1. `corners.findOne(caller, cornerId)` (scoped 404) — read scope, same as `findOne`.
  2. Fetch the order/audit with nested includes: `createdByUser { name }`, `companyStore { name }`, `orderItems`/`inventoryAuditItems → companyStoreProduct → product { barcode, name }`. 404 if absent.
  3. Map to the column rows above.
  4. `spreadsheet.toBuffer(format, COLUMNS, rows)`.
  5. Return `{ buffer, filename, contentType }` — `filename` = `order-<id>.<ext>` / `audit-<id>.<ext>`; `contentType` = `text/csv` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

### `OrdersController` / `AuditsController`
- `GET /corners/:cornerId/orders/:orderId/export` and `.../audits/:auditId/export`.
- Gated `orders.read` / `audits.read` (export is a read).
- `@Query()` → `ExportQueryDto { format?: 'csv' | 'xlsx' }` (`@IsOptional() @IsIn(['csv','xlsx'])`); service defaults `undefined → 'csv'`.
- Return `new StreamableFile(buffer, { type: contentType, disposition: \`attachment; filename="${filename}"\` })`.

## Error model
- **400** — `format` present but not `csv`/`xlsx` (ValidationPipe on `@IsIn`).
- **403** — caller lacks `orders.read` / `audits.read` (guard).
- **404** — absent/other-tenant corner (`corners.findOne`) or absent order/audit (scoped lookup).

## Testing (Claude owns)
- **Unit — `SpreadsheetService`:** `toBuffer('csv', …)` returns a CSV whose first line is the header and whose Nth line matches a row; `toBuffer('xlsx', …)` returns a non-empty buffer starting with the ZIP magic bytes (`PK`). 
- **Unit — `OrdersService.exportOrder` / `AuditsService.exportAudit`:** with a mocked prisma record + mocked `SpreadsheetService`, assert the `columns`/`rows` passed to `toBuffer` (right headers, one row per item, header fields repeated, barcode/name/quantity mapped), and the returned `filename`/`contentType`; default format is `csv`.
- **e2e:** `GET …/export` (default) returns `200` with `Content-Type: text/csv` and a body whose header line is the contract and that contains a seeded product's barcode; `?format=xlsx` returns the xlsx content-type; `?format=bogus` → 400.

## Non-goals (3a)
- Import (that's 3b — parse a file in this layout, resolve barcodes → placements on the corner, create/replace the order/audit + items, with per-row validation + error reporting).
- Corner-wide export (one order/audit per call).
- Styling/formatting of the spreadsheet (plain columns).

## Definition of done (3a)
`exceljs` added; `SpreadsheetService` + export methods + routes implemented; unit suite green (adds ~6–8 tests); e2e green (order + audit export, csv default + xlsx + bad-format 400); committed + pushed; STATUS updated (relabel the "order/audit file" line to "order/audit import/export", 3a done, 3b next).
