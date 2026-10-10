'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { JevAuditor } = require('../services/jev/auditor/service.cjs');
const { collect, ROOT, readInside } = require('../services/jev/auditor/evidence.cjs');
const { recordOutcome } = require('../services/jev/auditor/registry.cjs');
async function main() {
  const name = process.argv[2];
  const profiles = structuredClone(require('../services/jev/auditor/profiles.cjs').profiles);
  if (!Object.hasOwn(profiles, name)) throw Error('UNKNOWN_AUDIT_PROFILE');
  const flag = process.argv[3];
  const baselineId = flag?.match(/^--baseline=([a-f0-9-]{36})$/)?.[1];
  if (process.argv.length > 4 || (flag && !baselineId)) throw Error('UNKNOWN_AUDIT_ARGUMENT');
  if (baselineId) profiles[name].baselineFile = 'data/audits/' + baselineId + '.json';
  const provider = process.env.JEV_REVIEWER ?? 'ollama-local';
  if (!['ollama-local', 'ssh-llamacpp'].includes(provider)) throw Error('UNKNOWN_REVIEWER_PROVIDER');
  const { LlamaCppReviewer } = require('../services/jev/auditor/llamacpp.cjs');
  const auditor = provider === 'ssh-llamacpp'
    ? new JevAuditor({ reviewer: new LlamaCppReviewer(), escalationReviewer: new LlamaCppReviewer() })
    : new JevAuditor();
  const evidence = await collect({ ...profiles[name], architecture: readInside(ROOT, 'docs/JEV-AUDITOR.md') });
  console.log(JSON.stringify({ stage: 'EVIDENCE_COLLECTED', scope: evidence.packet.scope, bytes: Buffer.byteLength(JSON.stringify(evidence.packet)) }));
  const result = await auditor.audit(evidence.packet, { binding: evidence.binding });
  const stored = recordOutcome({ directory: path.join(ROOT, 'data/audits'), ...evidence, result });
  console.log(JSON.stringify({ ...stored.result, receipt: stored.file, frozen: stored.frozen }, null, 2));
  process.exitCode = stored.result.status === 'PASS' ? 0 : stored.result.status === 'FAIL' ? 2 : 3;
}
main().catch(async () => { console.error(JSON.stringify(await new JevAuditor().audit(null), null, 2)); process.exitCode = 3; });
