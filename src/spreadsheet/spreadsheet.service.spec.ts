import { SpreadsheetService } from './spreadsheet.service';

describe('SpreadsheetService', () => {
  let service: SpreadsheetService;

  const columns = [
    { header: 'name', key: 'name' },
    { header: 'qty', key: 'qty' },
  ];
  const rows = [
    { name: 'Widget', qty: 10 },
    { name: 'Gadget', qty: 5 },
  ];

  beforeEach(() => {
    service = new SpreadsheetService();
  });

  it('emits CSV with a header row followed by one row per record', async () => {
    const buffer = await service.toBuffer('csv', columns, rows);

    const lines = buffer
      .toString('utf8')
      .replace(/^﻿/, '') // tolerate a leading BOM if exceljs adds one
      .split(/\r?\n/)
      .filter((line) => line.length > 0);

    expect(lines[0]).toBe('name,qty');
    expect(lines[1]).toBe('Widget,10');
    expect(lines[2]).toBe('Gadget,5');
    expect(lines).toHaveLength(3);
  });

  it('emits an XLSX buffer (a ZIP container, so it starts with the PK magic bytes)', async () => {
    const buffer = await service.toBuffer('xlsx', columns, rows);

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 2).toString('utf8')).toBe('PK');
  });
});
