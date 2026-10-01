import {writeFileSync, unlinkSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {workspaceJs} from "../dist/operations/workspace-page.js";

const target = "tmp-workspace-app.js";
writeFileSync(target, workspaceJs);
const result = spawnSync(process.execPath, ["--check", target], {stdio: "inherit"});
unlinkSync(target);
if (result.status !== 0) process.exit(result.status ?? 1);
