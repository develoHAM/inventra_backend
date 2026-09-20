import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

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

  async parse(format: SpreadsheetFormat, buffer: Buffer): Promise<string[][]> {
    const workbook = new ExcelJS.Workbook();
    let worksheet: ExcelJS.Worksheet | undefined;
    if (format === 'csv') {
      worksheet = await workbook.csv.read(Readable.from(buffer));
    } else {
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
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
}
