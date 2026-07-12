import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { Env } from './config/env.schema';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Env, true>);

  const port = config.get('PORT', { infer: true });

  await app.listen(port);
  console.log(`🚀 Inventra API running on http://localhost:${port}`);
}
bootstrap();
