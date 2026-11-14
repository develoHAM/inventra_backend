import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentAccount } from '../auth/decorators/current-account.decorator';
import { AccountRoute } from '../auth/decorators/account-route.decorator';
import type { AuthAccount } from '../auth/types/auth-account';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

// Self-service: logged in, no permission needed — pending users too, so
// the "you've been approved" push can reach them. A device belongs to the
// sign-in (it shows every company's pushes), so no company needs to be open.
@AccountRoute()
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  register(
    @CurrentAccount() caller: AuthAccount,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.devices.register(caller.accountId, {
      token: dto.token,
      platform: dto.platform,
    });
  }

  @Delete(':token')
  @HttpCode(HttpStatus.NO_CONTENT)
  unregister(
    @CurrentAccount() caller: AuthAccount,
    @Param('token') token: string,
  ) {
    return this.devices.unregister(caller.accountId, token);
  }
}
