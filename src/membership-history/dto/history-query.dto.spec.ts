// @Type reads decorator metadata; Nest loads this in the app, a bare spec must.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { HistoryQueryDto } from './history-query.dto';

/** What the global ValidationPipe does: turn the query text into the DTO, then check it. */
async function parse(query: Record<string, unknown>) {
  const dto = plainToInstance(HistoryQueryDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto: dto, failedFields: errors.map((error) => error.property) };
}

describe('HistoryQueryDto', () => {
  const ENTRY_ID = '0b9a1f3e-5c2d-4e8f-9a7b-1c2d3e4f5a6b';

  it('accepts no parameters at all: the first page, default size', async () => {
    const { failedFields } = await parse({});

    expect(failedFields).toEqual([]);
  });

  it('turns the text "20" from the URL into the number 20', async () => {
    const { dto, failedFields } = await parse({ limit: '20' });

    expect(failedFields).toEqual([]);
    expect(dto.limit).toBe(20);
  });

  it.each(['1', '100'])('accepts limit %s', async (limit) => {
    const { failedFields } = await parse({ limit: limit });

    expect(failedFields).toEqual([]);
  });

  it.each(['0', '101', '-5', '1.5', 'ten'])(
    'rejects limit %s',
    async (limit) => {
      const { failedFields } = await parse({ limit: limit });

      expect(failedFields).toEqual(['limit']);
    },
  );

  it('accepts a cursor that is an entry id', async () => {
    const { dto, failedFields } = await parse({ cursor: ENTRY_ID });

    expect(failedFields).toEqual([]);
    expect(dto.cursor).toBe(ENTRY_ID);
  });

  it('rejects a cursor that is not an entry id', async () => {
    const { failedFields } = await parse({ cursor: 'page-2' });

    expect(failedFields).toEqual(['cursor']);
  });

  it('rejects an unknown parameter', async () => {
    const { failedFields } = await parse({ page: '2' });

    expect(failedFields).toEqual(['page']);
  });
});
