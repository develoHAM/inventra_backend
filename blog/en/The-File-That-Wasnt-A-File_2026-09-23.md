# The File That Wasn't a File

> I planned to "attach a file to an order." What I built was a spreadsheet round-trip, where the column order is the API.

*2026-09-23*

## Intro

[Inventra](https://github.com/develoHAM/inventra_backend) is a multi-tenant inventory SaaS built on **NestJS 11 + Prisma 7 + PostgreSQL**, modeled on the Korean concession-store world. In the [previous post](./Keys-That-Expire_2026-09-16.md) I added file uploads with private product images, brand logos and avatars, all served through MinIO and presigned URLs. The last item on that list read "**order file + audit file**," and I assumed it was more of the same.

It wasn't. When I asked what file types the order file should accept, the answer came back: *"an Excel or CSV with the exact structure of the order and order-details query."* So the job wasn't storing a document. It was **data interchange**: export an order or audit as a spreadsheet, and import one back. This post covers both halves.

## Architectural Decisions

### 1. Reframe: data interchange, not an attachment

**The goal:** make orders and audits "file-able" in a way users actually wanted.

**The options:**
- Store an uploaded sheet as an opaque attachment, using the `fileUrl` column and the same presign machinery as the images.
- Treat the sheet as **structured data**: generate it from the database on export, and parse it back into records on import.

**The choice:** structured data, in both directions.

**The reason:** a stored attachment is a dead end, because nobody can query it, validate it or turn it into stock movements. The user wanted a spreadsheet they could open, edit and upload back. That's a data format, not a blob.

**The result:** this feature doesn't touch `StorageService`, presigned URLs or `fileUrl` at all. It's a separate subsystem built around one shared column contract, and the whole direction came from one clarifying question.

### 2. Keep the rows flat and repeat the header on each one

**The goal:** one sheet layout that works as CSV *and* xlsx, and that import can read back reliably.

**The options:**

| Layout | Duplication | Works in CSV | Import complexity |
|---|---|---|---|
| **Flat:** one row per line item, order fields repeated on every row | yes | yes | trivial |
| **Two blocks:** order fields once at the top, then the items table | no | awkward | two parsers |
| **Two sheets** (Order + Items) | no | no (xlsx only) | two different contracts |

**The choice:** flat.

**The reason:** I asked whether we could get rid of the repeated order values, and it's a fair question. But a CSV is *by definition* one rectangular table, which is exactly what a joined `order ⋈ items ⋈ product` query returns. The repetition makes every row self-contained. Excel filters, pandas and SQL `COPY` all load it in one go, and it's the only layout that's identical in both formats.

**The result:** one column contract, shared by export, import, CSV and xlsx.

### 3. One workbook, two serializers: exceljs, with CSV as the default

**The goal:** produce both formats without writing two generators.

**The choice:** a shared `@Global() SpreadsheetService` on top of **exceljs**. I define the table once, then call whichever serializer is needed:

```ts
worksheet.columns = columns;   // [{ header, key }]
worksheet.addRows(rows);       // objects keyed by `key`
format === 'csv' ? await workbook.csv.writeBuffer()
                 : await workbook.xlsx.writeBuffer();
```

**The reason:** there's one definition and one dependency, and the output format is just the last call. CSV is the **default** (`?format=xlsx` opts in) because it opens everywhere.

**The result:** export is a `GET …/export?format=csv|xlsx`, and the controller streams the buffer back as a `StreamableFile`.

### 4. Headers are translated; keys are the contract

**The goal:** readable headers, in **English and Korean**.

**The key insight:** exceljs columns have two fields that do completely different jobs. `header` is the text written in row 1. `key` is how exceljs finds each cell's value in your row objects. So I split them apart:

```ts
{ key: 'productOrderQuantity', label: { en: 'Order Quantity', ko: '주문 수량' } }
// at export time: header = label[lang]; key never changes
```

**The trade-off:** once headers are translated, import *can't* match columns by header text, because `주문 수량` doesn't equal `productOrderQuantity`. So import reads columns **by position**, and it looks those positions up in the *same* column array that export uses.

**The result:** a Korean sheet and an English sheet import identically, and export and import can't drift apart because they share one definition of column order.

### 5. Import collects every error, and saves nothing unless all rows are valid

**The goal:** make uploading a 200-row spreadsheet something people don't dread.

**The options:** stop at the first bad row, or check every row and report all the problems at once.

**The choice:** check everything. Every row is validated (barcode is known, product is placed on this corner, quantity is a whole number above the minimum, no duplicate barcodes), and each failure becomes a `{ row, error }` using the **line number the user actually sees** in their spreadsheet:

```json
{ "message": "Import failed",
  "errors": [ { "row": 2, "error": "Quantity must be an integer ≥ 1" },
              { "row": 3, "error": "Unknown barcode \"ZZZ-999\"" } ] }
```

**The reason:** stopping at the first error means a user with five mistakes has to upload five times. With a full list, they fix everything in one pass. Barcodes are looked up in **two batched queries**, not one query per row.

**The result:** the whole upload succeeds or fails together, with an error report the user can act on.

### 6. Import reuses the existing write path

**The goal:** avoid writing a second, untested way to create an order.

**The choice:** import is only a *translator*. `buildOrderDtoFromFile` turns bytes into exactly the `CreateOrderDto` that `POST /orders` already accepts, and then calls the existing `create` / `update`.

**The result:** no write logic is duplicated: it's the same `$transaction`, the same placement check, the same compound-key handling. It also meant a rule came along for free. **Importing over an audit that has already been applied returns 409**, because the existing `update` method already refuses it.

## TIL (Today I Learned)

### How do `header` and `key` actually relate to the file?
`header` is the only one that **appears in the file**. It's row 1. `key` is never written anywhere. It's how exceljs finds `row[key]` to fill each cell. They were identical in my first draft, which hid the fact that they do separate jobs. As soon as I wanted readable (and translated) headers, pulling them apart was the whole design.

### What even is a `StreamableFile`?
A controller normally returns an object, and NestJS **JSON-encodes** it. A spreadsheet is raw bytes that the browser should *save*, not parse. `StreamableFile` is Nest's wrapper for that: return `new StreamableFile(buffer, { type, disposition })`, and Nest sets `Content-Type` plus `Content-Disposition: attachment; filename="…"` and pipes the bytes out. The alternative, injecting `@Res()` and writing to the response yourself, opts you out of Nest's response handling.

### How are we sure every row has the same title and date?
We weren't, and this was my catch. The first draft read the order's title, description and date from the first data row and **silently ignored** those cells on every other row. If someone typed a different title on row 5, it would just vanish. The fix follows the same "collect everything" rule: every later row's order fields must **match** the first row's, or that row gets an error. Since the flat layout repeats those fields, that repetition is now **checked** instead of assumed. Two different orders means two files.

### Does the order of controller methods matter?
Sometimes. NestJS on **Express** registers routes in the order they're declared, and Express uses the **first match**. It doesn't prefer a fixed path over a parameter. So if `@Post(':orderId')` came before `@Post('import')`, a request to `/orders/import` would bind `orderId = "import"`. In my controller there's no `POST /orders/:orderId` (updates use `PATCH`), so there was no clash. The habit is still worth keeping: **declare fixed routes before parameter routes** for the same method and path depth. (Fastify sorts this out automatically; Express doesn't.)

