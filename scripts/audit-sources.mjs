#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseLine } from "../src/parsers.js";

const inputs = process.argv.slice(2);
const roots = inputs.length ? inputs : ["samples", "Testdata"];
const files = roots.flatMap((root) => collectFiles(root)).filter(isUsefulFile);

const totals = {
  files: files.length,
  lines: 0,
  parsed: 0,
  raw: 0,
  unknownPgn: 0,
  genericNmea: 0
};
const protocols = new Map();
const pgns = new Map();
const unknownPgns = new Map();
const nmeaSentences = new Map();
const genericNmeaSentences = new Map();
const rawExamples = [];

for (const file of files) {
  for (const line of extractLines(file)) {
    totals.lines += 1;
    const parsed = parseLine(line);
    if (!parsed) continue;
    totals.parsed += 1;
    count(protocols, parsed.protocol);

    if (parsed.nmea2000?.pgn !== undefined) {
      const key = `${parsed.nmea2000.pgn} ${parsed.nmea2000.name || "Unknown PGN"}`;
      count(pgns, key);
      if (parsed.nmea2000.name === "Unknown PGN") {
        totals.unknownPgn += 1;
        count(unknownPgns, String(parsed.nmea2000.pgn));
      }
    }

    if (parsed.protocol === "nmea0183") {
      const key = `${parsed.talker || "??"}${parsed.sentence || "??"}`;
      count(nmeaSentences, key);
      if (Object.keys(parsed.decoded || {}).some((key) => /^field\d+$/.test(key))) {
        totals.genericNmea += 1;
        count(genericNmeaSentences, key);
      }
    }

    if (parsed.protocol === "raw") {
      totals.raw += 1;
      if (rawExamples.length < 10) rawExamples.push({ file, line });
    }
  }
}

printSection("Source Audit");
console.log(`Files:         ${totals.files}`);
console.log(`Candidate rows:${totals.lines}`);
console.log(`Parsed rows:   ${totals.parsed}`);
console.log(`Raw rows:      ${totals.raw}`);
console.log(`Unknown PGNs:  ${totals.unknownPgn}`);
console.log(`Generic NMEA:  ${totals.genericNmea}`);

printMap("Protocols", protocols);
printMap("Top PGNs", pgns, 25);
printMap("Unknown PGNs", unknownPgns);
printMap("NMEA 0183 Sentences", nmeaSentences);
printMap("Generic NMEA 0183 Sentences", genericNmeaSentences);

if (rawExamples.length) {
  printSection("Raw Examples");
  for (const example of rawExamples) {
    console.log(`${example.file}: ${example.line}`);
  }
}

function collectFiles(root) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(root)
    .flatMap((name) => collectFiles(path.join(root, name)));
}

function isUsefulFile(file) {
  const base = path.basename(file);
  return base !== ".DS_Store" && base !== "README.md" && !base.startsWith("Icon");
}

function extractLines(file) {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        return data.map((item) => item?.raw).filter(Boolean);
      }
    } catch {
      return text.split(/\r?\n/);
    }
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(extractRawLine)
    .filter(Boolean);
}

function extractRawLine(line) {
  const nmea = line.match(/[!$][A-Z0-9]{5},[^ \t]*/);
  if (nmea) return nmea[0];
  const pgn = line.match(/(?:P\d+>N2K:\s*)?PGN:\s*\d+\[[0-9A-Fa-f]+\].*/);
  if (pgn) return pgn[0];
  const debug = line.match(/N2K:\s*PGN:.*$/);
  if (debug) return debug[0];
  if (/^[tT][0-9A-Fa-f]/.test(line)) return line;
  if (/^\(\d+\.\d+\)\s+\S+\s+[0-9A-Fa-f]{3,8}#[0-9A-Fa-f]*/.test(line)) return line;
  return null;
}

function count(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function printSection(title) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

function printMap(title, map, limit = 50) {
  printSection(title);
  if (!map.size) {
    console.log("None");
    return;
  }
  for (const [key, value] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    console.log(`${String(value).padStart(6)}  ${key}`);
  }
}
