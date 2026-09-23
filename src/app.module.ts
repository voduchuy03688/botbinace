import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { TelegramService } from './telegram/telegram.service.js';
import { BinanceService } from './binance/binance.service.js';
import { ScannerService } from './scanner/scanner.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [AppService, TelegramService, BinanceService, ScannerService],
})
export class AppModule {}
