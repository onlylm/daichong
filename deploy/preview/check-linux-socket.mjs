import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {lstat, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import net from "node:net";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {promisify} from "node:util";
import {preparePreviewSocket} from "./bridge.mjs";

const prefix = "quefa-preview-socket-check-";
let completed = 0;
let directory;
const servers = new Set();

async function listen(path) {
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  servers.add(server);
  return server;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
  servers.delete(server);
}

async function check() {
  if (process.platform !== "linux") throw new Error("linux_required");
  directory = await mkdtemp(join(tmpdir(), prefix));

  const activePath = join(directory, "active.sock");
  const active = await listen(activePath);
  await assert.rejects(preparePreviewSocket(activePath), /preview_socket_already_active/);
  assert.equal((await lstat(activePath)).isSocket(), true);
  await close(active);
  completed++;

  const stalePath = join(directory, "stale.sock");
  await promisify(execFile)(process.execPath, ["-e",
    "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))", stalePath], {timeout: 5_000});
  assert.equal((await lstat(stalePath)).isSocket(), true);
  await preparePreviewSocket(stalePath);
  await assert.rejects(lstat(stalePath), {code: "ENOENT"});
  const restored = await listen(stalePath);
  assert.equal((await lstat(stalePath)).isSocket(), true);
  await close(restored);
  completed++;

  const filePath = join(directory, "ordinary-file.sock");
  const original = Buffer.from("synthetic-socket-path-fixture");
  await writeFile(filePath, original, {flag: "wx", mode: 0o600});
  await assert.rejects(preparePreviewSocket(filePath), /preview_socket_path_occupied/);
  assert.deepEqual(await readFile(filePath), original);
  completed++;
}

let passed = false;
try {
  await check();
  passed = true;
} catch {
  process.exitCode = 1;
} finally {
  try {
    for (const server of servers) await close(server);
    if (directory) {
      // Removal is restricted to this invocation's mkdtemp output, never the real preview path.
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith(prefix));
      await rm(target, {recursive: true, force: true});
    }
  } catch {
    passed = false;
    process.exitCode = 1;
  }
  console.log(JSON.stringify({checks: completed, status: passed ? "pass" : "fail"}));
}