### How do audits tell apart available, reserved and sample stock?
They don't, and that's deliberate. An audit line holds **one** counted number, and applying the audit runs an `ADJUSTMENT`, which is `{ kind: 'set', field: availableQuantity }`. An audit reconciles only the sellable stock on the shelf. The reserved, sample and damaged amounts change only through their own transaction types. So the export correctly shows one quantity per product.

### The error that wouldn't go away: exceljs and `Buffer`
`workbook.xlsx.load(buffer)` failed type-checking with *"`Buffer<ArrayBufferLike>` is not assignable to `Buffer`."* My first fix, `Buffer.from(buffer)`, flipped the error around without fixing it. The real cause is that **every Node `Buffer` is a `Uint8Array`**, but exceljs's older type definitions describe the parameter as something shaped like an `ArrayBuffer`. No kind of Node Buffer can ever satisfy that. It's a **mismatch between two libraries' type definitions, with no effect at runtime**: exceljs reads the Buffer fine. So a one-line cast at that call site, `buffer as unknown as ArrayBuffer`, is the honest fix. The lesson: when changing the value flips the error without resolving it, stop adjusting the value and look at whether the two types can ever be compatible.

## NestJS Concepts & Libraries

| Concept / Library | Why we used it |
|---|---|
| `exceljs` | One workbook definition that writes and reads both **CSV** and **xlsx** |
| `@Global()` `SpreadsheetService` | Shared by orders and audits without re-importing the module; knows nothing about languages |
| `StreamableFile` | Streams the generated file as a download, keeping us inside Nest's response handling |
| `@Query()` + `ExportQueryDto` (`@IsIn`) | Validates `?format=csv\|xlsx` and `?lang=en\|ko`, returning 400 otherwise |
| `FileInterceptor` + `ParseFilePipe` + `MaxFileSizeValidator` | Accepts the uploaded sheet and caps it at 10 MB |
| `@HttpCode(200)` | Update-import is a `POST` that updates, so it returns 200 instead of the default 201 |
| `BadRequestException({ message, errors })` | Passing an object makes *that object* the 400 response body, which carries the list of row errors |
| `Readable.from(buffer)` (`node:stream`) | exceljs's CSV reader takes a stream, not a buffer |
| Prisma `{ in: [...] }` batching | Resolves every barcode in two queries instead of one per row |

## Wrap-up

This slice finished the file track that started with MinIO. Inventra can now store private images **and** move orders and audits in and out as spreadsheets, in two formats and two languages, with imports that save all rows or none. It ends at **210 unit tests and 86 e2e tests passing**.

The main lesson wasn't about exceljs. It was that the requirement changed shape the moment I asked one concrete question. "Order file" sounded like a storage feature, and it turned out to be a data format. From there, the design followed from one idea: **decide the column order once, and let everything else read from it.**

**Next:** nothing is forced. The domain is complete, and what's left comes from real need: the Prisma 8 migration once a stable client and adapter ship, and caching or monitoring only once I've measured a reason for them.
