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
