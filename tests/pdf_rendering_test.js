#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Pipeline = require('../job_application_pipeline');

const {
    loadCandidateProfile,
    buildFactualApplicationDocuments,
    generatePdfWithPageCheck,
    cvMarkdownToHtml,
    coverLetterMarkdownToHtml
} = Pipeline._internals;

(async () => {
    const workspaceRoot = path.resolve(__dirname, '..');
    const profile = loadCandidateProfile(workspaceRoot);
    const docs = buildFactualApplicationDocuments({
        profile,
        category: 'serviceDesk',
        companyName: 'Beyond Recruitment',
        jobTitle: 'IT Support Technician',
        jobDescription: 'IT Support Technician test description'
    });

    const tmpDir = path.join(workspaceRoot, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    const tmpCvPdf = path.join(tmpDir, 'test_cv.pdf');
    const tmpClPdf = path.join(tmpDir, 'test_cl.pdf');

    try {
        const cvRes = await generatePdfWithPageCheck(docs.cvMarkdown, tmpCvPdf, 2, cvMarkdownToHtml);
        assert.strictEqual(cvRes.pages, 2, 'CV PDF should be exactly 2 pages');
        assert(fs.existsSync(tmpCvPdf), 'CV PDF file must exist');
        assert(fs.statSync(tmpCvPdf).size > 10000, 'CV PDF should have content');

        const clRes = await generatePdfWithPageCheck(docs.coverLetterMarkdown, tmpClPdf, 1, coverLetterMarkdownToHtml);
        assert.strictEqual(clRes.pages, 1, 'Cover Letter PDF should be exactly 1 page');
        assert(fs.existsSync(tmpClPdf), 'Cover Letter PDF file must exist');
        assert(fs.statSync(tmpClPdf).size > 5000, 'Cover Letter PDF should have content');

        console.log('PDF rendering tests passed (CV: 2 pages, CL: 1 page).');
    } finally {
        if (fs.existsSync(tmpCvPdf)) fs.unlinkSync(tmpCvPdf);
        if (fs.existsSync(tmpClPdf)) fs.unlinkSync(tmpClPdf);
    }
})().catch(err => {
    console.error('PDF rendering test failed:', err);
    process.exit(1);
});
