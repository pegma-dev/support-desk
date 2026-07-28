import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TABLE_PORT = 10112;

let child: ChildProcess | undefined;
let workspace: string | undefined;

function portAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const settle = (accepting: boolean) => {
      socket.destroy();
      resolve(accepting);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1000, () => settle(false));
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portAccepting(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Azurite did not start listening on port ${port} within ${timeoutMs}ms.`,
  );
}

export async function setup(): Promise<void> {
  const entry = join(
    process.cwd(),
    "node_modules",
    "azurite",
    "dist",
    "src",
    "table",
    "main.js",
  );
  if (!existsSync(entry)) {
    throw new Error(
      `Could not find Azurite's table service at ${entry}. Run 'npm ci' first.`,
    );
  }

  workspace = await mkdtemp(join(tmpdir(), "pegma-support-azurite-"));
  child = spawn(
    process.execPath,
    [
      entry,
      "--location",
      workspace,
      "--silent",
      "--tableHost",
      "127.0.0.1",
      "--tablePort",
      String(TABLE_PORT),
    ],
    { stdio: "ignore" },
  );

  child.once("error", (error) => {
    throw error;
  });

  await waitForPort(TABLE_PORT, 30_000);
}

export async function teardown(): Promise<void> {
  child?.kill();
  child = undefined;
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
}
