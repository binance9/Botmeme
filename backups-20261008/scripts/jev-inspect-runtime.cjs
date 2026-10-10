'use strict';
const { runTechnicalInspection } = require('../services/jev/auditor/technical-inspection.cjs');
if (process.argv.length !== 2) { console.error('Usage: node scripts/jev-inspect-runtime.cjs'); process.exitCode = 2; }
else {
  try {
    const { file, report } = runTechnicalInspection();
    console.log(JSON.stringify({ file, receipt_id: report.receipt_id, status: report.status, technical_status: report.technical_status, missing_evidence: report.missing_evidence }, null, 2));
    process.exitCode = report.technical_status === 'FAILED' ? 2 : report.technical_status === 'CHUA_XAC_MINH' ? 3 : 0;
  } catch { console.error(JSON.stringify({ producer: 'JEV_AUDITOR', status: 'CHUA_XAC_MINH', technical_status: 'CHUA_XAC_MINH', missing_evidence: ['TECHNICAL_INSPECTION_HOST_ERROR'] })); process.exitCode = 3; }
}
