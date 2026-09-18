#!/usr/bin/env node

const assert = require('assert');
const {
    normalizeId,
    extractNotionId,
    buildDatabaseProperties,
    buildPageBlocks,
    DEFAULT_DATABASE_ID,
} = require('../notion_sync');

// Test 1: ID extraction and normalization
const rawUrl = 'https://app.notion.com/p/26d086ddaa064aa0b51318c8d3e6a84f?v=b1532aba5c004f3ab6622b06e070f8e5';
const extracted = extractNotionId(rawUrl);
assert.strictEqual(extracted, '26d086ddaa064aa0b51318c8d3e6a84f', 'Failed to extract Notion ID from URL');

const formatted = normalizeId(extracted);
assert.strictEqual(formatted, '26d086dd-aa06-4aa0-b513-18c8d3e6a84f', 'Failed to format 32-char ID into UUID');

// Test 2: Database property mapping with various schemas
const mockSchema = {
    'Job Title': { id: 'title_1', type: 'title', title: {} },
    'Company': { id: 'company_1', type: 'rich_text', rich_text: {} },
    'Job URL': { id: 'url_1', type: 'url', url: {} },
    'ATS Score': { id: 'num_1', type: 'number', number: {} },
    'Date Applied': { id: 'date_1', type: 'date', date: {} },
    'Status': { id: 'status_1', type: 'status', status: { options: [{ name: 'Applied' }, { name: 'Interviewing' }] } },
    'CV': { id: 'file_1', type: 'files', files: {} },
    'Cover Letter': { id: 'file_2', type: 'files', files: {} },
};

const mockJobData = {
    jobTitle: 'Cloud Systems Engineer',
    companyName: 'Datacom',
    jobLink: 'https://www.seek.co.nz/job/999999',
    score: 88,
    dateApplied: '2026-09-12',
};

const mockUploadedFiles = {
    cvFile: { name: 'MaghavAhuja_Datacom_CV.pdf', type: 'file_upload', file_upload: { id: 'upload_cv_123' } },
    clFile: { name: 'MaghavAhuja_Datacom_CL.pdf', type: 'file_upload', file_upload: { id: 'upload_cl_456' } },
};

const mappedProps = buildDatabaseProperties(mockSchema, mockJobData, mockUploadedFiles);

assert(mappedProps['Job Title'], 'Missing title property');
assert.strictEqual(mappedProps['Job Title'].title[0].text.content, 'Cloud Systems Engineer');

assert(mappedProps['Company'], 'Missing Company property');
assert.strictEqual(mappedProps['Company'].rich_text[0].text.content, 'Datacom');

assert(mappedProps['Job URL'], 'Missing Job URL property');
assert.strictEqual(mappedProps['Job URL'].url, 'https://www.seek.co.nz/job/999999');

assert(mappedProps['ATS Score'], 'Missing ATS Score property');
assert.strictEqual(mappedProps['ATS Score'].number, 88);

assert(mappedProps['Date Applied'], 'Missing Date Applied property');
assert.strictEqual(mappedProps['Date Applied'].date.start, '2026-09-12');

assert(mappedProps['Status'], 'Missing Status property');
assert.strictEqual(mappedProps['Status'].status.name, 'Applied');

assert(mappedProps['CV'], 'Missing CV property');
assert.strictEqual(mappedProps['CV'].files[0].file_upload.id, 'upload_cv_123');

assert(mappedProps['Cover Letter'], 'Missing Cover Letter property');
assert.strictEqual(mappedProps['Cover Letter'].files[0].file_upload.id, 'upload_cl_456');

// Test 3: Single combined 'Files' property schema
const mockSingleFileSchema = {
    'Name': { id: 't1', type: 'title', title: {} },
    'Employer': { id: 'c1', type: 'select', select: { options: [] } },
    'Attachments': { id: 'f1', type: 'files', files: {} },
    'Score': { id: 's1', type: 'rich_text', rich_text: {} },
};

const mappedSingle = buildDatabaseProperties(mockSingleFileSchema, mockJobData, mockUploadedFiles);
assert.strictEqual(mappedSingle['Employer'].select.name, 'Datacom');
assert.strictEqual(mappedSingle['Attachments'].files.length, 2, 'Attachments should contain both CV and CL');
assert.strictEqual(mappedSingle['Score'].rich_text[0].text.content, '88%');

// Test 4: Block builder
const blocks = buildPageBlocks({
    ...mockJobData,
    coverLetterMarkdown: 'Dear Hiring Manager,\n\nI am writing to apply for the position...',
    jobDescription: 'Seeking an experienced Cloud Engineer for AWS and Linux...',
    cvMarkdown: '# Maghav Ahuja\n\nExperienced Cloud Systems Engineer...',
}, {
    overall_score: 88,
    missing_keywords: ['Terraform', 'Kubernetes'],
    recommendations: ['Highlight cloud automation experience'],
});

