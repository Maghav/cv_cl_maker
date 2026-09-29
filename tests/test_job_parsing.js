#!/usr/bin/env node
/**
 * Job-board URL parsing tests — pure logic only (no Puppeteer, no network).
 * Run: node tests/test_job_parsing.js
 */

const assert = require('assert');
const { parseBambooHrUrl, parseWorkdayUrl } = require('../job_application_pipeline')._internals;

let count = 0;
function check(name, fn) {
    count++;
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (e) {
        console.error(`\n FAILED ${name}: ${e.message}`);
        process.exit(1);
    }
}

console.log('parseBambooHrUrl');
check('tenant careers URL with query string parses (real failing case)', () => {
    const p = parseBambooHrUrl('https://chapmantripp.bamboohr.com/careers/543?seek-token=ENGwjMtseE6euwBVawveKB');
    assert.ok(p, 'expected a parse result');
    assert.strictEqual(p.company, 'chapmantripp');
    assert.strictEqual(p.jobId, '543');
    assert.strictEqual(p.detailUrl, 'https://chapmantripp.bamboohr.com/careers/543/detail');
    assert.strictEqual(p.companyInfoUrl, 'https://chapmantripp.bamboohr.com/careers/company-info');
});
check('plain tenant careers URL parses', () => {
    const p = parseBambooHrUrl('https://acme.bamboohr.com/careers/123');
    assert.strictEqual(p.company, 'acme');
    assert.strictEqual(p.jobId, '123');
});
check('bare bamboohr.com without tenant subdomain is rejected', () => {
    assert.strictEqual(parseBambooHrUrl('https://bamboohr.com/careers/123'), null);
});
check('non-bamboohr host is rejected', () => {
    assert.strictEqual(parseBambooHrUrl('https://example.com/careers/543'), null);
});
check('lookalike host (notbamboohr.com) is rejected', () => {
    assert.strictEqual(parseBambooHrUrl('https://notbamboohr.com/careers/543'), null);
});
check('tenant page without a numeric job id is rejected', () => {
    assert.strictEqual(parseBambooHrUrl('https://acme.bamboohr.com/careers'), null);
    assert.strictEqual(parseBambooHrUrl('https://acme.bamboohr.com/jobs/543'), null);
});
check('invalid URL is rejected without throwing', () => {
    assert.strictEqual(parseBambooHrUrl('not a url'), null);
});

console.log('parseWorkdayUrl (regression)');
check('myworkdayjobs URL parses to tenant/site/slug', () => {
    const p = parseWorkdayUrl('https://wework.wd1.myworkdayjobs.com/en-US/WExternalSite/job/Software-Engineer_R12345');
    assert.ok(p);
    assert.strictEqual(p.tenant, 'wework');
    assert.strictEqual(p.site, 'WExternalSite');
    assert.strictEqual(p.slug, 'Software-Engineer_R12345');
    assert.ok(p.apiUrl.includes('/wday/cxs/wework/WExternalSite/job/Software-Engineer_R12345'));
});
check('non-workday URL is rejected', () => {
    assert.strictEqual(parseWorkdayUrl('https://boards.greenhouse.io/acme/jobs/1'), null);
    assert.strictEqual(parseWorkdayUrl('not a url'), null);
});

console.log(`\nAll ${count} job parsing checks passed.`);
