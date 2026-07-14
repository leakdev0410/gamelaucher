import path from "node:path";
import fs from "node:fs";
import { SystemPath } from "./system-path";
import { logger } from "./logger";

export class Lock {
  private static lockFilePath = path.join(
    SystemPath.getPath("temp"),
    "game-launcher.lock"
  );

  private static isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private static tryCreateExclusive(): boolean {
    try {
      const fd = fs.openSync(this.lockFilePath, "wx");
      fs.writeFileSync(fd, String(process.pid), "utf8");
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  public static async acquireLock() {
    try {
      if (this.tryCreateExclusive()) {
        logger.info("Acquired the lock");
        return;
      }

      // Stale lock: previous process died without releasing.
      try {
        const raw = fs.readFileSync(this.lockFilePath, "utf8").trim();
        const existingPid = Number.parseInt(raw, 10);
        if (!this.isPidAlive(existingPid)) {
          fs.unlinkSync(this.lockFilePath);
          if (this.tryCreateExclusive()) {
            logger.info("Acquired the lock after reclaiming stale lock file");
            return;
          }
        }
      } catch (error) {
        logger.error("Error inspecting existing lock", error);
      }

      // Soft-fail: Electron single-instance lock is the primary guard.
      // Overwrite so this instance still records ownership.
      fs.writeFileSync(this.lockFilePath, String(process.pid), "utf8");
      logger.warn(
        "Lock file already present; overwriting after soft check (single-instance is primary)"
      );
    } catch (error) {
      logger.error("Error acquiring the lock", error);
      throw error;
    }
  }

  public static async releaseLock() {
    try {
      if (!fs.existsSync(this.lockFilePath)) {
        return;
      }
      const raw = fs.readFileSync(this.lockFilePath, "utf8").trim();
      const ownerPid = Number.parseInt(raw, 10);
      if (ownerPid === process.pid || !this.isPidAlive(ownerPid)) {
        fs.unlinkSync(this.lockFilePath);
        logger.info("Released the lock");
      }
    } catch (error) {
      logger.error("Error releasing the lock", error);
    }
  }
}
