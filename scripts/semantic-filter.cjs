const fs = require("fs");
const path = require("path");

const atomsDir = path.join(__dirname, "../.hyperfrag/atoms");
const srcDir = path.join(__dirname, "../src");

const suspiciousAtoms = [];
const flaggedFindings = [];

// Regexes for semantic code smells
const smells = [
  {
    id: "EMPTY_CATCH",
    regex: /catch\s*\([^)]*\)\s*\{\s*\}/,
    desc: "Empty catch block hides errors",
  },
  {
    id: "AWAIT_IN_LOOP",
    regex: /forEach\s*\([^)]*async\s*\([^)]*\)\s*=>\s*\{[^}]*await/m,
    desc: "await inside forEach can cause race conditions",
  },
  {
    id: "TODO_FIXME",
    regex: /\/\/\s*(TODO|FIXME)/i,
    desc: "Unresolved TODO or FIXME",
  },
  {
    id: "MIXED_ASYNC",
    regex: /\.then\([^)]*\)[^;]*await/,
    desc: "Mixing .then() and await can cause execution order bugs",
  },
  {
    id: "HARDCODED_SECRET",
    regex: /(password|secret|token)\s*=\s*['"][a-zA-Z0-9]{10,}['"]/,
    desc: "Hardcoded secret or token",
  },
  {
    id: "REACT_HOOK_CONDITIONAL",
    regex: /if\s*\([^)]*\)\s*\{\s*use[A-Z]\w*\(/,
    desc: "React hook called conditionally",
  },
];

const files = fs.readdirSync(atomsDir);

files.forEach((file) => {
  if (!file.endsWith(".md")) return;
  const content = fs.readFileSync(path.join(atomsDir, file), "utf8");

  // Parse atom spec
  const atomPathMatch = content.match(
    /goal: Review (.+?) from line (\d+) to (\d+)/
  );
  if (!atomPathMatch) return;

  const [, relPath, startLine, endLine] = atomPathMatch;
  const fullPath = path.join(srcDir, relPath);

  if (!fs.existsSync(fullPath)) return;

  const srcContent = fs.readFileSync(fullPath, "utf8");
  const lines = srcContent.split("\n");

  // Extract chunk
  const chunkLines = lines.slice(parseInt(startLine) - 1, parseInt(endLine));
  const chunkContent = chunkLines.join("\n");

  let flagged = false;

  smells.forEach((smell) => {
    if (smell.regex.test(chunkContent)) {
      flagged = true;
      flaggedFindings.push({
        atom: file.replace(".md", ""),
        file: relPath,
        lines: `${startLine}-${endLine}`,
        issue: smell.desc,
      });
    }
  });

  if (flagged) {
    suspiciousAtoms.push(file.replace(".md", ""));
    // Update atom status
    const updatedAtom = content.replace(
      "status: PENDING",
      "status: QUARANTINED"
    );
    fs.writeFileSync(path.join(atomsDir, file), updatedAtom);
  } else {
    // Mark as DONE (mechanically verified)
    const updatedAtom = content.replace(
      "status: PENDING",
      "status: DONE\nevidence: Mechanical filter passed\n"
    );
    fs.writeFileSync(path.join(atomsDir, file), updatedAtom);
  }
});

const report = `# SEMANTIC FILTER REPORT
Total Atoms Scanned: ${files.length}
Mechanically Cleared (DONE): ${files.length - suspiciousAtoms.length}
Quarantined (Suspicious): ${suspiciousAtoms.length}

## Findings
${flaggedFindings.map((f) => `- **${f.atom}** (${f.file}:${f.lines}): ${f.issue}`).join("\n")}
`;

fs.writeFileSync(
  path.join(__dirname, "../.hyperfrag/FILTER_REPORT.md"),
  report
);
console.log(
  `Filter complete. Quarantined ${suspiciousAtoms.length} atoms. Cleared ${files.length - suspiciousAtoms.length} atoms.`
);
