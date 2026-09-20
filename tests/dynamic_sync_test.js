#!/usr/bin/env node

/**
 * tests/dynamic_sync_test.js
 * Automated Dynamic CV Pipeline - Phase 1 Test Suite
 *
 * Covers:
 * 1. Live portfolio extraction against https://portfolio.onl9.club
 * 2. Cloudflare email XOR decoder
 * 3. Date range normalization and HTML comment sanitization
 * 4. Cache management and TTL verification
 * 5. Resilient offline fallback behavior
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
    scrapePortfolio,
    decodeCloudflareEmail,
    normalizeDateRange,
    cleanText,
    isCacheValid,
    loadPortfolioCache,
    savePortfolioCache,
    getEmergencyFallbackProfile
} = require('../portfolio_scraper');

const {
    parseCvPdf,
    parseAllCvs,
    computeFileHash,
    DEFAULT_MY_CVS_DIR,
    DEFAULT_MANIFEST_NAME
} = require('../cv_parser');

const {
    aggregateProfiles,
    mergeProfiles,
    deduplicateBullets,
    scoreBulletMetrics,
    calculateBulletSimilarity,
    generateTags,
    mergeSkills,
    canonicalizeEmployer,
    canonicalizeProject,
    canonicalizeInstitution,
    canonicalizeVolunteer,
    backupProfile,
    saveAggregatedProfile,
    DEFAULT_PROFILE_PATH,
    DEFAULT_BACKUP_PATH
} = require('../profile_aggregator');

const Pipeline = require('../job_application_pipeline');
const {
    buildFactualApplicationDocuments,
    validateCVIntegrity,
    containsEntity,
    formatVerifiedEmployers,
    formatVerifiedProjects,
    formatVerifiedEducation,
    formatVerifiedVolunteer,
    getEmployerNamesSummary,
    getProjectNamesSummary,
    getEducationNamesSummary,
    getVolunteerNamesSummary,
    loadCandidateProfile
} = Pipeline._internals;

async function runTests() {
    console.log('=== Dynamic CV Pipeline: Phase 1 Test Suite ===\n');

    // -------------------------------------------------------------
    // Test 1: Cloudflare Email XOR Decoding
    // -------------------------------------------------------------
    console.log('Test 1: Cloudflare email decoder...');
    {
        // Vector from live site: data-cfemail="bdd0dcdad5dccbdcd5c8d7dc8d8cfddad0dcd4d193ded2d0"
        const cfVector1 = 'bdd0dcdad5dccbdcd5c8d7dc8d8cfddad0dcd4d193ded2d0';
        const decoded1 = decodeCloudflareEmail(cfVector1);
        assert.strictEqual(decoded1, 'maghavahuja01@gmail.com', 'CF vector 1 should decode to maghavahuja01@gmail.com');

        // URL format: /cdn-cgi/l/email-protection#92fff3f5faf3e4f3fae7f8f3a2a3d2f5fff3fbfebcf1fdff
        const cfVector2 = '/cdn-cgi/l/email-protection#92fff3f5faf3e4f3fae7f8f3a2a3d2f5fff3fbfebcf1fdff';
        const decoded2 = decodeCloudflareEmail(cfVector2);
        assert.strictEqual(decoded2, 'maghavahuja01@gmail.com', 'CF vector 2 should decode to maghavahuja01@gmail.com');

        // Invalid inputs
        assert.strictEqual(decodeCloudflareEmail(''), null, 'Empty string should return null');
        assert.strictEqual(decodeCloudflareEmail('invalid_hex_string'), null, 'Non-hex string should return null');
        assert.strictEqual(decodeCloudflareEmail(null), null, 'Null should return null');
    }
    console.log('✓ Cloudflare email decoding passed.\n');

    // -------------------------------------------------------------
    // Test 2: Date Normalization and Sanitization
    // -------------------------------------------------------------
    console.log('Test 2: Date normalization & sanitization...');
    {
        // En-dash with Present
        const d1 = normalizeDateRange('August 2025 – Present');
        assert.strictEqual(d1.start, 'August 2025');
        assert.strictEqual(d1.end, 'Present');
        assert.strictEqual(d1.isCurrent, true);
        assert.strictEqual(d1.formatted, 'August 2025 – Present');

        // HTML comments and spaces
        const d2 = normalizeDateRange('August 2025<!-- --> – <!-- -->Present');
        assert.strictEqual(d2.start, 'August 2025');
        assert.strictEqual(d2.end, 'Present');
        assert.strictEqual(d2.isCurrent, true);

        // Standard range
        const d3 = normalizeDateRange('Feb 2023 – July 2024');
        assert.strictEqual(d3.start, 'Feb 2023');
        assert.strictEqual(d3.end, 'July 2024');
        assert.strictEqual(d3.isCurrent, false);

        // Year only range
        const d4 = normalizeDateRange('2019 – 2022');
        assert.strictEqual(d4.start, '2019');
        assert.strictEqual(d4.end, '2022');
        assert.strictEqual(d4.isCurrent, false);

        // Single date or ongoing
        const d5 = normalizeDateRange('Current');
        assert.strictEqual(d5.isCurrent, true);
        assert.strictEqual(d5.end, 'Present');

        // Text cleaner
        assert.strictEqual(cleanText('Hello <!-- comment --> world! \n \r '), 'Hello world!');
    }
    console.log('✓ Date normalization passed.\n');

    // -------------------------------------------------------------
    // Test 3: Local Caching & TTL Management
    // -------------------------------------------------------------
    console.log('Test 3: Local caching & TTL management...');
    {
        const testCachePath = path.resolve(__dirname, 'test_portfolio_cache.json');
        try {
            if (fs.existsSync(testCachePath)) fs.unlinkSync(testCachePath);

            // Initially not valid
            assert.strictEqual(isCacheValid(testCachePath, 24), false);

            // Save test data
            const mockData = { header: { name: 'Test Candidate' }, experience: [] };
            const saved = savePortfolioCache(testCachePath, mockData, 'https://test.url');
            assert.strictEqual(saved, true, 'Cache should save successfully');

            // Should be valid with 24h TTL
            assert.strictEqual(isCacheValid(testCachePath, 24), true, 'Cache should be valid within 24h');

            // Should NOT be valid with 0h TTL
            assert.strictEqual(isCacheValid(testCachePath, 0), false, 'Cache should expire with 0h TTL');

            // Read test data
            const loaded = loadPortfolioCache(testCachePath);
            assert.strictEqual(loaded.data.header.name, 'Test Candidate');
            assert.strictEqual(loaded.url, 'https://test.url');
        } finally {
            if (fs.existsSync(testCachePath)) fs.unlinkSync(testCachePath);
        }
    }
    console.log('✓ Local cache & TTL management passed.\n');

    // -------------------------------------------------------------
    // Test 4: Live Portfolio Scraping & Extraction
    // -------------------------------------------------------------
    console.log('Test 4: Live portfolio scraping and extraction...');
    {
        const profile = await scrapePortfolio({
            url: 'https://portfolio.onl9.club',
            forceRefresh: false
        });

        assert(profile, 'Scraped profile should not be null');

        // Header
        assert.strictEqual(profile.header.name, 'MAGHAV AHUJA', 'Name mismatch');
        assert(profile.header.title.includes('DevOps'), 'Title should include DevOps');
        assert(profile.header.email.includes('@'), `Email should be valid: ${profile.header.email}`);
        assert(profile.header.phone.includes('+64'), `Phone should include +64: ${profile.header.phone}`);
        assert(profile.header.location.includes('Auckland'), 'Location should include Auckland');
        assert(profile.header.linkedin.includes('linkedin.com/in/maghavahuja'), 'LinkedIn mismatch');
        assert(profile.header.github.includes('github.com/Maghav'), 'GitHub mismatch');
        assert(profile.header.about.length > 20, 'About text should not be empty');

        // Work Experience
        assert(Array.isArray(profile.experience), 'Experience must be an array');
        assert(profile.experience.length >= 4, `Expected at least 4 experiences, got ${profile.experience.length}`);

        const employers = profile.experience.map(e => e.employer);
        assert(employers.includes('Neurix Limited'), 'Should extract Neurix Limited');
        assert(employers.includes('Mitre10 MEGA'), 'Should extract Mitre10 MEGA');
        assert(employers.includes('Datacom'), 'Should extract Datacom');
        assert(employers.includes('Woolworths New Zealand'), 'Should extract Woolworths New Zealand');

        // Check date normalization in experience
        const neurix = profile.experience.find(e => e.employer === 'Neurix Limited');
        assert(neurix.dateDetails.isCurrent, 'Neurix should be current position');
        assert(neurix.responsibilities.length > 50, 'Neurix responsibilities should be populated');

        // Education
        assert(Array.isArray(profile.education), 'Education must be an array');
        assert(profile.education.length >= 2, `Expected at least 2 education entries, got ${profile.education.length}`);
        const institutions = profile.education.map(e => e.institution);
        assert(institutions.some(i => i.includes('Unitec')), 'Should extract Unitec');
        assert(institutions.some(i => i.includes('Maharaja Surajmal')), 'Should extract Maharaja Surajmal');

        // Skills (All 8 categories)
        assert(profile.skills && profile.skills.categories, 'Skills categories must exist');
        const categories = Object.keys(profile.skills.categories).map(c => c.toUpperCase());
        assert(categories.some(c => c.includes('INFRASTRUCTURE')), 'Missing Infrastructure category');
        assert(categories.some(c => c.includes('AUTOMATION')), 'Missing Automation category');
        assert(categories.some(c => c.includes('CI/CD')), 'Missing CI/CD category');
        assert(categories.some(c => c.includes('CONTAINERS')), 'Missing Containers category');
        assert(categories.some(c => c.includes('MONITORING')), 'Missing Monitoring category');
        assert(categories.some(c => c.includes('SECURITY')), 'Missing Security category');
        assert(categories.some(c => c.includes('AI')), 'Missing AI category');
        assert(categories.some(c => c.includes('OTHER')), 'Missing Other category');
        assert(profile.skills.allSkills.length >= 40, `Expected 40+ total skills, got ${profile.skills.allSkills.length}`);

        // Learning Labs
        assert(Array.isArray(profile.learningLabs), 'Learning labs must be an array');
        assert(profile.learningLabs.length >= 3, `Expected at least 3 labs, got ${profile.learningLabs.length}`);
        const labNames = profile.learningLabs.map(l => l.name);
        assert(labNames.some(n => n.includes('SadServers')), 'Missing SadServers lab');
        assert(labNames.some(n => n.includes('KodeKloud')), 'Missing KodeKloud lab');
        assert(labNames.some(n => n.includes('Iximuiuz') || n.includes('Iximiuz')), 'Missing Iximiuz lab');
        assert(profile.learningLabs.every(l => l.url && l.url.startsWith('http')), 'All labs must have valid URLs');

        // Projects
        assert(Array.isArray(profile.projects), 'Projects must be an array');
        assert(profile.projects.length >= 5, `Expected at least 5 projects, got ${profile.projects.length}`);
        const projNames = profile.projects.map(p => p.name);
        assert(projNames.some(n => n.includes('Portfolio')), 'Missing Portfolio project');
        assert(projNames.some(n => n.includes('Physics')), 'Missing Learning Physics project');
        assert(projNames.some(n => n.includes('Toolkit')), 'Missing Toolkit project');
        assert(projNames.some(n => n.includes('Pipeline')), 'Missing Job Apply Pipeline project');
        assert(projNames.some(n => n.includes('Club')), 'Missing ONL9 Club project');
        assert(profile.projects.every(p => p.url && p.url.startsWith('http')), 'All projects must have valid URLs');
    }
    console.log('✓ Live portfolio extraction passed.\n');

    // -------------------------------------------------------------
    // Test 5: Resilient Local Caching & Offline Fallback
    // -------------------------------------------------------------
    console.log('Test 5: Resilient offline fallback...');
    {
        // 5a. Fallback to existing cache when network is unreachable
        const fallbackRes = await scrapePortfolio({
            url: 'https://invalid-non-existent-domain-12345.xyz',
            forceRefresh: true,
            timeoutMs: 3000
        });
        assert.strictEqual(fallbackRes.fromCache, true, 'Should fall back to cache when domain is unreachable');
        assert(fallbackRes.warning && fallbackRes.warning.includes('Fell back to cache'), 'Warning should be recorded');
        assert.strictEqual(fallbackRes.header.name, 'MAGHAV AHUJA', 'Should retain valid candidate profile');

        // 5b. Emergency fallback when offline and no cache exists
        const dummyCachePath = path.resolve(__dirname, 'non_existent_cache.json');
        const emergencyRes = await scrapePortfolio({
            cachePath: dummyCachePath,
            offlineOnly: true
        });
        assert.strictEqual(emergencyRes.isFallback, true, 'Should report isFallback=true');
        assert.strictEqual(emergencyRes.header.name, 'MAGHAV AHUJA', 'Should fall back to candidate_profile.json');
    }
    console.log('✓ Resilient offline fallback passed.\n');

    // -------------------------------------------------------------
    // Test 6: Dynamic PDF Discovery & SHA-256 Hashing (Step 2.1)
    // -------------------------------------------------------------
    console.log('Test 6: Dynamic PDF discovery & SHA-256 hashing...');
    {
        const testManifestPath = path.resolve(__dirname, 'test_cv_manifest.json');
        try {
            if (fs.existsSync(testManifestPath)) fs.unlinkSync(testManifestPath);

            // First run: parse all files and write manifest
            const parseResult1 = await parseAllCvs(DEFAULT_MY_CVS_DIR, {
                force: true,
                manifestPath: testManifestPath
            });

            assert.strictEqual(parseResult1.totalFiles >= 2, true, 'Should find at least 2 PDFs in my_cvs/');
            assert.strictEqual(parseResult1.filesParsed >= 2, true, 'Initial run should parse all PDFs');
            assert.strictEqual(parseResult1.fromManifest, 0, 'Initial run should not have cached entries');
            assert(fs.existsSync(testManifestPath), 'Manifest file must be created');

            const manifest = JSON.parse(fs.readFileSync(testManifestPath, 'utf8'));
            assert(manifest.files['cv_linux_devops.pdf'], 'Manifest should track cv_linux_devops.pdf');
            assert(manifest.files['cv_support_infrastructure.pdf'], 'Manifest should track cv_support_infrastructure.pdf');

            const devopsHash = manifest.files['cv_linux_devops.pdf'].sha256;
            assert.strictEqual(typeof devopsHash, 'string');
            assert.strictEqual(devopsHash.length, 64, 'SHA-256 must be 64-char hex string');

            // Verify computeFileHash matches
            const directHash = computeFileHash(path.join(DEFAULT_MY_CVS_DIR, 'cv_linux_devops.pdf'));
            assert.strictEqual(devopsHash, directHash, 'Manifest hash must match computeFileHash output');

            // Second run: should load 100% from manifest cache without re-parsing
            const parseResult2 = await parseAllCvs(DEFAULT_MY_CVS_DIR, {
                force: false,
                manifestPath: testManifestPath
            });

            assert.strictEqual(parseResult2.filesParsed, 0, 'Second run should parse 0 files');
            assert.strictEqual(parseResult2.fromManifest >= 2, true, 'Second run should load all files from manifest cache');
        } finally {
            if (fs.existsSync(testManifestPath)) fs.unlinkSync(testManifestPath);
        }
    }
    console.log('✓ Dynamic PDF discovery & SHA-256 hashing passed.\n');

    // -------------------------------------------------------------
    // Test 7: Sectional & Semantic Entity Extraction (Step 2.2)
    // -------------------------------------------------------------
    console.log('Test 7: Sectional & semantic entity extraction across varied CVs...');
    {
        const parseResult = await parseAllCvs(DEFAULT_MY_CVS_DIR, { force: false });
        const devopsCv = parseResult.cvs.find(c => c.sourceFile === 'cv_linux_devops.pdf');
        const supportCv = parseResult.cvs.find(c => c.sourceFile === 'cv_support_infrastructure.pdf');

        assert(devopsCv, 'Must parse cv_linux_devops.pdf');
        assert(supportCv, 'Must parse cv_support_infrastructure.pdf');

        // Verify Contact & Header
        assert.strictEqual(devopsCv.contact.name, 'MAGHAV AHUJA');
        assert(devopsCv.contact.email.includes('maghavahuja01@gmail.com'));
        assert(devopsCv.contact.phone.includes('+64 228 079079'));
        assert(devopsCv.contact.linkedin.includes('linkedin.com/in/maghavahuja'));
        assert(devopsCv.contact.github.includes('github.com/maghavahuja'));
        assert(devopsCv.contact.workingRights.includes('2027'));

        // Verify Summaries
        assert(devopsCv.summary.includes('DevOps'), 'DevOps summary must mention DevOps');
        assert(devopsCv.summary.length > 100, 'DevOps summary should be detailed');
        assert(supportCv.summary.length > 50, 'Support summary should be non-empty');

        // Verify Experience coverage
        const devopsEmployers = devopsCv.experience.map(e => e.employer);
        assert(devopsEmployers.includes('Neurix Limited'), 'DevOps CV must include Neurix Limited');
        assert(devopsEmployers.includes('Datacom NZ'), 'DevOps CV must include Datacom NZ');
        assert(devopsEmployers.includes('Mitre10 MEGA'), 'DevOps CV must include Mitre10 MEGA');

        const supportEmployers = supportCv.experience.map(e => e.employer);
        assert(supportEmployers.includes('Neurix Limited'), 'Support CV must include Neurix Limited');
        assert(supportEmployers.includes('Datacom NZ'), 'Support CV must include Datacom NZ');
        assert(supportEmployers.includes('Department of Education, Government of Delhi'), 'Support CV must capture Department of Education');
        assert(supportEmployers.includes('Mitre10 MEGA'), 'Support CV must include Mitre10 MEGA');

        // Verify Education
        assert(devopsCv.education.length >= 2, 'DevOps CV must extract 2 education credentials');
        assert(supportCv.education.length >= 2, 'Support CV must extract 2 education credentials');
        assert(devopsCv.education.some(e => e.institution.includes('Unitec')), 'Must extract Unitec');
        assert(devopsCv.education.some(e => e.institution.includes('Maharaja Surajmal')), 'Must extract Maharaja Surajmal');

        // Verify Projects
        assert(devopsCv.projects.length >= 3, 'DevOps CV must extract at least 3 project groups');
        assert(supportCv.projects.length >= 4, 'Support CV must extract at least 4 project groups');

        // Verify Skills
        assert(devopsCv.skills.allSkills.length >= 25, 'DevOps CV must extract 25+ skills');
        assert(supportCv.skills.allSkills.length >= 20, 'Support CV must extract 20+ skills');
    }
    console.log('✓ Sectional & semantic entity extraction passed.\n');

    // -------------------------------------------------------------
    // Test 8: Source Traceability & Granular Tagging (Step 2.3)
    // -------------------------------------------------------------
    console.log('Test 8: Source traceability & granular bullet tagging...');
    {
        const parseResult = await parseAllCvs(DEFAULT_MY_CVS_DIR, { force: false });

        for (const cv of parseResult.cvs) {
            // Verify experience bullets
            for (const exp of cv.experience) {
                assert.strictEqual(exp.sourceFile, cv.sourceFile, `Experience employer ${exp.employer} sourceFile mismatch`);
                assert.strictEqual(exp.sourceHash, cv.sourceHash, `Experience employer ${exp.employer} sourceHash mismatch`);
                assert(exp.bullets.length > 0, `Employer ${exp.employer} should have bullets`);

                for (const b of exp.bullets) {
                    assert.strictEqual(b.sourceFile, cv.sourceFile, `Bullet sourceFile mismatch: ${b.text.substring(0, 30)}`);
                    assert.strictEqual(b.sourceHash, cv.sourceHash, `Bullet sourceHash mismatch: ${b.text.substring(0, 30)}`);
                    assert(b.text.length > 10, `Bullet text too short: ${b.text}`);
                }
            }

            // Verify project bullets
            for (const proj of cv.projects) {
                assert.strictEqual(proj.sourceFile, cv.sourceFile, `Project ${proj.name} sourceFile mismatch`);
                for (const b of proj.bullets) {
                    assert.strictEqual(b.sourceFile, cv.sourceFile, `Project bullet sourceFile mismatch`);
                    assert.strictEqual(b.sourceHash, cv.sourceHash, `Project bullet sourceHash mismatch`);
                }
            }

            // Verify education bullets
            for (const edu of cv.education) {
                assert.strictEqual(edu.sourceFile, cv.sourceFile, `Education ${edu.institution} sourceFile mismatch`);
                for (const b of edu.bullets) {
                    assert.strictEqual(b.sourceFile, cv.sourceFile, `Education bullet sourceFile mismatch`);
                    assert.strictEqual(b.sourceHash, cv.sourceHash, `Education bullet sourceHash mismatch`);
                }
            }
        }
    }
    console.log('✓ Source traceability & granular bullet tagging passed.\n');

    // -------------------------------------------------------------
    // Test 9: Company & Entity Alias Mapping (Step 3.1)
    // -------------------------------------------------------------
    console.log('Test 9: Company & entity alias mapping...');
    {
        // Employers
        assert.strictEqual(canonicalizeEmployer('Datacom'), 'Datacom NZ');
        assert.strictEqual(canonicalizeEmployer('Datacom NZ'), 'Datacom NZ');
        assert.strictEqual(canonicalizeEmployer('Neurix'), 'Neurix Limited');
        assert.strictEqual(canonicalizeEmployer('Neurix Limited'), 'Neurix Limited');
        assert.strictEqual(canonicalizeEmployer('Mitre10'), 'Mitre10 MEGA');
        assert.strictEqual(canonicalizeEmployer('Mitre 10 MEGA'), 'Mitre10 MEGA');
        assert.strictEqual(canonicalizeEmployer('Department of Education'), 'Department of Education, Government of Delhi');
        assert.strictEqual(canonicalizeEmployer('Department of Education, Government of Delhi'), 'Department of Education, Government of Delhi');
        assert.strictEqual(canonicalizeEmployer('Woolworths'), 'Woolworths New Zealand');
        assert.strictEqual(canonicalizeEmployer('Woolworths NZ'), 'Woolworths New Zealand');

        // Projects
        assert.strictEqual(canonicalizeProject('Cloud Deployment & Infrastructure Automation'), 'Cloud Application Deployment');
        assert.strictEqual(canonicalizeProject('Deployment Projects'), 'Cloud Application Deployment');
        assert.strictEqual(canonicalizeProject('VPS Server Testing & Deployment – Self-Led Technical Practice'), 'VPS, Hosting & Recovery Lab');
        assert.strictEqual(canonicalizeProject('Infrastructure, Package Building & Disaster Recovery'), 'VPS, Hosting & Recovery Lab');
        assert.strictEqual(canonicalizeProject('NextCloud - Microsoft 365 Alternative On Premises'), 'Nextcloud & Systems Learning Lab');
        assert.strictEqual(canonicalizeProject('Continuous Linux & DevOps Programming Practice'), 'Nextcloud & Systems Learning Lab');
        assert.strictEqual(canonicalizeProject('Self Learning Platforms'), 'Nextcloud & Systems Learning Lab');

        // Education
        assert.strictEqual(canonicalizeInstitution('Unitec'), 'Unitec Institute of Technology');
        assert.strictEqual(canonicalizeInstitution('Unitec Institute of Technology'), 'Unitec Institute of Technology');
        assert.strictEqual(canonicalizeInstitution('Maharaja Surajmal'), 'Maharaja Surajmal Institute');

        // Volunteer
        assert.strictEqual(canonicalizeVolunteer('FreeCodeCamp'), 'FreeCodeCamp.org');
        assert.strictEqual(canonicalizeVolunteer('Shoutcoder'), 'Shoutcoder.com');
    }
    console.log('✓ Company & entity alias mapping passed.\n');

    // -------------------------------------------------------------
    // Test 10: Metric-Driven Bullet Scoring & Deduplication (Step 3.1)
    // -------------------------------------------------------------
    console.log('Test 10: Metric-driven bullet scoring & deduplication...');
    {
        const genericBullet = 'Administer Linux servers with Ansible configuration management across the fleet.';
        const metricBullet = 'Administer 15+ Ubuntu and CentOS/RHEL servers with Ansible, applying consistent configuration and reducing operational overhead by 40%.';

        const genericScore = scoreBulletMetrics(genericBullet);
        const metricScore = scoreBulletMetrics(metricBullet);
        assert(metricScore > genericScore, `Metric-rich bullet score (${metricScore}) must exceed generic bullet score (${genericScore})`);

        // Test similarity detection
        const sim = calculateBulletSimilarity(genericBullet, metricBullet);
        assert(sim >= 0.45, `Similar bullets must have similarity >= 0.45 (got ${sim})`);

        const unrelated = 'Deliver on-site customer service and safety walk-throughs in retail store.';
        const simUnrelated = calculateBulletSimilarity(genericBullet, unrelated);
        assert(simUnrelated < 0.20, `Unrelated bullets must have low similarity (got ${simUnrelated})`);

        // Test deduplication
        const rawBullets = [
            { text: genericBullet, tags: ['linux', 'ansible'], sourceFile: 'cv_support_infrastructure.pdf', sourceHash: 'hash1' },
            { text: metricBullet, tags: ['ubuntu', 'centos', 'ansible', 'automation'], sourceFile: 'cv_linux_devops.pdf', sourceHash: 'hash2' }
        ];

        const deduped = deduplicateBullets(rawBullets);
        assert.strictEqual(deduped.length, 1, 'Two duplicate bullets should be merged into 1');
        assert.strictEqual(deduped[0].text, metricBullet, 'Higher metric variant should be retained');
        assert(deduped[0].tags.includes('linux'), 'Merged tags must include linux');
        assert(deduped[0].tags.includes('ubuntu'), 'Merged tags must include ubuntu');
        assert(deduped[0].tags.includes('automation'), 'Merged tags must include automation');
        assert.strictEqual(deduped[0].sources.length, 2, 'Merged bullet should record both provenance sources');
    }
    console.log('✓ Metric-driven bullet scoring & deduplication passed.\n');

    // -------------------------------------------------------------
    // Test 11: Dynamic Keyword & Tag Indexing (Step 3.2)
    // -------------------------------------------------------------
    console.log('Test 11: Dynamic keyword & tag indexing...');
    {
        const sampleText = 'Configured Terraform and Ansible pipelines for Azure Kubernetes Service and AWS EC2 with Zabbix and Prometheus monitoring.';
        const tags = generateTags(sampleText, ['custom-tag']);

        assert(tags.includes('terraform'), 'Must detect terraform');
        assert(tags.includes('ansible'), 'Must detect ansible');
        assert(tags.includes('azure'), 'Must detect azure');
        assert(tags.includes('aws'), 'Must detect aws');
        assert(tags.includes('kubernetes'), 'Must detect kubernetes');
        assert(tags.includes('zabbix'), 'Must detect zabbix');
        assert(tags.includes('prometheus'), 'Must detect prometheus');
        assert(tags.includes('custom-tag'), 'Must preserve existing custom-tag');

        // Skills unioning
        const sampleSkills = [
            { category: 'DevOps & Configuration', text: 'Docker, CI/CD', tags: ['docker', 'ci/cd'] }
        ];
        const portfolioCats = {
            'IaC': ['Terraform', 'Ansible'],
            'Containers': ['Kubernetes', 'Docker']
        };
        const cvSkillsList = [
            { categories: { 'CI/CD & Build': ['Jenkins', 'Azure DevOps'] } }
        ];
        const merged = mergeSkills(sampleSkills, portfolioCats, cvSkillsList);
        const devopsCat = merged.find(c => c.category === 'DevOps & Configuration');
        assert(devopsCat, 'Must find DevOps & Configuration category');
        assert(devopsCat.tags.includes('terraform'), 'DevOps category must include terraform tag');
        assert(devopsCat.tags.includes('docker'), 'DevOps category must include docker tag');
        assert(devopsCat.tags.includes('kubernetes'), 'DevOps category must include kubernetes tag');
    }
    console.log('✓ Dynamic keyword & tag indexing passed.\n');

    // -------------------------------------------------------------
    // Test 12: 3-Way Profile Aggregation, Safe Persistence & Backup (Step 3.3)
    // -------------------------------------------------------------
    console.log('Test 12: 3-way profile aggregation, safe persistence & backup...');
    {
        const res = await aggregateProfiles({ offline: true });
        const p = res.profile;

        // Verify Schema Integrity
        assert.strictEqual(p.name, 'MAGHAV AHUJA');
        assert(p.contact.email.includes('maghavahuja01@gmail.com'));
        assert(p.workingRights.includes('2027'));
        assert.strictEqual(p.experience.length, 4, 'Must have 4 canonical primary employers');
        assert.strictEqual(p.projects.length, 3, 'Must have 3 canonical project groups');
        assert.strictEqual(p.skills.length, 10, 'Must have 10 canonical skill categories');
        assert(p.education.length >= 2, 'Must have at least 2 education credentials');
        assert(p.volunteer.length >= 2, 'Must have at least 2 volunteer entries');

        // Pipeline Compatibility & Integrity Check
        const docs = buildFactualApplicationDocuments({
            profile: p,
            category: 'serviceDesk',
            companyName: 'Beyond Recruitment',
            jobTitle: 'IT Support Technician',
            jobDescription: 'L1/L2 IT Support Technician role with Windows, Active Directory, Office 365, and troubleshooting.'
        });

        const wordCount = docs.cvMarkdown.trim().split(/\s+/).length;
        assert(wordCount >= 750 && wordCount <= 1200, `Aggregated CV word count (${wordCount}) must be within [750, 1200]`);

        const integrity = validateCVIntegrity(docs.cvMarkdown, p);
        assert.deepStrictEqual(integrity.issues, [], `Integrity issues found on aggregated profile: ${integrity.issues.join('; ')}`);

        // Test Backup & Persistence Safety
        const tmpProfilePath = path.resolve(__dirname, '..', 'tmp', 'test_candidate_profile.json');
        const tmpBackupPath = path.resolve(__dirname, '..', 'tmp', 'test_candidate_profile.backup.json');
        if (!fs.existsSync(path.dirname(tmpProfilePath))) fs.mkdirSync(path.dirname(tmpProfilePath));

        // Write initial file
        fs.writeFileSync(tmpProfilePath, JSON.stringify({ name: 'OLD' }), 'utf8');

        // Perform save with automated backup
        saveAggregatedProfile(p, tmpProfilePath, tmpBackupPath);
        assert(fs.existsSync(tmpProfilePath), 'Persisted profile must exist');
        assert(fs.existsSync(tmpBackupPath), 'Automated backup must exist');

        const backupContent = JSON.parse(fs.readFileSync(tmpBackupPath, 'utf8'));
        assert.strictEqual(backupContent.name, 'OLD', 'Backup must preserve previous content');

        const savedContent = JSON.parse(fs.readFileSync(tmpProfilePath, 'utf8'));
        assert.strictEqual(savedContent.name, 'MAGHAV AHUJA', 'Saved file must contain aggregated profile');

        // Validation guard: invalid profile should throw error and not overwrite
        assert.throws(() => {
            saveAggregatedProfile({ name: 'Incomplete' }, tmpProfilePath, tmpBackupPath);
        }, /missing keys/);

        // Cleanup tmp files
        if (fs.existsSync(tmpProfilePath)) fs.unlinkSync(tmpProfilePath);
        if (fs.existsSync(tmpBackupPath)) fs.unlinkSync(tmpBackupPath);
    }
    console.log('✓ 3-way profile aggregation, safe persistence & backup passed.\n');

    // -------------------------------------------------------------
    // Test 13: Dynamic Prompt Decoupling & Integrity Bug Fix (Phase 4)
    // -------------------------------------------------------------
    console.log('Test 13: Dynamic prompt decoupling & integrity bug fix...');
    {
        // 1. Verify dynamic formatters with arbitrary / synthetic profiles
        const syntheticProfile = {
            name: 'ALEX SMITH',
            contact: { email: 'alex@example.com', phone: '021 000 0000', location: 'Auckland, NZ' },
            experience: [
                { employer: 'Acme Corp', role: 'DevOps Engineer', location: 'Auckland', dates: '2023 - Present', bullets: ['Maintained CI/CD pipelines.'] },
                { employer: 'Beta LLC', role: 'Sysadmin', location: 'Wellington', dates: '2021 - 2023', bullets: ['Administered Linux servers.'] },
                { employer: 'Gamma Inc', role: 'Support Specialist', location: 'Remote', dates: '2019 - 2021', bullets: ['Resolved level 2 tickets.'] },
                { employer: 'Delta Ltd', role: 'Network Assistant', location: 'Christchurch', dates: '2018 - 2019', bullets: ['Configured Cisco routers.'] },
                { employer: 'Epsilon Co', role: 'Junior Tech', location: 'Hamilton', dates: '2017 - 2018', bullets: ['Hardware repairs and triage.'] }
            ],
            projects: [
                { name: 'Kubernetes Cluster', tech: 'K8s, ArgoCD', bullets: ['Engineered GitOps pipeline with ArgoCD and Helm.'] },
                { name: 'Monitoring Stack', tech: 'Prometheus, Grafana', bullets: ['Set up Prometheus alerting rules.'] }
            ],
            education: [
                { qualification: 'BSc in Computer Science', institution: 'University of Auckland', dates: '2014 - 2017' }
            ],
            volunteer: [
                { role: 'Open Source Contributor', organization: 'Linux Foundation', dates: '2020 - Present' }
            ]
        };

        // Check employer names summary formats correctly with Oxford-style / 'and' conjunction
        const summary5 = getEmployerNamesSummary(syntheticProfile);
        assert.strictEqual(summary5, 'Acme Corp, Beta LLC, Gamma Inc, Delta Ltd and Epsilon Co');

        const summary1 = getEmployerNamesSummary({ experience: [{ employer: 'Acme Corp' }] });
        assert.strictEqual(summary1, 'Acme Corp');

        const summary2 = getEmployerNamesSummary({ experience: [{ employer: 'Acme Corp' }, { employer: 'Beta LLC' }] });
        assert.strictEqual(summary2, 'Acme Corp and Beta LLC');

        const projSummary = getProjectNamesSummary(syntheticProfile);
        assert.strictEqual(projSummary, 'Kubernetes Cluster, Monitoring Stack');

        const eduSummary = getEducationNamesSummary(syntheticProfile);
        assert.strictEqual(eduSummary, 'University of Auckland');

        const volSummary = getVolunteerNamesSummary(syntheticProfile);
        assert.strictEqual(volSummary, 'Linux Foundation');

        // Check formatVerifiedEmployers generates markdown fact block with all 5 employers
        const formattedEmployers = formatVerifiedEmployers(syntheticProfile);
        assert(formattedEmployers.includes('1. Acme Corp | Auckland | DevOps Engineer | 2023 - Present'));
        assert(formattedEmployers.includes('2. Beta LLC | Wellington | Sysadmin | 2021 - 2023'));
        assert(formattedEmployers.includes('5. Epsilon Co | Hamilton | Junior Tech | 2017 - 2018'));

        // Check formatVerifiedProjects
        const formattedProjects = formatVerifiedProjects(syntheticProfile);
        assert(formattedProjects.includes('1. Kubernetes Cluster (K8s, ArgoCD)'));
        assert(formattedProjects.includes('2. Monitoring Stack (Prometheus, Grafana)'));

        // 2. Dynamic Baseline Document Generation (buildFactualApplicationDocuments)
        // With synthetic profile having 5 employers:
        const syntheticDocs = buildFactualApplicationDocuments({
            profile: syntheticProfile,
            category: 'serviceDesk',
            companyName: 'TestCorp',
            jobTitle: 'Senior Systems Engineer',
            jobDescription: 'Seeking an engineer with CI/CD and Linux experience.'
        });

        // Cover letter opening must dynamically incorporate all 5 employers
        assert(syntheticDocs.coverLetterMarkdown.includes('Acme Corp, Beta LLC, Gamma Inc, Delta Ltd and Epsilon Co'),
            'Cover letter opening must include all 5 synthetic employers dynamically');
        assert(!syntheticDocs.coverLetterMarkdown.includes('Neurix'),
            'Cover letter should not contain hardcoded default employers when custom profile provided');

        // Baseline CV markdown should include all 5 employers
        assert(syntheticDocs.cvMarkdown.includes('Acme Corp'));
        assert(syntheticDocs.cvMarkdown.includes('Epsilon Co'));

        // 3. Verify validateCVIntegrity signature fix with candidateProfile object
        const defaultProfile = loadCandidateProfile();
        const defaultDocs = buildFactualApplicationDocuments({
            profile: defaultProfile,
            category: 'cloud',
            companyName: 'Datacom',
            jobTitle: 'Cloud Solutions Engineer',
            jobDescription: 'Cloud engineer with AWS, Azure, Linux and Terraform.'
        });

        // Passing candidateProfile object directly to validateCVIntegrity (as now done in pipeline line 2289/2306)
        const integrityCheck = validateCVIntegrity(defaultDocs.cvMarkdown, defaultProfile);
        assert.strictEqual(integrityCheck.valid, true, 'Default factual CV should pass integrity check');
        assert.strictEqual(integrityCheck.issues.length, 0, 'Should have zero integrity issues');

        // If CV is missing an employer from candidateProfile, validateCVIntegrity catches it
        const tamperedCV = defaultDocs.cvMarkdown.replace(/Neurix Limited/g, 'Phantom Corp');
        const tamperedCheck = validateCVIntegrity(tamperedCV, defaultProfile);
        assert.strictEqual(tamperedCheck.valid, false, 'Tampered CV should fail integrity check');
        assert(tamperedCheck.issues.some(iss => iss.includes('Neurix Limited')),
            'Integrity check should detect missing required employer');
    }
    console.log('✓ Dynamic prompt decoupling & integrity bug fix passed.\n');

    // -------------------------------------------------------------
    // Test 14: Dynamic Factual Entity Verification (Phase 5 - Step 5.1)
    // -------------------------------------------------------------
    console.log('Test 14: Dynamic factual entity verification (Step 5.1)...');
    {
        // 1. Create a fully synthetic profile with distinct employers, roles, projects, volunteer, education
        const testProfile = {
            name: 'SARAH CONNOR',
            contact: { email: 'sarah@resistance.org', phone: '+64 21 999 8888', location: 'Wellington, NZ' },
            workingRights: 'New Zealand Citizen',
            summary: 'Principal Site Reliability and Security Systems Engineer with extensive background in zero-trust architecture, automated multi-cloud infrastructure, and resilient platform operations. Proven track record maintaining mission-critical uptime across distributed Kubernetes environments, leading incident triage under pressure, and driving automation with Terraform, Python, and Rust. Holds current New Zealand citizenship.',
            experience: [
                {
                    employer: 'Cyberdyne Systems',
                    role: 'Chief Security Architect',
                    dates: '2022 - Present',
                    bullets: [
                        'Hardened enterprise Linux servers against advanced AI intrusion and unauthorized lateral network movement across multi-tenant cloud environments.',
                        'Engineered automated zero-trust authorization architecture utilizing SPIFFE/SPIRE, reducing privilege escalation attack surface by approximately 65%.',
                        'Orchestrated continuous vulnerability remediation and kernel live-patching workflows for over 250 production nodes without service interruption.',
                        'Led rapid incident response protocol and forensic analysis for security anomalies, maintaining an average mean time to resolution under 20 minutes.'
                    ]
                },
                {
                    employer: 'Vortex Global',
                    role: 'Principal Site Reliability Engineer',
                    dates: '2019 - 2022',
                    bullets: [
                        'Maintained 99.999% uptime across production Kubernetes clusters hosted on AWS and GCP, serving over 10 million active daily user requests.',
                        'Architected GitOps deployment pipelines using ArgoCD, Helm charts, and GitHub Actions, accelerating release cycles from bi-weekly to daily releases.',
                        'Implemented distributed tracing and comprehensive metric aggregation using Prometheus, Grafana, and OpenTelemetry to identify latency bottlenecks.',
                        'Conducted comprehensive chaos engineering experiments and failover disaster recovery simulations to validate cluster fault tolerance and resilience.'
                    ]
                },
                {
                    employer: 'Apex Cloud Solutions',
                    role: 'Cloud Infrastructure Specialist',
                    dates: '2017 - 2019',
                    bullets: [
                        'Automated multi-region AWS and Azure cloud deployments with modular, version-controlled Terraform code and strict compliance policy enforcement.',
                        'Standardized infrastructure configuration management using Ansible playbooks, ensuring consistent system state across 500+ virtual machines.',
                        'Designed and implemented high-availability cloud networking topologies featuring transit gateways, VPN interconnects, and strict firewall policies.',
                        'Decreased overall monthly cloud infrastructure expenditures by 32% through automated rightsizing, reserved instance planning, and spot workload scheduling.'
                    ]
                },
                {
                    employer: 'Horizon Networks',
                    role: 'Network Support Analyst',
                    dates: '2015 - 2017',
                    bullets: [
                        'Configured BGP routing, VLAN segmentations, and enterprise IPSec VPN tunnels across 40 branch offices and remote worker access nodes.',
                        'Administered multi-vendor networking appliances and edge security firewalls while maintaining comprehensive operational change documentation.',
                        'Resolved complex Tier 3 network connectivity incidents, packet losses, and latency degradation using Wireshark and deep packet inspection.',
                        'Standardized routine operational tasks through Python and Bash scripts, cutting customer ticket turnaround times by 45%.'
                    ]
                }
            ],
            projects: [
                {
                    name: 'SkyNet Defense Shield',
                    tech: 'Rust, eBPF',
                    bullets: [
                        'Engineered custom eBPF kernel probes in Rust to detect anomalous system calls and network exfiltration attempts in real time across Linux hosts.',
                        'Deployed microservices telemetry collector processing 50,000 events per second with sub-millisecond latency overhead and automated alerting.',
                        'Automated kernel ring-buffer monitoring and integrated anomaly alerts with Slack and PagerDuty for on-call security response.'
                    ]
                },
                {
                    name: 'Automated Failover Cluster',
                    tech: 'Terraform, Consul',
                    bullets: [
                        'Built zero-downtime cluster failover orchestration utilizing HashiCorp Consul, Nomad, and automated DNS routing updates across dual availability zones.',
                        'Simulated split-brain network partition scenarios and verified strict data consistency guarantees under adverse failure modes.',
                        'Created automated health-check probes and automated state synchronization scripts to ensure rapid consensus recovery.'
                    ]
                },
                {
                    name: 'Global Telemetry Pipeline',
                    tech: 'Prometheus, Grafana',
                    bullets: [
                        'Integrated distributed Prometheus collectors and Thanos query engines to provide long-term metric retention across global cloud regions.',
                        'Constructed dynamic Grafana operational dashboards for executive visibility into service level objectives, error budgets, and system health.',
                        'Engineered custom alertmanager routing rules and silenced flapping notifications during scheduled maintenance windows.'
                    ]
                }
            ],
            volunteer: [
                { organisation: 'Electronic Frontier Foundation', role: 'Privacy Advocate', bullet: 'Conducted security webinars and authored open privacy documentation for 2,000+ engineers.' },
                { organization: 'Open Source Security Coalition', role: 'Lead Auditor', bullet: 'Audited open source codebases and contributed proactive security patches to container runtimes.' } // Tests US spelling 'organization'
            ],
            education: [
                { institution: 'Victoria University of Wellington', qualification: 'Master of Information Technology', dates: '2013 - 2015', bullet: 'Focused on distributed systems, network security protocols, and high-performance computing.' },
                { institution: 'University of Canterbury', qualification: 'Bachelor of Science in Computer Science', dates: '2009 - 2013', bullet: 'Foundations of algorithms, operating system internals, computer architecture, and networking.' }
            ],
            skills: [
                { category: 'Cloud & Virtualisation', text: 'AWS, Azure, GCP, Kubernetes, Docker, VMware ESXi, Proxmox VE, KVM' },
                { category: 'Infrastructure as Code', text: 'Terraform, Ansible, CloudFormation, Packer, Pulumi, Helm, ArgoCD' },
                { category: 'Observability & Monitoring', text: 'Prometheus, Grafana, Datadog, Zabbix, ELK Stack, Jaeger, OpenTelemetry' },
                { category: 'Security & Networking', text: 'eBPF, Zero Trust, SPIFFE/SPIRE, IPsec VPN, BGP, WireGuard, OIDC, TLS' },
                { category: 'Languages & Scripting', text: 'Python, Bash, Rust, Go, PowerShell, YAML, SQL, Shell Scripting' },
                { category: 'CI/CD & DevOps', text: 'GitHub Actions, GitLab CI, Jenkins, Tekton, Spinnaker, Docker Registry' }
            ],
            additional: [
                'Languages: English (native)',
                'Working rights: New Zealand Citizen'
            ]
        };

        const docs = buildFactualApplicationDocuments({
            profile: testProfile,
            category: 'devops',
            companyName: 'Skynet Defense',
            jobTitle: 'Lead SRE',
            jobDescription: 'Seeking a Lead SRE with Kubernetes, Terraform, AWS, and zero trust security experience.'
        });

        // Synthetic baseline should pass dynamic entity integrity check with zero issues
        const baseCheck = validateCVIntegrity(docs.cvMarkdown, testProfile);
        assert.strictEqual(baseCheck.valid, true, `Synthetic profile should pass integrity check: ${baseCheck.issues.join('; ')}`);
        assert.strictEqual(baseCheck.issues.length, 0);

        // A. Tampering with employer
        const missingEmployerCV = docs.cvMarkdown.replace(/Cyberdyne Systems/g, 'Phantom Corp');
        const empCheck = validateCVIntegrity(missingEmployerCV, testProfile);
        assert.strictEqual(empCheck.valid, false, 'Tampered employer should fail');
        assert(empCheck.issues.some(iss => iss.includes('Cyberdyne Systems')), 'Must flag missing employer Cyberdyne Systems');

        // B. Tampering with role
        const missingRoleCV = docs.cvMarkdown.replace(/Chief Security Architect/g, 'Sales Representative');
        const roleCheck = validateCVIntegrity(missingRoleCV, testProfile);
        assert.strictEqual(roleCheck.valid, false, 'Tampered role should fail');
        assert(roleCheck.issues.some(iss => iss.includes('Chief Security Architect')), 'Must flag missing role Chief Security Architect');

        // C. Tampering with project
        const missingProjCV = docs.cvMarkdown.replace(/SkyNet Defense Shield/g, 'Casual Todo App');
        const projCheck = validateCVIntegrity(missingProjCV, testProfile);
        assert.strictEqual(projCheck.valid, false, 'Tampered project should fail');
        assert(projCheck.issues.some(iss => iss.includes('SkyNet Defense Shield')), 'Must flag missing project SkyNet Defense Shield');

        // D. Tampering with volunteer organisation (verifies US spelling .organization too)
        const missingVolCV = docs.cvMarkdown.replace(/Open Source Security Coalition/g, 'Random Club');
        const volCheck = validateCVIntegrity(missingVolCV, testProfile);
        assert.strictEqual(volCheck.valid, false, 'Tampered volunteer org should fail');
        assert(volCheck.issues.some(iss => iss.includes('Open Source Security Coalition')), 'Must flag missing volunteer org');

        // E. Tampering with education institution
        const missingInstCV = docs.cvMarkdown.replace(/Victoria University of Wellington/g, 'Hogwarts Academy');
        const instCheck = validateCVIntegrity(missingInstCV, testProfile);
        assert.strictEqual(instCheck.valid, false, 'Tampered institution should fail');
        assert(instCheck.issues.some(iss => iss.includes('Victoria University of Wellington')), 'Must flag missing institution');

        // F. Tampering with education qualification
        const missingQualCV = docs.cvMarkdown.replace(/Master of Information Technology/g, 'Certificate of Participation');
        const qualCheck = validateCVIntegrity(missingQualCV, testProfile);
        assert.strictEqual(qualCheck.valid, false, 'Tampered qualification should fail');
        assert(qualCheck.issues.some(iss => iss.includes('Master of Information Technology')), 'Must flag missing qualification');

        // G. Case-insensitive and markdown header tolerance
        const titleCaseCV = docs.cvMarkdown
            .replace('## PROFESSIONAL SUMMARY', '## Professional Summary')
            .replace('## TECHNICAL SKILLS', '## Technical Skills')
            .replace('## PROFESSIONAL EXPERIENCE', '## Professional Experience');
        const titleCaseCheck = validateCVIntegrity(titleCaseCV, testProfile);
        assert.strictEqual(titleCaseCheck.valid, true, 'Title-case markdown headers should be accepted without false errors');

        // H. Helper containsEntity function tests
        assert.strictEqual(containsEntity('Worked at Department of Education Government of Delhi as assistant', 'Department of Education, Government of Delhi'), true);
        assert.strictEqual(containsEntity('Administered Neurix enterprise cluster', 'Neurix Limited'), true);
        assert.strictEqual(containsEntity('FreeCodeCamp community contributor', 'FreeCodeCamp.org'), true);
    }
    console.log('✓ Dynamic factual entity verification passed.\n');

    // -------------------------------------------------------------
    // Test 15: Signature Call Bug & Defensive Fallback (Phase 5 - Step 5.2)
    // -------------------------------------------------------------
    console.log('Test 15: Signature call bug & defensive fallback (Step 5.2)...');
    {
        const defaultProfile = loadCandidateProfile();
        const docs = buildFactualApplicationDocuments({
            profile: defaultProfile,
            category: 'systems',
            companyName: 'Otago',
            jobTitle: 'Systems Specialist',
            jobDescription: 'Linux and Windows systems administration.'
        });

        // 1. Caller accidentally passes mergedText string as profile (old pipeline lines 2234/2251 bug)
        const mergedTextLegacy = '===== SOURCE CV: cv1.pdf =====\nMaghav Ahuja resume content...';
        const fallbackCheck = validateCVIntegrity(docs.cvMarkdown, mergedTextLegacy);
        assert.strictEqual(fallbackCheck.valid, true, 'String profile must safely trigger fallback to active candidate profile');
        assert.strictEqual(fallbackCheck.issues.length, 0);

        // 2. Caller omits profile entirely
        const omitCheck = validateCVIntegrity(docs.cvMarkdown);
        assert.strictEqual(omitCheck.valid, true, 'Omitted profile must safely trigger fallback to active candidate profile');

        // 3. Passing null / empty CV string
        const nullCheck = validateCVIntegrity(null, defaultProfile);
        assert.strictEqual(nullCheck.valid, false);
        assert.strictEqual(nullCheck.ok, false);
        assert(nullCheck.issues[0].includes('missing or empty'));

        const emptyCheck = validateCVIntegrity('', defaultProfile);
        assert.strictEqual(emptyCheck.valid, false);
        assert(emptyCheck.issues[0].includes('missing or empty'));
    }
    console.log('✓ Signature call bug & defensive fallback passed.\n');

    // -------------------------------------------------------------
    // Test 16: Strict Anti-Hallucination & Formatting Rules (Phase 5 - Step 5.3)
    // -------------------------------------------------------------
    console.log('Test 16: Strict anti-hallucination & formatting rules (Step 5.3)...');
    {
        const defaultProfile = loadCandidateProfile();
        const docs = buildFactualApplicationDocuments({
            profile: defaultProfile,
            category: 'serviceDesk',
            companyName: 'Beyond',
            jobTitle: 'IT Support',
            jobDescription: 'IT Support role.'
        });

        // 1. Out of order section: swap EDUCATION and TECHNICAL SKILLS
        const outOfOrderCV = docs.cvMarkdown.replace('## TECHNICAL SKILLS', '## TEMP_SKILLS')
            .replace('## EDUCATION', '## TECHNICAL SKILLS')
            .replace('## TEMP_SKILLS', '## EDUCATION');
        const orderCheck = validateCVIntegrity(outOfOrderCV, defaultProfile);
        assert.strictEqual(orderCheck.valid, false, 'Out of order sections must fail');
        assert(orderCheck.issues.some(iss => iss.includes('Section out of order')), 'Must flag out of order section');

        // 2. Missing required section
        const missingSectionCV = docs.cvMarkdown.replace(/## TECHNICAL SKILLS[\s\S]*?(?=## PROFESSIONAL EXPERIENCE)/, '');
        const missingSecCheck = validateCVIntegrity(missingSectionCV, defaultProfile);
        assert.strictEqual(missingSecCheck.valid, false, 'Missing section must fail');
        assert(missingSecCheck.issues.some(iss => iss.includes('Missing section: TECHNICAL SKILLS')), 'Must flag missing TECHNICAL SKILLS');

        // 3. Strict fabrication detection
        const fabrications = ['Cognizant', 'University of Delhi', 'AUT University', 'TCS', 'Infosys', 'San Francisco', '**New:**'];
        for (const fab of fabrications) {
            const fabCV = docs.cvMarkdown + `\n- Additional note regarding ${fab} experience.`;
            const fabCheck = validateCVIntegrity(fabCV, defaultProfile);
            assert.strictEqual(fabCheck.valid, false, `Fabrication "${fab}" must be caught`);
            assert(fabCheck.issues.some(iss => iss.includes(`Fabricated content detected: "${fab}"`)), `Must flag "${fab}"`);
        }

        // 4. Placeholders and truncation markers
        const placeholders = ['[...truncated]', '{{company_name}}', '[insert link here]', 'placeholder for certifications'];
        for (const pl of placeholders) {
            const plCV = docs.cvMarkdown + `\n- Reference: ${pl}`;
            const plCheck = validateCVIntegrity(plCV, defaultProfile);
            assert.strictEqual(plCheck.valid, false, `Placeholder "${pl}" must be caught`);
            assert(plCheck.issues.some(iss => iss.includes('Placeholder or truncation marker detected')));
        }

        // 5. Incomplete ADDITIONAL INFORMATION
        const incompleteAddCV = docs.cvMarkdown.replace(/Working rights:.*$/im, '');
        const addCheck = validateCVIntegrity(incompleteAddCV, defaultProfile);
        assert.strictEqual(addCheck.valid, false, 'Missing working rights in ADDITIONAL INFORMATION must fail');
        assert(addCheck.issues.some(iss => iss.includes('ADDITIONAL INFORMATION is incomplete')));

        // 6. Word budget boundaries (750 to 1200 words)
        // Sparse CV (< 750 words)
        const sparseCV = docs.cvMarkdown.split('\n').slice(0, 30).join('\n');
        const sparseCheck = validateCVIntegrity(sparseCV, defaultProfile);
        assert.strictEqual(sparseCheck.valid, false, 'Sparse CV must fail');
        assert(sparseCheck.issues.some(iss => iss.includes('CV is too sparse')));

        // Over-long CV (> 1200 words)
        const fillerParagraph = ' This is an expansive technical explanation describing system monitoring and infrastructure architecture in deep operational detail.';
        const longCV = docs.cvMarkdown + fillerParagraph.repeat(50);
        const longCheck = validateCVIntegrity(longCV, defaultProfile);
        assert.strictEqual(longCheck.valid, false, 'Over-long CV (>1200 words) must fail');
        assert(longCheck.issues.some(iss => iss.includes('CV is too long')));
    }
    console.log('✓ Strict anti-hallucination & formatting rules passed.\n');

    // -------------------------------------------------------------
    // Test 17: Preflight Profile Sync Hook Lifecycle (Phase 6 - Step 6.1)
    // -------------------------------------------------------------
    console.log('Test 17: Preflight Profile Sync Hook Lifecycle (Phase 6 - Step 6.1)...');
    {
        // 1. skipSync: true without forceSync
        const skipPipeline = new Pipeline({
            jobLink: 'https://www.seek.co.nz/job/12345678',
            skipSync: true,
            forceSync: false
        });
        assert.strictEqual(skipPipeline.skipSync, true, 'Pipeline must record skipSync=true');
        assert.strictEqual(skipPipeline.forceSync, false, 'Pipeline must record forceSync=false');
        const skipResult = await skipPipeline.runPreflightSync();
        assert.strictEqual(skipResult.performed, false, 'Preflight sync must be skipped when skipSync=true');
        assert.strictEqual(skipResult.skipped, true, 'Result must indicate skipped: true');

        // 2. forceSync: true overrides skipSync: true
        const forcePipeline = new Pipeline({
            jobLink: 'https://www.seek.co.nz/job/12345678',
            skipSync: true,
            forceSync: true
        });
        assert.strictEqual(forcePipeline.forceSync, true, 'forceSync must be true');
        const forceResult = await forcePipeline.runPreflightSync();
        assert.strictEqual(forceResult.performed, true, 'forceSync must override skipSync');
        assert(forceResult.syncResult, 'Must return syncResult from aggregateProfiles');
        assert(forceResult.syncResult.profile, 'Must contain aggregated profile');
        assert(forceResult.syncResult.profile.name.toUpperCase().includes('MAGHAV'), 'Candidate name must contain MAGHAV');

        // 3. Normal preflight sync (skipSync: false, forceSync: false)
        const normalPipeline = new Pipeline({
            jobLink: 'https://www.seek.co.nz/job/12345678',
            skipSync: false,
            forceSync: false
        });
        const normalResult = await normalPipeline.runPreflightSync();
        assert.strictEqual(normalResult.performed, true, 'Normal preflight sync must execute');
        assert(normalResult.syncResult, 'Must return syncResult');
    }
    console.log('✓ Preflight Profile Sync Hook lifecycle passed.\n');

    // -------------------------------------------------------------
    // Test 18: Server.js API Endpoints & Form Contract (Phase 6 - Step 6.3)
    // -------------------------------------------------------------
    console.log('Test 18: Server.js API Endpoints & Form Contract (Phase 6 - Step 6.3)...');
    {
        const http = require('http');
        const app = require('../server');
        assert(typeof app === 'function', 'server.js must export express application');

        const testServer = http.createServer(app);
        await new Promise(resolve => testServer.listen(0, resolve));
        const port = testServer.address().port;

        try {
            // 1. GET /api/cvs
            const cvsRes = await fetch(`http://127.0.0.1:${port}/api/cvs`);
            assert.strictEqual(cvsRes.status, 200, '/api/cvs must return 200');
            const cvsData = await cvsRes.json();
            assert(Array.isArray(cvsData.cvs), 'cvsData must include cvs array');
            assert(cvsData.profile, 'cvsData must include profile metadata');
            assert(cvsData.profile.lastAggregated, 'profile must include lastAggregated');
            assert(typeof cvsData.profile.employerCount === 'number', 'profile must have employerCount');
            assert(typeof cvsData.profile.projectCount === 'number', 'profile must have projectCount');
            assert(cvsData.portfolioCache, 'cvsData must include portfolioCache metadata');

            // 2. POST /api/start-pipeline without body
            const invalidRes = await fetch(`http://127.0.0.1:${port}/api/start-pipeline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            assert.strictEqual(invalidRes.status, 400, 'Must return 400 for missing jobLink');
            const invalidData = await invalidRes.json();
            assert.strictEqual(invalidData.success, false);
            assert.strictEqual(invalidData.error, 'jobLink is required');

            // 3. POST /api/start-pipeline with invalid URL
            const badUrlRes = await fetch(`http://127.0.0.1:${port}/api/start-pipeline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobLink: 'not-a-valid-url' })
            });
            assert.strictEqual(badUrlRes.status, 400, 'Must return 400 for bad URL');
            const badUrlData = await badUrlRes.json();
            assert.strictEqual(badUrlData.success, false);
            assert.strictEqual(badUrlData.error, 'Invalid URL');
        } finally {
            await new Promise(resolve => testServer.close(resolve));
        }

        // Verify candidate_profile.json metadata structure matches web contract
        const candidateProfilePath = path.join(__dirname, '..', 'candidate_profile.json');
        assert(fs.existsSync(candidateProfilePath), 'candidate_profile.json must exist');
        const profileData = JSON.parse(fs.readFileSync(candidateProfilePath, 'utf8'));
        assert(profileData.lastAggregated, 'profile must contain lastAggregated timestamp');
        assert(Array.isArray(profileData.experience), 'profile must have experience array');
        assert(Array.isArray(profileData.projects), 'profile must have projects array');
        assert(profileData.skills, 'profile must have skills object');

        // Verify job_application_form.html contains forceSync and sync metadata rendering
        const formHtmlPath = path.join(__dirname, '..', 'job_application_form.html');
        assert(fs.existsSync(formHtmlPath), 'job_application_form.html must exist');
        const formHtml = fs.readFileSync(formHtmlPath, 'utf8');
        assert(formHtml.includes('id="forceSync"'), 'Form must include forceSync checkbox');
        assert(formHtml.includes('forceSync: document.getElementById(\'forceSync\')'), 'Submit handler must include forceSync payload');
        assert(formHtml.includes('Profile Sync:'), 'UI must render Profile Sync timestamp and metadata');
    }
    console.log('✓ Server.js API endpoints & form contract verified.\n');

    console.log('===========================================================');
    console.log('ALL PHASE 1 THROUGH PHASE 6 DYNAMIC SYNC TESTS PASSED (18/18)! ✓');
    console.log('===========================================================');
}

runTests().catch(err => {
    console.error('\n✖ Test suite failed with error:', err);
    process.exit(1);
});
