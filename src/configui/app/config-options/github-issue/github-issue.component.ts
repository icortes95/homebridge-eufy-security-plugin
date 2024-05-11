/* eslint-disable @typescript-eslint/no-explicit-any */
import { Component, NgZone, OnInit } from '@angular/core';
import { Router, NavigationStart } from '@angular/router';

import { Buffer } from 'buffer';
import { NgIf } from '@angular/common';
import { NgbProgressbar } from '@ng-bootstrap/ng-bootstrap';

@Component({
  selector: 'app-github-issue',
  templateUrl: './github-issue.component.html',
  styles: [],
  standalone: true,
  imports: [NgIf, NgbProgressbar],
})
export class GithubIssueComponent implements OnInit {

  progress: number = 0;
  status: string = '';
  wait_timer: number = 200;

  constructor(
    private router: Router,
    private zone: NgZone,
  ) { }

  ngOnInit(): void {

    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        if (this.logFileLocation !== '') {
          // eslint-disable-next-line no-console
          console.log('revoke log zip file blob location url.');
          window.URL.revokeObjectURL(this.logFileLocation);
          this.logFileLocation = '';
        }
      }
    });

    window.homebridge.addEventListener('downloadLogsProgress', (event: any) => {
      const data = event['data'] as any;
      console.log('downloadLogsProgress', data);
      this.zone.run(() => {
        this.progress = data['progress'] as number;
        this.status = data['status'] as string;
      });
    });
  }

  failed = false;
  isDownloading = false;
  hasDownloaded = false;
  downloadMessage?: string;
  failureMessage = '';
  logFileLocation = '';

  async downloadLogs() {
    try {
      this.isDownloading = true;

      const bufferData = await window.homebridge.request('/downloadLogs') as { type: string; data: number[] };
      const buffer = Buffer.from(bufferData.data);

      const file = new File([buffer], 'logs.zip', { type: 'application/zip' });
      const url = window.URL.createObjectURL(file);

      this.logFileLocation = url;
      // window.open(this.logFileLocation);

      this.hasDownloaded = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(err);

      const error = err as { message: string };
      this.failed = true;
      this.failureMessage = `Generating of compressed logs.zip file did not complete: ${error.message}`;
    } finally {
      this.isDownloading = false;
    }
  }

  openLink() {
    window.open(this.logFileLocation);
  }

}
