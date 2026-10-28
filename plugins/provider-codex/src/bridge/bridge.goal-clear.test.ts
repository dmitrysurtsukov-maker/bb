import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import { cleanupBridgeProcessTest } from "./bridge-process.test-support.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_goal_clear_1";
const PROVIDER_THREAD_ID = "rollout-goal-clear-1";

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness> | undefined;
let workspaceDir = "";
let processLogPath = "";
let requestLogPath = "";

function startBridge(goalClear?: Record<string, unknown>): void {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-goal-clear-"));
  processLogPath = join(workspaceDir, "app-server-processes.log");
  requestLogPath = join(workspaceDir, "app-server-requests.log");
  const scriptPath = join(workspaceDir, "fake-codex-script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      archiveStatePath: join(workspaceDir, "fake-codex-archived.json"),
      processLogPath,
      requestLogPath,
      goalClear,
    }),
  );
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
}

afterEach(async () => {
  await cleanupBridgeProcessTest({
    harness,
    cleanupId: 994_001,
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    processLogPath,
    workspaceDir,
    unstubEnvs: vi.unstubAllEnvs,
  });
  harness = undefined;
  workspaceDir = "";
});

function bridge(): ReturnType<typeof createBridgeJsonRpcTestHarness> {
  if (harness === undefined) {
    throw new Error("bridge was not started");
  }
  return harness;
}

function request(id: number, method: string, extra?: Record<string, unknown>) {
  bridge().sendRequest(id, method, {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    ...extra,
  });
  return bridge().waitForResponse(id);
}

function appServerRequests(method: string): unknown[] {
  if (!existsSync(requestLogPath)) {
    return [];
  }
  return readFileSync(requestLogPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { method: string; params: unknown })
    .filter((entry) => entry.method === method)
    .map((entry) => entry.params);
}

it.each([
  { name: "an empty acknowledgement", result: {}, cleared: true },
  { name: "a native true", result: { cleared: true }, cleared: true },
  { name: "a native false", result: { cleared: false }, cleared: false },
  { name: "a null acknowledgement", result: null, cleared: true },
])(
  "answers $name from the app-server with the strict cleared result",
  async ({ result, cleared }) => {
    startBridge({ result });

    const response = await request(1, "thread/goal/clear");

    expect(response.error).toBeUndefined();
    expect(response.result).toStrictEqual({ cleared });
    expect(appServerRequests("thread/goal/clear")).toStrictEqual([
      { threadId: PROVIDER_THREAD_ID },
    ]);
  },
  30_000,
);

it("clears the goal once through the live session of a resumed thread", async () => {
  startBridge({ result: { cleared: false } });
  const resumed = await request(1, "thread/resume", {
    cwd: workspaceDir,
    instructionMode: "append",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  expect(resumed.error).toBeUndefined();

  const response = await request(2, "thread/goal/clear");

  expect(response.result).toStrictEqual({ cleared: false });
  expect(appServerRequests("thread/goal/clear")).toStrictEqual([
    { threadId: PROVIDER_THREAD_ID },
  ]);
}, 30_000);

it("reports an app-server failure as a bridge error without a success result or retry", async () => {
  startBridge({
    error: { code: -32603, message: "goal clear rejected by codex" },
  });

  const response = await request(1, "thread/goal/clear");

  expect(response.result).toBeUndefined();
  expect(response.error?.message).toBe("goal clear rejected by codex");
  expect(appServerRequests("thread/goal/clear")).toHaveLength(1);
}, 30_000);

it("keeps the generic maintenance acknowledgement for other thread methods", async () => {
  startBridge({ result: { cleared: false } });

  expect(
    (await request(1, "thread/name/set", { title: "Renamed" })).result,
  ).toStrictEqual({ ok: true });
  expect((await request(2, "thread/archive")).result).toStrictEqual({
    ok: true,
  });
  expect((await request(3, "thread/unarchive")).result).toStrictEqual({
    ok: true,
  });
  expect(appServerRequests("thread/goal/clear")).toStrictEqual([]);
}, 30_000);
