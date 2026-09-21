#!/usr/bin/env node

/**
 * build.js — Production Readiness & Build Verification
 *
 * Verifies that the codebase is completely production-ready:
 * 1. Node.js environment & version compatibility
 * 2. Dependency resolution & module loadability
 * 3. JavaScript syntax validation across all source and test files
 * 4. Critical runtime assets & schema validation (candidate profile, HTML UI, source CVs)
 * 5. Directory structure verification & initialization (output, tmp, my_cvs)
 * 6. Module contracts & interface integrity
 * 7. Environment configuration readiness
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = __dirname;
let hasErrors = false;

function logStep(step, message) {
    console.log(`\x1b[36m[Step ${step}]\x1b[0m ${message}...`);
}

function logPass(message) {
    console.log(`  \x1b[32m✓\x1b[0m ${message}`);
}

function logWarn(message) {
    console.log(`  \x1b[33m⚠\x1b[0m ${message}`);
}

function logFail(message) {
    hasErrors = true;
    console.error(`  \x1b[31m✗\x1b[0m ${message}`);
}

console.log('============================================================');
console.log('  Job Application Pipeline — Production Build Verification');
console.log('============================================================\n');

// 1. Check Node.js Version
logStep(1, 'Checking Node.js Runtime');
const currentVersion = process.versions.node;
const majorVersion = parseInt(currentVersion.split('.')[0], 10);
if (majorVersion >= 18) {
    logPass(`Node.js v${currentVersion} satisfies minimum requirement (>= 18.0.0).`);
} else {
    logFail(`Node.js v${currentVersion} is unsupported. Requires Node.js 18 or later.`);
}

// 2. Check Package Dependencies
logStep(2, 'Validating Dependencies');
const requiredPackages = ['express', 'cors', 'openai', 'pdf-parse', 'puppeteer'];
for (const pkg of requiredPackages) {
    try {
        require.resolve(pkg, { paths: [ROOT_DIR] });
        logPass(`Dependency '${pkg}' is installed and resolvable.`);
    } catch (err) {
        logFail(`Missing dependency '${pkg}'. Run 'npm install'.`);
    }
}

// 3. Syntax Verification across all JS files
logStep(3, 'Validating JavaScript Syntax');
const sourceFiles = [
    'server.js',
    'job_application_pipeline.js',
    'cv_parser.js',
    'portfolio_scraper.js',
    'profile_aggregator.js',
    'notion_sync.js',
    'run_pipeline.js'
];

const testDir = path.join(ROOT_DIR, 'tests');
const testFiles = fs.existsSync(testDir)
    ? fs.readdirSync(testDir).filter(f => f.endsWith('.js')).map(f => path.join('tests', f))
    : [];

const allJsFiles = [...sourceFiles, ...testFiles];
for (const relPath of allJsFiles) {
    const fullPath = path.join(ROOT_DIR, relPath);
    if (!fs.existsSync(fullPath)) {
        logFail(`File not found: ${relPath}`);
        continue;
    }
    try {
        execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
        logPass(`Syntax valid: ${relPath}`);
    } catch (err) {
        logFail(`Syntax error in ${relPath}: ${err.stderr ? err.stderr.toString().trim() : err.message}`);
    }
}

// 4. Runtime Assets & Schemas
logStep(4, 'Verifying Runtime Assets & Data Integrity');

// 4.1 Candidate profile
const profilePath = path.join(ROOT_DIR, 'candidate_profile.json');
if (!fs.existsSync(profilePath)) {
    logFail('Missing required file: candidate_profile.json');
} else {
    try {
        const raw = fs.readFileSync(profilePath, 'utf8');
        const profile = JSON.parse(raw);
        const requiredSections = ['name', 'contact', 'skills', 'experience', 'education'];
        const missingSections = requiredSections.filter(sec => !profile[sec]);
        if (missingSections.length > 0) {
            logFail(`candidate_profile.json is missing required sections: ${missingSections.join(', ')}`);
        } else {
            const expCount = profile.experience?.length || 0;
            const skillCount = Array.isArray(profile.skills) ? profile.skills.length : Object.keys(profile.skills || {}).length;
            logPass(`candidate_profile.json valid (${expCount} employers/roles, ${skillCount} skill categories).`);
        }
    } catch (err) {
        logFail(`candidate_profile.json parsing failed: ${err.message}`);
    }
}

// 4.2 Web UI form
const formPath = path.join(ROOT_DIR, 'job_application_form.html');
if (!fs.existsSync(formPath)) {
    logFail('Missing required file: job_application_form.html');
} else {
    const formStat = fs.statSync(formPath);
    if (formStat.size > 0) {
        logPass(`job_application_form.html verified (${formStat.size} bytes).`);
    } else {
        logFail('job_application_form.html is empty.');
    }
}

// 4.3 Source CVs
const myCvsDir = path.join(ROOT_DIR, 'my_cvs');
if (!fs.existsSync(myCvsDir)) {
    logWarn('my_cvs directory is missing; creating it now.');
    fs.mkdirSync(myCvsDir, { recursive: true });
} else {
    const cvFiles = fs.readdirSync(myCvsDir).filter(f => f.toLowerCase().endsWith('.pdf'));
    if (cvFiles.length === 0) {
        logWarn('No PDF source files found in my_cvs/. Base profile fallback will be used.');
    } else {
        logPass(`Found ${cvFiles.length} source CV(s) in my_cvs/: ${cvFiles.join(', ')}`);
    }
}

// 4.4 Environment templates
const envExamplePath = path.join(ROOT_DIR, '.env.example');
if (fs.existsSync(envExamplePath)) {
    logPass('.env.example configuration template exists.');
} else {
    logFail('Missing configuration template: .env.example');
}

// 5. Directory Structure Readiness
logStep(5, 'Ensuring Required Directory Structures');
const requiredDirs = ['output', 'tmp', 'my_cvs'];
for (const dir of requiredDirs) {
    const dirPath = path.join(ROOT_DIR, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logPass(`Created required directory: ${dir}/`);
    } else {
        logPass(`Directory ready: ${dir}/`);
    }
}

// 6. Core Module Interface Integrity
logStep(6, 'Verifying Core Module Contracts');
try {
    const Pipeline = require('./job_application_pipeline');
    if (typeof Pipeline === 'function' && typeof Pipeline.prototype.run === 'function' && Pipeline._internals) {
        logPass('job_application_pipeline class & internals validated (run, _internals).');
    } else {
        logFail('job_application_pipeline missing required exports.');
    }
} catch (err) {
    logFail(`Failed to load job_application_pipeline: ${err.message}`);
}

try {
    const cvParser = require('./cv_parser');
    if (typeof cvParser.parseCvPdf === 'function' && typeof cvParser.parseAllCvs === 'function') {
        logPass('cv_parser exports validated (parseCvPdf, parseAllCvs).');
    } else {
        logFail('cv_parser missing required exports.');
    }
} catch (err) {
    logFail(`Failed to load cv_parser: ${err.message}`);
}

try {
    const portfolioScraper = require('./portfolio_scraper');
    if (typeof portfolioScraper.scrapePortfolio === 'function') {
        logPass('portfolio_scraper exports validated (scrapePortfolio).');
    } else {
        logFail('portfolio_scraper missing required exports.');
    }
} catch (err) {
    logFail(`Failed to load portfolio_scraper: ${err.message}`);
}

try {
    const profileAggregator = require('./profile_aggregator');
    if (typeof profileAggregator.aggregateProfiles === 'function' && typeof profileAggregator.mergeProfiles === 'function') {
        logPass('profile_aggregator exports validated (aggregateProfiles, mergeProfiles).');
    } else {
        logFail('profile_aggregator missing required exports.');
    }
} catch (err) {
    logFail(`Failed to load profile_aggregator: ${err.message}`);
}

try {
    const notionSync = require('./notion_sync');
    if (typeof notionSync.syncJobToNotion === 'function' && typeof notionSync.uploadFileToNotion === 'function') {
        logPass('notion_sync exports validated (syncJobToNotion, uploadFileToNotion).');
    } else {
        logFail('notion_sync missing required exports.');
    }
} catch (err) {
    logFail(`Failed to load notion_sync: ${err.message}`);
}

// 7. Summary
console.log('\n============================================================');
if (hasErrors) {
    console.error('❌ BUILD FAILED: Issues were detected that prevent production deployment.');
    console.log('============================================================\n');
    process.exit(1);
} else {
    console.log('🎉 BUILD SUCCESS: All production readiness checks PASSED!');
    console.log('   The pipeline is verified and production ready.');
    console.log('============================================================\n');
    process.exit(0);
}
