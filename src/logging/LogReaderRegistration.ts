/**
 * Handles registration with the ee-mcp log monitor service.
 * Creates a registration file that allows the log monitor to discover
 * and push this service's logs to Kafka.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { StructuredLogger } from './StructuredLogger.js';

export interface ServiceRegistration {
  service_id: string;
  service_name: string;
  hostname: string;
  pid: number;
  log_directory: string;
  log_pattern: string;
  started_at: string;
  version?: string;
  metadata?: Record<string, any>;
}

export class LogReaderRegistration {
  private logger: StructuredLogger;
  private registrationPath: string;
  private serviceName: string;
  private logDirectory: string;
  private version: string;

  constructor(
    logger: StructuredLogger,
    serviceName: string,
    logDirectory: string,
    version: string
  ) {
    this.logger = logger;
    this.serviceName = serviceName;
    this.logDirectory = logDirectory;
    this.version = version;

    const hostname = os.hostname();
    const pid = process.pid;
    const registrationFilename = `${hostname}-${serviceName}-${pid}.json`;

    // Registration goes in ~/.ee-mcp/services/
    const homeDir = os.homedir();
    this.registrationPath = path.join(homeDir, '.ee-mcp', 'services', registrationFilename);
  }

  /**
   * Register this service with the log monitor
   */
  async register(): Promise<void> {
    try {
      this.logger.info(
        'Registering with ee-mcp log monitor',
        {
          serviceName: this.serviceName,
          registrationPath: this.registrationPath,
        },
        'LogReaderRegistration'
      );

      // Ensure the services directory exists
      const servicesDir = path.dirname(this.registrationPath);
      await fs.mkdir(servicesDir, { recursive: true });

      // Get absolute path for log directory
      const absoluteLogDir = path.resolve(this.logDirectory);

      // Create registration data
      const registration: ServiceRegistration = {
        service_id: `${os.hostname()}-${this.serviceName}-${process.pid}`,
        service_name: this.serviceName,
        hostname: os.hostname(),
        pid: process.pid,
        log_directory: absoluteLogDir,
        log_pattern: '*.jsonl',
        started_at: new Date().toISOString(),
        version: this.version,
        metadata: {
          service_type: 'mcp_server',
          transport: 'streamable-http',
        },
      };

      // Write registration file
      await fs.writeFile(this.registrationPath, JSON.stringify(registration, null, 2), 'utf8');

      this.logger.info(
        'Successfully registered with ee-mcp log monitor',
        {
          registration: {
            service_id: registration.service_id,
            log_directory: registration.log_directory,
            log_pattern: registration.log_pattern,
          },
        },
        'LogReaderRegistration'
      );
    } catch (error) {
      // Non-fatal - log monitoring is optional
      this.logger.warn(
        'Failed to register with ee-mcp log monitor',
        {
          error:
            error instanceof Error
              ? {
                  message: error.message,
                  code: error.name,
                }
              : { message: String(error) },
          registrationPath: this.registrationPath,
        },
        'LogReaderRegistration'
      );
    }
  }

  /**
   * Unregister this service from the log monitor
   */
  async unregister(): Promise<void> {
    try {
      this.logger.info(
        'Unregistering from ee-mcp log monitor',
        {
          registrationPath: this.registrationPath,
        },
        'LogReaderRegistration'
      );

      await fs.unlink(this.registrationPath);

      this.logger.info(
        'Successfully unregistered from ee-mcp log monitor',
        {},
        'LogReaderRegistration'
      );
    } catch (error) {
      // If file doesn't exist, that's fine
      if ((error as any)?.code === 'ENOENT') {
        this.logger.debug(
          'Registration file already removed',
          {
            registrationPath: this.registrationPath,
          },
          'LogReaderRegistration'
        );
      } else {
        this.logger.warn(
          'Failed to unregister from ee-mcp log monitor',
          {
            error:
              error instanceof Error
                ? {
                    message: error.message,
                    code: error.name,
                  }
                : { message: String(error) },
            registrationPath: this.registrationPath,
          },
          'LogReaderRegistration'
        );
      }
    }
  }
}
