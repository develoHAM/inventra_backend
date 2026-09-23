import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { AuditsService } from './audits.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateAuditDto } from './dto/create-audit.dto';
import { UpdateAuditDto } from './dto/update-audit.dto';
import { ExportQueryDto } from '../spreadsheet/dto/export-query.dto';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('corners/:cornerId/audits')
export class AuditsController {
  constructor(private readonly audits: AuditsService) {}

  @RequirePermissions('audits.read')
  @Get()
  findAll(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
  ) {
    return this.audits.findAll(caller, cornerId);
  }

  @RequirePermissions('audits.read')
  @Get(':auditId')
  findOne(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
  ) {
    return this.audits.findOne(caller, cornerId, auditId);
  }

  @RequirePermissions('audits.create')
  @Post()
  create(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Body() dto: CreateAuditDto,
  ) {
    return this.audits.create(caller, cornerId, dto);
  }

  @RequirePermissions('audits.update')
  @Patch(':auditId')
  update(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Body() dto: UpdateAuditDto,
  ) {
    return this.audits.update(caller, cornerId, auditId, dto);
  }

  @RequirePermissions('audits.delete')
  @Delete(':auditId')
  remove(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
  ) {
    return this.audits.remove(caller, cornerId, auditId);
  }

  @RequirePermissions('audits.apply')
  @Post(':auditId/apply')
  apply(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
  ) {
    return this.audits.apply(caller, cornerId, auditId);
  }

  @RequirePermissions('audits.read')
  @Get(':auditId/export')
  async export(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @Query() query: ExportQueryDto,
  ): Promise<StreamableFile> {
    const { buffer, filename, contentType } = await this.audits.exportAudit(
      caller,
      cornerId,
      auditId,
      query.format,
      query.lang,
    );
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @RequirePermissions('audits.create')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  importCreate(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.audits.importCreate(caller, cornerId, file);
  }

  @RequirePermissions('audits.update')
  @Post(':auditId/import')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  importUpdate(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('auditId', ParseUUIDPipe) auditId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.audits.importUpdate(caller, cornerId, auditId, file);
  }
}
