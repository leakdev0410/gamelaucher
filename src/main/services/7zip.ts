import { REPACK_ARCHIVE_PASSWORDS } from "@shared";
import { app } from "electron";
import Seven, { CommandLineSwitches } from "node-7z";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

const EXTRACTION_ATTEMPT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EXTRACTED_FILES = 25_000;

export const binaryName: Partial<Record<NodeJS.Platform, string>> = {
  linux: "7zzs",
  darwin: "7zz",
  win32: "7z.exe",
};

const resolveBinaryPath = () => {
  const platformBinaryName = binaryName[process.platform];

  if (!platformBinaryName) {
    throw new Error(`7zip is not supported on ${process.platform}`);
  }

  if (app.isPackaged) {
    return path.join(process.resourcesPath, platformBinaryName);
  }

  const candidates = [
    path.join(process.cwd(), "binaries", platformBinaryName),
    path.join(app.getAppPath(), "binaries", platformBinaryName),
    path.join(__dirname, "..", "..", "binaries", platformBinaryName),
  ];

  const existingPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (existingPath) {
    return existingPath;
  }

  logger.warn(
    `[SevenZip] Could not find 7zip binary. Tried: ${candidates.join(", ")}`
  );

  return candidates[0];
};

export interface ExtractionProgress {
  percent: number;
  fileCount: number;
  file: string;
}

export interface ExtractionResult {
  success: boolean;
  extractedFiles: string[];
}

export class SevenZip {
  private static readonly binaryPath = resolveBinaryPath();

  private static getErrorText(error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : "";

    return `${errorMessage}\n${stderr}`.toLowerCase();
  }

  private static isDataIntegrityError(error: unknown) {
    const normalizedMessage = this.getErrorText(error);

    return (
      normalizedMessage.includes("data error") ||
      normalizedMessage.includes("checksum error") ||
      normalizedMessage.includes("sub items errors")
    );
  }

  private static isPasswordRelatedError(error: unknown): boolean {
    if (this.isDataIntegrityError(error)) {
      return false;
    }

    const normalizedMessage = this.getErrorText(error);

    return (
      normalizedMessage.includes("wrong password") ||
      normalizedMessage.includes("can not open encrypted archive") ||
      normalizedMessage.includes("cannot open encrypted archive")
    );
  }

  private static isRecoverableExtractionError(
    error: unknown,
    extractedFilesCount: number
  ) {
    return extractedFilesCount > 0 && this.isDataIntegrityError(error);
  }

  private static isFileLockedError(error: unknown) {
    const normalizedMessage = this.getErrorText(error);

    return (
      normalizedMessage.includes("being used by another process") ||
      normalizedMessage.includes("cannot access the file") ||
      normalizedMessage.includes("process cannot access") ||
      normalizedMessage.includes("ebusy") ||
      normalizedMessage.includes("resource busy") ||
      normalizedMessage.includes("locked by another process")
    );
  }

