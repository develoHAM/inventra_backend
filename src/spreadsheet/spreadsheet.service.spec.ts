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

  describe('parse', () => {
    it('parses a CSV buffer into a grid of string rows (header + data)', async () => {
      const grid = await service.parse(
        'csv',
        Buffer.from('name,qty\nWidget,10\nGadget,5\n'),
      );

      expect(grid).toEqual([
        ['name', 'qty'],
        ['Widget', '10'],
        ['Gadget', '5'],
      ]);
    });

    it('round-trips xlsx: toBuffer then parse yields the same header + rows (cells as strings)', async () => {
      const buffer = await service.toBuffer('xlsx', columns, rows);

      const grid = await service.parse('xlsx', buffer);

      expect(grid[0]).toEqual(['name', 'qty']);
      expect(grid[1]).toEqual(['Widget', '10']);
      expect(grid[2]).toEqual(['Gadget', '5']);
    });
  });
});
