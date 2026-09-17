import { Global, Module } from '@nestjs/common';
import { SpreadsheetService } from './spreadsheet.service';

@Global()
@Module({
  providers: [SpreadsheetService],
  exports: [SpreadsheetService],
})
export class SpreadsheetModule {}
