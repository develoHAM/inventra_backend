import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

// Self-service: logged in, no permission needed — pending users too, so
// the "you've been approved" push can reach them.
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  register(@CurrentUser() caller: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.devices.register(caller.id, {
      token: dto.token,
      platform: dto.platform,
    });
  }

  @Delete(':token')
  @HttpCode(HttpStatus.NO_CONTENT)
  unregister(@CurrentUser() caller: AuthUser, @Param('token') token: string) {
    return this.devices.unregister(caller.id, token);
  }
}
