import {rehearseProductionSnapshot} from "../dist/infra/production-snapshot-rehearsal.js";

const snapshot=process.argv[2];
if(!snapshot)throw new Error("usage: node scripts/verify-production-snapshot.mjs <isolated-backup.sqlite>");
const report=await rehearseProductionSnapshot(snapshot,process.env);
process.stdout.write(JSON.stringify(report,null,2)+"\n");
