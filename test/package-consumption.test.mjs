import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_PACKAGE_TEST_PI ?? "pi";

async function waitForFile(path, child, stderr) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    if (child.exitCode !== null) {
      throw new Error(`Pi exited before package registration was captured: ${stderr()}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for package registration: ${stderr()}`);
}

async function waitForAbsent(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!existsSync(path)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return false;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out stopping package-consumption Pi process."));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

test("Pi discovers the Companion extension and skill through the package manifest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-package-test-"));
  const agentDir = join(directory, "agent");
  const outputPath = join(directory, "registrations.json");
  const probePath = join(directory, "probe.ts");
  const sessionId = randomUUID();
  const socketPath = join(tmpdir(), `pi-cmp-${process.getuid()}`, `${sessionId}.sock`);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }), "utf8");
  writeFileSync(probePath, `
    import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
    import { writeFileSync } from "node:fs";
    export default function probe(pi: ExtensionAPI): void {
      pi.on("session_start", () => {
        writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({
          commands: pi.getCommands(),
          tools: pi.getAllTools(),
        }));
      });
    }
  `, "utf8");

  // The invoked Pi must resolve its own assets, not those of a different Pi
  // installation hosting this test runner (for example a packaged CLI).
  const { PI_PACKAGE_DIR: _parentPackageDir, ...environment } = process.env;
  let stderr = "";
  const child = spawn(pi, [
    "--mode", "rpc",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--offline",
    "--session-id", sessionId,
    "--session-dir", join(directory, "sessions"),
    "--extension", probePath,
  ], {
    cwd: root,
    env: {
      ...environment,
      HOME: directory,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitForFile(outputPath, child, () => stderr);
    await waitForFile(socketPath, child, () => stderr);
    const registrations = JSON.parse(readFileSync(outputPath, "utf8"));
    const entrypoint = join(root, "src", "index.ts");
    const companionCommands = registrations.commands.filter(
      (command) => command.sourceInfo?.path === entrypoint,
    );
    const companionTools = registrations.tools.filter(
      (tool) => tool.sourceInfo?.path === entrypoint,
    );

    assert.deepEqual(companionCommands.map((command) => command.name), ["companion"]);
    assert.deepEqual(companionTools.map((tool) => tool.name), ["companion"]);
    assert.equal(registrations.commands.filter((command) => command.name === "companion").length, 1);
    assert.equal(registrations.tools.filter((tool) => tool.name === "companion").length, 1);

    const skills = registrations.commands.filter((command) => command.source === "skill");
    assert.deepEqual(skills.map((skill) => skill.name), ["skill:companions"]);
    assert.equal(skills[0].sourceInfo.path, join(root, "skills", "companions", "SKILL.md"));
  } finally {
    await stop(child);
    const socketRemoved = await waitForAbsent(socketPath);
    rmSync(directory, { recursive: true, force: true });
    assert.equal(socketRemoved, true, `Package test left socket ${socketPath}`);
  }
});