assert(blocks.length >= 5, 'Expected page blocks to be generated');
assert.strictEqual(blocks[0].type, 'callout', 'Expected first block to be callout');
assert(blocks.some(b => b.type === 'heading_2' && b.heading_2.rich_text[0].text.content.includes('Cover Letter')), 'Missing Cover Letter heading block');
assert(blocks.some(b => b.type === 'heading_2' && b.heading_2.rich_text[0].text.content.includes('ATS Keyword')), 'Missing ATS Analysis heading block');

// Test 5: User's exact database schema
const mockUserSchema = {
    'Company': { id: 'title', type: 'title', title: {} },
    'Position': { id: 'pos_1', type: 'rich_text', rich_text: {} },
    'Job URL': { id: 'url_1', type: 'url', url: {} },
    'Date Applied': { id: 'd1', type: 'date', date: {} },
    'Follow-up Date': { id: 'd2', type: 'date', date: {} },
    'Status': { id: 's1', type: 'select', select: { options: [{ name: 'Applied' }] } },
    'CV': { id: 'f1', type: 'files', files: {} },
    'CL': { id: 'f2', type: 'files', files: {} },
    'Contact': { id: 'r1', type: 'rich_text', rich_text: {} },
    'Salary Range': { id: 'r2', type: 'rich_text', rich_text: {} },
};

const mockUserJobData = {
    jobTitle: 'Systems Administrator',
    companyName: 'NZX',
    jobLink: 'https://new.nzx.com/careers/job=924277',
    score: 85,
    dateApplied: '2026-09-12',
    jobDescription: 'Join NZX as Systems Administrator. Salary $110,000 - $130,000 per annum. Contact recruitment@nzx.com for info.',
};

const mappedUserProps = buildDatabaseProperties(mockUserSchema, mockUserJobData, mockUploadedFiles);

assert.strictEqual(mappedUserProps['Company'].title[0].text.content, 'NZX');
assert.strictEqual(mappedUserProps['Position'].rich_text[0].text.content, 'Systems Administrator');
assert.strictEqual(mappedUserProps['Job URL'].url, 'https://new.nzx.com/careers/job=924277');
assert.strictEqual(mappedUserProps['Date Applied'].date.start, '2026-09-12');
assert.strictEqual(mappedUserProps['Status'].select.name, 'Applied');
assert.strictEqual(mappedUserProps['CV'].files[0].file_upload.id, 'upload_cv_123');
assert.strictEqual(mappedUserProps['CL'].files[0].file_upload.id, 'upload_cl_456');
assert.strictEqual(mappedUserProps['Contact'].rich_text[0].text.content, 'recruitment@nzx.com');
assert(mappedUserProps['Salary Range'].rich_text[0].text.content.includes('$110,000'), 'Failed to extract salary');

// Test 6: Output cleanup functionality and security guard
const fs = require('fs');
const path = require('path');
const { cleanupOutputFiles } = require('../notion_sync');

const testOutputDir = path.join(__dirname, 'tmp_output_test');
if (!fs.existsSync(testOutputDir)) fs.mkdirSync(testOutputDir, { recursive: true });

const dummyFiles = [
    path.join(testOutputDir, 'MaghavAhuja_TestCorp_CV.pdf'),
    path.join(testOutputDir, 'MaghavAhuja_TestCorp_CL.pdf'),
    path.join(testOutputDir, 'MaghavAhuja_TestCorp_CV.md'),
    path.join(testOutputDir, 'MaghavAhuja_TestCorp_CL.md'),
    path.join(testOutputDir, 'MaghavAhuja_TestCorp_CV_20260918.pdf'),
    path.join(testOutputDir, 'job_description.txt'),
    path.join(testOutputDir, 'job_meta.json'),
    path.join(testOutputDir, 'ats_result.json'),
    path.join(testOutputDir, 'optimized_cv.md'),
    path.join(testOutputDir, 'Cover_Letter.pdf'),
];

for (const fp of dummyFiles) {
    fs.writeFileSync(fp, 'test-content');
}

// File outside the test output dir should NEVER be deleted
const outsideFile = path.join(__dirname, 'tmp_safe.txt');
fs.writeFileSync(outsideFile, 'safe-content');

const cleaned = cleanupOutputFiles(
    testOutputDir,
    [outsideFile, path.join(testOutputDir, 'job_meta.json')],
    ['MaghavAhuja_TestCorp_CV', 'MaghavAhuja_TestCorp_CL']
);

assert(fs.existsSync(outsideFile), 'Security failure: file outside output directory was deleted!');
for (const fp of dummyFiles) {
    assert(!fs.existsSync(fp), `Failed to delete workflow output file: ${path.basename(fp)}`);
}
assert(cleaned.length >= dummyFiles.length, `Expected at least ${dummyFiles.length} files cleaned`);

// Clean up outsideFile and testOutputDir
try { fs.unlinkSync(outsideFile); } catch (_) {}
try { fs.rmdirSync(testOutputDir); } catch (_) {}

console.log('All notion_sync unit tests passed successfully!');

