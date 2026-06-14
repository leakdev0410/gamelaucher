const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "../src");
const atomsDir = path.join(__dirname, "../.hyperfrag/atoms");
const skillsDir = path.join(__dirname, "../.hyperfrag/skills");

if (!fs.existsSync(atomsDir)) fs.mkdirSync(atomsDir, { recursive: true });
if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

let atomCounter = 1;
let totalFiles = 0;
let totalLinesAnalyzed = 0;

const atomBreakdown = {
  R1: 0,
  R2: 0,
  R3: 0,
};

const moduleStats = {};

function getRiskTier(filePath, content) {
  const contentLower = content.toLowerCase();
  // R3 Critical: Auth, Security, RPC, IPC, Crypto, file system
  if (
    filePath.includes("ipc") ||
    filePath.includes("auth") ||
    filePath.includes("crypto") ||
    filePath.includes("go-rpc") ||
    filePath.includes("preload")
  )
    return "R3";
  if (
    contentLower.includes("password") ||
    contentLower.includes("token") ||
    contentLower.includes("secret") ||
    contentLower.includes("exec") ||
    contentLower.includes("spawn")
  )
    return "R3";

  // R2 Elevated: Concurrency, error paths, public APIs, database, torrent/download
  if (
    filePath.includes("download") ||
    filePath.includes("torrent") ||
    filePath.includes("db") ||
    filePath.includes("database") ||
    filePath.includes("store")
  )
    return "R2";
  if (
    contentLower.includes("promise.all") ||
    contentLower.includes("transaction") ||
    contentLower.includes("mutex") ||
    contentLower.includes("queue")
  )
    return "R2";

  // R1 Standard: Everything else
  return "R1";
}

function processDirectory(directory) {
  const files = fs.readdirSync(directory);

  for (const file of files) {
    const fullPath = path.join(directory, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      processDirectory(fullPath);
    } else if (file.match(/\.(ts|tsx|js|jsx)$/)) {
      totalFiles++;
      const relativePath = path.relative(srcDir, fullPath).replace(/\\/g, "/");
      const moduleName = relativePath.split("/")[0];

      if (!moduleStats[moduleName])
        moduleStats[moduleName] = { files: 0, lines: 0, atoms: 0 };

      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split("\n");
      const lineCount = lines.length;

      totalLinesAnalyzed += lineCount;
      moduleStats[moduleName].files++;
      moduleStats[moduleName].lines += lineCount;

      const riskTier = getRiskTier(relativePath, content);

      // Determine atom split: roughly every 50 lines gets an atom, unless it's a very small file.
      const maxLinesPerAtom = 60;
      let startLine = 1;

      while (startLine <= lineCount) {
        const endLine = Math.min(startLine + maxLinesPerAtom - 1, lineCount);
        const chunkLength = endLine - startLine + 1;

        // Don't make an atom for a trailing chunk of < 5 lines unless it's the only one
        if (chunkLength < 5 && startLine > 1) {
          break;
        }

        const atomId = `A-${String(atomCounter).padStart(4, "0")}`;
        atomCounter++;
        atomBreakdown[riskTier]++;
        moduleStats[moduleName].atoms++;

        const atomContent = `id: ${atomId}\nparent: ROOT\ntype: review\nrisk: ${riskTier}\ngoal: Review ${relativePath} from line ${startLine} to ${endLine} for logic, security, and performance correctness.\npre: []\npost: "No bugs found in logic block, and edge cases handled."\nevidence_required: diff\nstatus: PENDING\n`;
        fs.writeFileSync(path.join(atomsDir, `${atomId}.md`), atomContent);

        startLine = endLine + 1;
      }
    }
  }
}

console.log("Analyzing src directory...");
processDirectory(srcDir);

// Generate Micro-Skills
const msTypes = [
  {
    id: "MS-react",
    scope: "React rendering, hooks, state management",
    invariants: "No infinite render loops, hooks dependencies are correct",
  },
  {
    id: "MS-electron-main",
    scope: "Electron main process IPC, native bindings, window management",
    invariants: "No memory leaks on window close, secure IPC handling",
  },
  {
    id: "MS-electron-preload",
    scope: "ContextBridge, isolation",
    invariants:
      "contextIsolation must be preserved, no native objects leaked to renderer",
  },
  {
    id: "MS-go-rpc",
    scope: "Go backend integration",
    invariants: "Timeouts handled gracefully, payload validation",
  },
];

for (const ms of msTypes) {
  const content = `# MICROSKILL: ${ms.id}\nSCOPE: ${ms.scope}\nGROUND TRUTHS: ...\nAPI CONTRACTS: ...\nINVARIANTS: ${ms.invariants}\nPITFALLS: ...\nOUTPUT CONTRACT: ...\nVERIFICATION RECIPE: ...\n`;
  fs.writeFileSync(path.join(skillsDir, `${ms.id}.md`), content);
}

// Generate PLAN.md
const totalAtoms = atomCounter - 1;

let planContent = `# HYPERFRAGMENT REVIEW PLAN\n## Objective\nConduct a rigorously fragmented logic and security review of the entire \`src\` directory (${totalLinesAnalyzed} lines across ${totalFiles} files).\n\n## Non-Goals\nRefactoring purely for style. Adding new features. (Mechanical lint/type checks are already 0-defect).\n\n## Fact Base Summary\n- Project contains \`main\` (Electron), \`renderer\` (React), \`shared\`, \`types\`, \`locales\`.\n- All static type and lint checks pass. We are hunting for *semantic* logic bugs (race conditions, unhandled rejections, state desync, security flaws).\n\n## Atom DAG\nTotal Atoms Created: **${totalAtoms}**\n\n### Breakdown by Risk Tier:\n- **R1 (Standard)**: ${atomBreakdown.R1}\n- **R2 (Elevated)**: ${atomBreakdown.R2}\n- **R3 (Critical)**: ${atomBreakdown.R3}\n\n### Breakdown by Module:\n`;

for (const [mod, stats] of Object.entries(moduleStats)) {
  planContent += `- **${mod}**: ${stats.atoms} atoms (covering ${stats.files} files, ${stats.lines} lines)\n`;
}

planContent += `\n## Micro-skill Index\n- \`MS-react\`: For renderer components\n- \`MS-electron-main\`: For main process\n- \`MS-electron-preload\`: For IPC bridge\n- \`MS-go-rpc\`: For external process mgmt\n\n## Delegation Map\n- R3 Atoms -> FRONTIER tier agents (Maximum reasoning, cross-verified)\n- R2 Atoms -> FRONTIER tier agents (Deep logic check)\n- R1 Atoms -> FAST tier agents (Standard code inspection)\n\n## Effort Estimate\nReviewing ${totalAtoms} atoms will require approximately ${totalAtoms} LLM passes. At ~15 seconds per pass, serial execution would take ~${((totalAtoms * 15) / 3600).toFixed(1)} hours. Parallel execution with a concurrency of 20 subagents would take ~${Math.ceil((totalAtoms * 15) / 20 / 60)} minutes.\nToken usage will be substantial.\n\n**PLAN GENERATED.**\n`;

fs.writeFileSync(path.join(__dirname, "../.hyperfrag/PLAN.md"), planContent);

console.log(`Successfully generated ${totalAtoms} atoms.`);
console.log(`PLAN written to .hyperfrag/PLAN.md`);
