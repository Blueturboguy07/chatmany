#!/usr/bin/env node
// Does a packaged chatmany carry its publik app token? No dependencies.
//
//   node scripts/has-app-token.mjs <path to resources/app.asar>
//
// It reads package.json out of the app.asar archive and says whether
// `publik.appToken` is a non-empty string. It never prints the token, or any
// part of it. Exit 0 when the token is there, 1 when it is not, 2 when the
// archive cannot be read.
import { closeSync, openSync, readSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/has-app-token.mjs <path to app.asar>");
  process.exit(2);
}

function read(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const got = readSync(fd, buffer, 0, length, position);
  if (got !== length) throw new Error("the archive ends too early");
  return buffer;
}

let pkg;
try {
  const fd = openSync(file, "r");
  try {
    // asar layout: a 16-byte prefix, then the JSON file table, then the files.
    // prefix: [4][size of the header pickle][size of its payload][length of the JSON]
    const prefix = read(fd, 0, 16);
    const headerSize = prefix.readUInt32LE(4);
    const jsonLength = prefix.readUInt32LE(12);
    const table = JSON.parse(read(fd, 16, jsonLength).toString("utf8"));
    const entry = table.files?.["package.json"];
    if (!entry || entry.unpacked || typeof entry.size !== "number") throw new Error("no package.json in the archive");
    const start = 8 + headerSize + Number(entry.offset);
    pkg = JSON.parse(read(fd, start, entry.size).toString("utf8"));
  } finally {
    closeSync(fd);
  }
} catch (error) {
  console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const token = pkg?.publik?.appToken;
const present = typeof token === "string" && token.trim().length > 0;
console.log(`package ${pkg?.name ?? "?"} ${pkg?.version ?? "?"}: app token ${present ? "present" : "MISSING"} (value not shown)`);
process.exit(present ? 0 : 1);
