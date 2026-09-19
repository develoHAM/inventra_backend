# Order & Audit Spreadsheet Import (Design)

> Slice 3b — the mirror of 3a export. Upload a CSV/xlsx in the 3a column layout to **create** or **replace** an order/audit + its line items. Consumes 3a's column contract; does not touch `StorageService`/`fileUrl`.

**Date:** 2026-09-19
**Depends on:** Slice 3a export (`docs/superpowers/specs/2026-09-16-order-audit-csv-import-export-design.md`) — the `*_EXPORT_COLUMNS` order is the shared contract.

---

## Goal

`POST` a CSV or xlsx file (in the exported flat layout) to either **create a new** order/audit or **replace an existing** one's header + items, resolving each row's `productBarcode` to a placement on the corner. Row-level problems are reported **all at once** (400 with a list); nothing is written unless every row is valid.

## Endpoints (multipart `file` field)

| Route | Mode | Gate | Success |
|---|---|---|---|
| `POST /corners/:cornerId/orders/import` | create | `orders.create` | 201, the new order |
| `POST /corners/:cornerId/orders/:orderId/import` | update | `orders.update` | 200, the replaced order |
| `POST /corners/:cornerId/audits/import` | create | `audits.create` | 201, the new audit |
| `POST /corners/:cornerId/audits/:auditId/import` | update | `audits.update` | 200; **409 if the audit is already applied** |

`ParseFilePipe` requires the file, max **10 MB**. No `FileTypeValidator` (CSV MIME types are unreliable across clients) — **format is detected from the filename extension** (`.csv` / `.xlsx`); any other extension → 400.

## Parsing

`SpreadsheetService.parse(format, buffer): Promise<string[][]>` — exceljs reads both (`csv.read(Readable.from(buffer))` / `xlsx.load(buffer)`), returning each row as a `string[]` of cell text (null/blank → `''`). Pure; no languages, no DB.

- **Row 1 = header, skipped.** Its column count must equal the entity's `*_EXPORT_COLUMNS.length`, else 400 "unexpected column layout".
- **Column positions are looked up by `key` in the same `*_EXPORT_COLUMNS`** used by export — one column-order source for both directions. Header *text* is ignored, so a KO or EN sheet (or any localized header) imports identically.
- Empty file / no data rows → 400.

## Row validation (collect ALL errors)

Header fields are read from the **first data row**: `title` (required, ≤255), `description` (optional; blank → omitted), and the date (`orderDate`/`auditedDate`, must parse as a valid date). Because the flat layout repeats those on every row, **each later row's header cells must match the first row's** (one file = one order/audit) — a mismatch on any row is a `{ row, error }`, not silently ignored. Item fields per row: `productBarcode` + quantity (`productOrderQuantity` ≥ 1 for orders / `productQuantity` ≥ 0 for audits, integer).

Resolution is **batched** (not per-row queries): collect all barcodes → `product.findMany({ where: { barcode: { in }, deletedAt: null } })` → `companyStoreProduct.findMany({ where: { companyStoreId: cornerId, productId: { in }, deletedAt: null } })`. Then per row:
- blank/unknown barcode → error;
- barcode's product not placed on this corner → error;
- quantity not an integer / below the min → error;
- barcode duplicated across rows → error.

Each failure is `{ row, error }` where **`row` is the spreadsheet line number** the user sees (header = line 1, first data row = line 2). If any errors: **`throw new BadRequestException({ message: 'Import failed', errors })`** — nothing written.

## On success — reuse the existing write path

Build a `Create…Dto` (create) or `Update…Dto` (update) from the resolved header + `items: [{ companyStoreProductId, <quantity> }]` and call the existing `OrdersService.create/update` (or Audits). Same `$transaction`, same `validateItems` final guard, same soft-delete/compound-PK handling. For update, the existing `if (audit.appliedAt) → 409` guard applies (the file is parsed before that fires — acceptable).

Authz: the import methods call `corners.assertWorksCorner(caller, cornerId)` up front (before any DB reads), matching create/update.

## Error model
- **400** — bad extension; unexpected column layout; empty/no-data file; any row/header validation errors (with the `errors` list).
- **403** — caller lacks the route permission, or `assertWorksCorner` fails (foreign manager).
- **404** — absent/other-tenant corner or (update) absent order/audit.
- **409** — update-import onto an already-applied audit.

## Non-goals
- Matching/updating by the sheet's `orderId`/`auditId` column (update targets come from the URL; the id column is ignored).
- Per-row *partial* success (it's all-or-nothing).
- Lenient date parsing / Excel locale-date recovery. **Known limitation:** if Excel reformats the exported ISO date cell into a locale format, re-import may 400 on the date — the contract is ISO dates. Revisit if it bites.

## Architecture
- `SpreadsheetService.parse(...)` (new, shared, pure) — cycle 1.
- `OrdersService`: `importCreate(caller, cornerId, file)`, `importUpdate(caller, cornerId, orderId, file)`, private `buildOrderDtoFromFile(cornerId, file)` (parse → validate → dto | throw 400). Reuses `create`/`update`. Controller routes with `FileInterceptor` + `ParseFilePipe`.
- `AuditsService`: mirror (`audits.create`/`audits.update`, `productQuantity` ≥ 0, `auditedDate`, applied-guard via `update`). — cycle 2.
- Per-service implementation (consistent with the existing per-service `validateItems`/`getOrder`/`getAudit`), sharing only the pure `parse`.

## Testing (Claude owns)
- **Unit — `SpreadsheetService.parse`:** a CSV buffer → `string[][]` (header + data rows, right cell values); an xlsx buffer round-trips (build via `toBuffer`, parse back).
- **Unit — orders import:** valid file → `create`/`update` called with the resolved dto (barcodes → companyStoreProductIds, header from row 1, items mapped); collect-all: a file with an unknown barcode + a bad quantity + a duplicate → `BadRequestException` whose `errors` names each offending line, and `create` NOT called; bad extension / wrong column count / empty → 400.
- **Unit — audits import:** mirror + `productQuantity` ≥ 0 (0 allowed); update onto applied audit → 409 (via `update`).
- **e2e:** round-trip — export an order to CSV, re-import (create) → new order with the same items; import with a bogus-barcode row → 400 with an `errors` entry; xlsx create; audit create + update; update-import onto an applied audit → 409.

## Definition of done
`SpreadsheetService.parse`; orders + audits import (create + update) with collect-all validation; unit green; e2e green (round-trip create, error list, xlsx, audit applied-guard); committed + pushed; STATUS updated (Slice 3b done → order/audit import/export feature complete → offer the export/import `/phase-blog`).
