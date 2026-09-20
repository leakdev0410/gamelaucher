import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger";

const execFile = promisify(cp.execFile);

export interface AddDefenderExclusionResult {
  success: boolean;
  cancelled?: boolean;
  error?: string;
}

const escapeSingleQuotes = (value: string) => value.replace(/'/g, "''");

/**
 * Adds `targetPath` to the Windows Defender exclusion list. Requires an
 * elevated (UAC) prompt: a non-elevated PowerShell process launches an
 * elevated one via `Start-Process -Verb RunAs`, since Add-MpPreference
 * requires Administrator privileges.
 */
export async function addWindowsDefenderExclusion(
  targetPath: string
): Promise<AddDefenderExclusionResult> {
  if (process.platform !== "win32") {
    return { success: false, error: "not-windows" };
  }

  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "gl-defender-")
  );
  const resultFile = path.join(tmpDir, "result.txt");
  const innerScript = path.join(tmpDir, "add-exclusion.ps1");
  const outerScript = path.join(tmpDir, "elevate.ps1");

  try {
    const escapedTargetPath = escapeSingleQuotes(targetPath);
    const escapedResultFile = escapeSingleQuotes(resultFile);

    await fs.promises.writeFile(
      innerScript,
      [
        "$ErrorActionPreference = 'Stop'",
        "try {",
        `  Add-MpPreference -ExclusionPath '${escapedTargetPath}' -ErrorAction Stop`,
        `  'OK' | Out-File -FilePath '${escapedResultFile}' -Encoding utf8`,
        "} catch {",
        `  $_.Exception.Message | Out-File -FilePath '${escapedResultFile}' -Encoding utf8`,
        "}",
      ].join("\n"),
      "utf-8"
    );

    const escapedInnerScript = escapeSingleQuotes(innerScript);

    await fs.promises.writeFile(
      outerScript,
      [
        "try {",
        `  Start-Process -FilePath 'powershell' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${escapedInnerScript}') -Verb RunAs -Wait`,
        "} catch {",
        `  'CANCELLED' | Out-File -FilePath '${escapedResultFile}' -Encoding utf8`,
        "}",
      ].join("\n"),
      "utf-8"
    );

    await execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      outerScript,
    ]);

    if (!fs.existsSync(resultFile)) {
      return { success: false, cancelled: true };
    }

    const result = (await fs.promises.readFile(resultFile, "utf-8")).trim();

    if (result === "OK") return { success: true };
    if (result === "CANCELLED") return { success: false, cancelled: true };

    return { success: false, error: result || "unknown-error" };
  } catch (error) {
    logger.error("Failed to add Windows Defender exclusion", error);
    return { success: false, error: (error as Error).message };
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