  public static async extractFile(
    {
      filePath,
      outputPath,
      cwd,
      passwords = [...REPACK_ARCHIVE_PASSWORDS],
    }: {
      filePath: string;
      outputPath?: string;
      cwd?: string;
      passwords?: string[];
    },
    onProgress?: (progress: ExtractionProgress) => void
  ): Promise<ExtractionResult> {
    const maxLockRetries = 4;
    let lastLockError: unknown;

    for (let lockAttempt = 0; lockAttempt < maxLockRetries; lockAttempt++) {
      try {
        return await this.extractFileOnce(
          { filePath, outputPath, cwd, passwords },
          onProgress
        );
      } catch (error) {
        if (
          this.isFileLockedError(error) ||
          (error instanceof Error &&
            error.message.toLowerCase().includes("locked by another process"))
        ) {
          lastLockError = error;
          const waitMs = 2_000 * (lockAttempt + 1);
          logger.warn(
            `[SevenZip] Archive locked on attempt ${lockAttempt + 1}/${maxLockRetries} for ${filePath}; waiting ${waitMs}ms`
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        throw error;
      }
    }

    throw (
      lastLockError ??
      new Error(
        `Archive is locked by another process and cannot be extracted: ${filePath}`
      )
    );
  }

  private static extractFileOnce(
    {
      filePath,
      outputPath,
      cwd,
      passwords = [...REPACK_ARCHIVE_PASSWORDS],
    }: {
      filePath: string;
      outputPath?: string;
      cwd?: string;
      passwords?: string[];
    },
    onProgress?: (progress: ExtractionProgress) => void
  ): Promise<ExtractionResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let activeAttempt = 0;
      let attemptTimeout: NodeJS.Timeout | null = null;
      const passwordsToTry = Array.from(new Set(passwords));

      const clearAttemptTimeout = () => {
        if (attemptTimeout) {
          clearTimeout(attemptTimeout);
          attemptTimeout = null;
        }
      };

      const tryPassword = (index = 0) => {
        const attemptId = ++activeAttempt;
        const password = passwordsToTry[index] ?? "";
        logger.info(
          `Trying password "${password || "(empty)"}" on ${filePath}`
        );

        const extractedFiles: string[] = [];
        let fileCount = 0;
        const extractionRoot = path.resolve(outputPath || cwd || ".");

        const options: CommandLineSwitches = {
          $bin: this.binaryPath,
          $progress: true,
          yes: true,
          password: password || undefined,
        };

        if (outputPath) {
          options.outputDir = outputPath;
        }

        const stream = Seven.extractFull(filePath, outputPath || cwd || ".", {
          ...options,
          $spawnOptions: cwd ? { cwd } : undefined,
        });

        clearAttemptTimeout();
        attemptTimeout = setTimeout(() => {
          if (settled || attemptId !== activeAttempt) {
            return;
          }

          settled = true;
          if (typeof stream.destroy === "function") {
            stream.destroy();
          }
          reject(
            new Error(
              `Extraction timed out after ${EXTRACTION_ATTEMPT_TIMEOUT_MS / 1000}s for ${filePath}`
            )
          );
        }, EXTRACTION_ATTEMPT_TIMEOUT_MS);

        stream.on("progress", (progress) => {
          if (onProgress) {
            onProgress({
              percent: progress.percent,
              fileCount: fileCount,
              file: progress.fileCount?.toString() || "",
            });
          }
        });

        stream.on("data", (data) => {
          if (data.file) {
            const extractedPath = path.resolve(extractionRoot, data.file);
            if (!extractedPath.startsWith(`${extractionRoot}${path.sep}`)) {
              clearAttemptTimeout();
              settled = true;
              if (typeof stream.destroy === "function") stream.destroy();
              reject(
                new Error("Archive entry escapes the extraction directory")
              );
              return;
            }

            extractedFiles.push(data.file);
            fileCount++;
            if (fileCount > MAX_EXTRACTED_FILES) {
              clearAttemptTimeout();
              settled = true;
              if (typeof stream.destroy === "function") stream.destroy();
              reject(new Error("Archive contains too many files"));
            }
          }
        });

        stream.on("end", () => {
          if (settled || attemptId !== activeAttempt) {
            return;
          }

          clearAttemptTimeout();
          settled = true;
          logger.info(
            `Successfully extracted ${filePath} (${extractedFiles.length} files)`
          );
          resolve({
            success: true,
            extractedFiles,
          });
        });

        stream.on("error", (err) => {
          if (settled || attemptId !== activeAttempt) {
            return;
          }

          clearAttemptTimeout();

          if (this.isRecoverableExtractionError(err, extractedFiles.length)) {
            settled = true;
            logger.warn(
              `[SevenZip] Extraction finished with integrity warnings for ${filePath} (${extractedFiles.length} files)`,
              err
            );
            resolve({
              success: true,
              extractedFiles,
            });
            return;
          }

          if (this.isFileLockedError(err)) {
            settled = true;
            reject(
              new Error(
                `Archive is locked by another process and cannot be extracted: ${filePath}`
              )
            );
            return;
          }

          logger.error(`Extraction error for ${filePath}:`, err);

          const shouldTryNextPassword =
            index < passwordsToTry.length - 1 &&
            this.isPasswordRelatedError(err);

          if (shouldTryNextPassword) {
            logger.info(
              `Failed to extract file: ${filePath} with password: "${password}". Trying next password...`
            );
            tryPassword(index + 1);
          } else {
            settled = true;
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            logger.error(
              `Failed to extract file: ${filePath} after trying all passwords`
            );
            reject(
              new Error(`Failed to extract file: ${filePath}: ${errorMessage}`)
            );
          }
        });
      };

      tryPassword(0);
    });
  }

  public static listFiles(
    filePath: string,
    password?: string
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const files: string[] = [];

      const options: CommandLineSwitches = {
        $bin: this.binaryPath,
        password: password || undefined,
      };

      const stream = Seven.list(filePath, options);

      stream.on("data", (data) => {
        if (data.file) {
          files.push(data.file);
        }
      });

      stream.on("end", () => {
        resolve(files);
      });

      stream.on("error", (err) => {
        reject(err);
      });
    });
  }
}
