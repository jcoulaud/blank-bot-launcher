#!/usr/bin/env node
// Lightweight launcher that delegates to tsx so the bot runs the TypeScript
// source directly. We use tsx (esbuild) instead of pre-compiled JS because
// @blankdotbuild/sdk currently ships extensionless ESM imports that strict
// Node ESM rejects, but esbuild handles transparently.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "..", "src", "index.ts");
const tsxBin = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

const child = spawn(tsxBin, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));
