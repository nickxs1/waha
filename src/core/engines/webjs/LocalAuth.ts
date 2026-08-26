import * as fs from 'fs';
import * as path from 'path';
import pino, { Logger } from 'pino';
import { AuthStrategy, Client } from 'whatsapp-web.js';

async function isValidPath(path: string) {
  try {
    await fs.promises.access(path);
    return true;
  } catch {
    return false;
  }
}

export class LocalAuth implements AuthStrategy {
  private readonly logger: Logger;

  private client: Client;
  private readonly clientId: string;
  private readonly dataPath: string;
  private readonly rmMaxRetries: number;

  private userDataDir: string;

  setup(client: Client) {
    this.client = client;
  }

  constructor({ clientId, dataPath, rmMaxRetries, logger }) {
    const idRegex = /^[-_\w]+$/i;
    if (clientId && !idRegex.test(clientId)) {
      throw new Error(
        'Invalid clientId. Only alphanumeric characters, underscores and hyphens are allowed.',
      );
    }

    this.dataPath = path.resolve(dataPath || './.wwebjs_auth/');
    this.clientId = clientId;
    this.rmMaxRetries = rmMaxRetries ?? 4;
    this.logger = logger || pino({ name: LocalAuth.name });
  }

  async beforeBrowserInitialized() {
    // @ts-ignore
    const puppeteerOpts = this.client.options.puppeteer;
    const sessionDirName = this.clientId
      ? `session-${this.clientId}`
      : 'session';
    const dirPath = path.join(this.dataPath, sessionDirName);

    if (puppeteerOpts.userDataDir && puppeteerOpts.userDataDir !== dirPath) {
      throw new Error(
        'LocalAuth is not compatible with a user-supplied userDataDir.',
      );
    }

    fs.mkdirSync(dirPath, { recursive: true });

    // @ts-ignore
    this.client.options.puppeteer = {
      ...puppeteerOpts,
      userDataDir: dirPath,
    };

    this.userDataDir = dirPath;
    this.killOrphanedChrome(dirPath);
    await this.removeSingletonFiles(dirPath);
  }

  /**
   * Kill the Chrome/Chromium process still holding this userDataDir.
   * Chrome writes a SingletonLock symlink containing "hostname-PID".
   * We read it, extract the PID, and kill only that process.
   */
  private killOrphanedChrome(userDataDir: string) {
    const lockFile = path.join(userDataDir, 'SingletonLock');
    try {
      const target = fs.readlinkSync(lockFile);
      const parts = target.split('-');
      const pid = parseInt(parts[parts.length - 1], 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        return;
      }
      try {
        process.kill(pid, 'SIGKILL');
        this.logger.info(`Killed orphaned Chrome process PID ${pid}`);
      } catch (killErr: any) {
        if (killErr.code !== 'ESRCH') {
          this.logger.warn(killErr, `Failed to kill Chrome PID ${pid}`);
        }
      }
    } catch {
      // No SingletonLock → no orphaned Chrome, nothing to do
    }
  }

  /**
   * Find in direction Singleton* files and try to remove it
   * Fix for SingletonLock and other files
   */
  private async removeSingletonFiles(dir: string) {
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      if (file.startsWith('Singleton')) {
        const filePath = path.join(dir, file);
        try {
          await fs.promises.rm(filePath, {
            maxRetries: this.rmMaxRetries,
            recursive: true,
            force: true,
          });
        } catch (err) {
          this.logger.error(err, `Error deleting: ${filePath}`);
        }
      }
    }
  }

  async logout() {
    if (this.userDataDir) {
      await this.removePathSilently(this.userDataDir);
    }
  }

  private async removePathSilently(path: string) {
    const exists = await isValidPath(path);
    if (!exists) {
      return;
    }

    try {
      await fs.promises.rm(path, {
        maxRetries: this.rmMaxRetries,
        recursive: true,
        force: true,
      });
    } catch (err) {
      this.logger.error(err, `Error deleting: ${path}`);
    }
  }

  async afterBrowserInitialized() {
    return;
  }

  async onAuthenticationNeeded() {
    return {
      failed: false,
      restart: false,
      failureEventPayload: undefined,
    };
  }

  async getAuthEventPayload() {
    return;
  }

  async afterAuthReady() {
    return;
  }

  async disconnect() {
    return;
  }

  async destroy() {
    return;
  }
}
