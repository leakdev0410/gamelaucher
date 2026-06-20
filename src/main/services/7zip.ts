import { app } from "electron";
import Seven, { CommandLineSwitches } from "node-7z";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

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

  private static isPasswordRelatedError(error: unknown): boolean {
    const errorMessage =
      error instanceof Error ? error.message : String(error ?? "");
    const normalizedMessage = errorMessage.toLowerCase();

    return (
      normalizedMessage.includes("wrong password") ||
      normalizedMessage.includes("can not open encrypted archive") ||
      normalizedMessage.includes("encrypted")
    );
  }

  public static extractFile(
    {
      filePath,
      outputPath,
      cwd,
      passwords = [],
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
      const passwordsToTry = Array.from(new Set(["", ...passwords]));

      const tryPassword = (index = 0) => {
        const attemptId = ++activeAttempt;
        const password = passwordsToTry[index] ?? "";
        logger.info(
          `Trying password "${password || "(empty)"}" on ${filePath}`
        );

        const extractedFiles: string[] = [];
        let fileCount = 0;

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
            extractedFiles.push(data.file);
            fileCount++;
          }
        });

        stream.on("end", () => {
          if (settled || attemptId !== activeAttempt) {
            return;
          }

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
