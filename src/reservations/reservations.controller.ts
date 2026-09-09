import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { CancelReservationDto } from './dto/cancel-reservation.dto';
import { ListReservationsQueryDto } from './dto/list-reservations.query.dto';

@Controller('corners/:cornerId/reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @RequirePermissions('reservations.read')
  @Get()
  findAll(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Query() query: ListReservationsQueryDto,
  ) {
    return this.reservations.findAll(caller, cornerId, query);
  }

  @RequirePermissions('reservations.read')
  @Get(':reservationId')
  findOne(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.findOne(caller, cornerId, reservationId);
  }

  @RequirePermissions('reservations.create')
  @Post()
  create(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Body() dto: CreateReservationDto,
  ) {
    return this.reservations.create(caller, cornerId, dto);
  }

  @RequirePermissions('reservations.fulfill')
  @Post(':reservationId/fulfill')
  fulfill(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.fulfill(caller, cornerId, reservationId);
  }

  @RequirePermissions('reservations.cancel')
  @Post(':reservationId/cancel')
  cancel(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: CancelReservationDto,
  ) {
    return this.reservations.cancel(caller, cornerId, reservationId, dto);
  }
}
