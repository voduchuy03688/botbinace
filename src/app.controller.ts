import { Controller, Get, Query } from '@nestjs/common';
import { AppService } from './app.service.js';
import { ScannerService } from './scanner/scanner.service.js';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly scannerService: ScannerService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('trigger-report')
  async triggerReport(@Query('tf') tf?: string) {
    const hours = tf ? parseInt(tf, 10) : 4;
    return this.scannerService.triggerManualReport(hours);
  }
}
