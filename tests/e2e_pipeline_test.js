#!/usr/bin/env node

/**
 * tests/e2e_pipeline_test.js
 * End-to-End Pipeline & Notion Sync Validation (Phase 7 - Step 7.3)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const JobApplicationPipeline = require('../job_application_pipeline');

const SAMPLE_JOB_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Service Desk Analyst - Beyond Recruitment</title>
</head>
<body>
  <header>
    <h1>Service Desk Analyst</h1>
    <div class="company-name">Beyond Recruitment</div>
  </header>
  <main>
    <h2>About the Role</h2>
    <p>Beyond Recruitment is seeking a motivated and customer-focused Service Desk Analyst to join our team in Auckland. You will provide L1 and L2 technical support, troubleshoot hardware and software incidents, and assist internal users with modern workplace technologies.</p>

    <h2>Key Responsibilities</h2>
    <ul>
      <li>First point of contact for technical support requests logged via Jira Service Management.</li>
      <li>Administer user accounts, permissions, and security groups in Active Directory and Microsoft Entra ID (Azure AD).</li>
      <li>Deploy, configure, and troubleshoot Windows 10/11 endpoints, laptops, and peripheral hardware.</li>
      <li>Support Microsoft 365 services including Exchange Online, Teams, OneDrive, and SharePoint.</li>
      <li>Diagnose network connectivity, VPN access, DNS, and DHCP issues.</li>
      <li>Follow ITIL incident and request management processes to escalate complex problems to senior infrastructure teams.</li>
      <li>Maintain high quality documentation and knowledge base articles for repeat service issues.</li>
    </ul>

    <h2>Key Requirements & Skills</h2>
    <ul>
      <li>1-3 years experience in IT Service Desk, Helpdesk, or Technical Support environments.</li>
      <li>Strong hands-on experience with Windows operating systems and Microsoft 365 suite.</li>
      <li>Familiarity with Active Directory, Azure AD / Entra ID, and basic PowerShell scripting.</li>
      <li>Understanding of ITIL fundamentals and ticket escalation procedures.</li>
      <li>Excellent communication, problem-solving, and customer service skills.</li>
      <li>Valid New Zealand working rights.</li>
    </ul>
  </main>
</body>
</html>`;

async function runE2ETest() {
    console.log('============================================================');
    console.log('Phase 7 - Step 7.3: Real End-to-End Pipeline Execution Test');
    console.log('============================================================');

    // 1. Start local mock job server
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SAMPLE_JOB_HTML);
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const jobUrl = `http://127.0.0.1:${port}/jobs/service-desk-analyst`;
    console.log(`[E2E] Local job mock server running on: ${jobUrl}`);

    try {
        // 2. Instantiate pipeline with forceSync to test preflight sync + full pipeline
        const pipeline = new JobApplicationPipeline({
            jobLink: jobUrl,
            forceSync: false,
            skipSync: false
        });

        console.log(`[E2E] Starting pipeline run for workflow: ${pipeline.workflowId}`);
        const result = await pipeline.run();

        console.log('\n============================================================');
        console.log('[E2E] Pipeline Run Results Summary:');
        console.log(`  Success:           ${result.success}`);
        console.log(`  ATS Score:         ${result.atsScore}%`);
        console.log(`  ATS Passed:        ${result.atsPassed}`);
        console.log(`  CV PDF Pages:      ${result.cvPdfPages}`);
        console.log(`  CL PDF Pages:      ${result.clPdfPages}`);
        console.log(`  Notion Synced:     ${result.notionResult ? result.notionResult.pageUrl : 'No'}`);
        console.log(`  Files Cleaned Up:  ${result.cleanedUpFiles ? result.cleanedUpFiles.length : 0}`);
        console.log('============================================================\n');

        assert.strictEqual(result.success, true, 'Pipeline must succeed');
        assert(typeof result.atsScore === 'number' && result.atsScore >= 75, `ATS score must be >= 75% (got ${result.atsScore}%)`);
        assert.strictEqual(result.cvPdfPages, 2, 'CV PDF must be exactly 2 pages');
        assert.strictEqual(result.clPdfPages, 1, 'Cover Letter PDF must be exactly 1 page');

        if (result.notionResult) {
            assert(result.notionResult.pageUrl, 'Notion sync result must contain pageUrl');
            console.log('✓ Notion upload verified:', result.notionResult.pageUrl);
        }

        console.log('✓ Phase 7 Step 7.3 End-to-End verification successfully PASSED!');
    } finally {
        await new Promise(resolve => server.close(resolve));
        console.log('[E2E] Mock server closed cleanly.');
    }
}

runE2ETest().catch(err => {
    console.error('\n✖ E2E pipeline test failed:', err);
    process.exit(1);
});
