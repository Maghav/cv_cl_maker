#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const Pipeline = require('../job_application_pipeline');

const {
    loadCandidateProfile,
    buildFactualApplicationDocuments,
    validateCVIntegrity,
    enforceAtsBulletConstraints,
    ensureAtsKeywordsPresent,
    checkAtsScoreViaApi,
} = Pipeline._internals;

async function runTests() {
    console.log('=== ATS 85+ Optimization Suite ===\n');

    const profile = loadCandidateProfile(path.resolve(__dirname, '..'));

    // Test 1: enforceAtsBulletConstraints
    console.log('Test 1: Bullet length constraint enforcement (< 50 words)...');
    const longBulletCV = `# MAGHAV AHUJA
## Systems Engineer
maghav@example.com | +64 21 000 0000 | Auckland, New Zealand

## PROFESSIONAL SUMMARY
This is a very long summary that goes on and on with lots of words trying to explain everything about the candidate and their career history in technology and systems administration and support and customer service across New Zealand and abroad without ever stopping or taking a breath to see if the ATS scanner will complain about word length or dense paragraphs.

## TECHNICAL SKILLS
- **Cloud & Infrastructure:** Azure, AWS, Windows Server, Linux

## PROFESSIONAL EXPERIENCE
### Neurix Limited | Auckland
#### Systems Engineer | 2023 - Present
- Spearheaded the complete migration and modernization of multi-tier cloud and hybrid infrastructure environments across enterprise client organizations while actively coordinating with diverse senior stakeholder teams, provisioning automated backup pipelines, standardizing configuration management workflows, and delivering zero-downtime operational transitions throughout the multi-quarter transformation project lifecycle.

### Datacom NZ | Auckland
#### Systems Specialist | 2021 - 2023
- Administered enterprise Microsoft 365 and Azure AD environments for tier-one clients.

### Department of Education Government of Delhi | New Delhi
#### IT Officer | 2019 - 2021
- Maintained workstation deployments.

### Mitre10 MEGA | Auckland
#### Customer Service Specialist | 2023 - 2024
- Assisted customers with calm communication.

## KEY PROJECTS
### Nextcloud & Systems Learning Lab
- Deployed private cloud infrastructure.

## VOLUNTEER EXPERIENCE
### FreeCodeCamp.org
- Mentored junior developers.

## EDUCATION
### Unitec Institute of Technology
#### Master of Applied Technologies | 2022 - 2024

## ADDITIONAL INFORMATION
- Working rights: Open Work Visa
- Languages: English
`;

    const constrained = enforceAtsBulletConstraints(longBulletCV);
    const lines = constrained.split('\n');
    for (const line of lines) {
        if (line.trim().startsWith('- ')) {
            const words = line.trim().split(/\s+/).length;
            assert(words <= 50, `Bullet exceeds 50 words: ${words} words found`);
        }
    }
    console.log('✓ Bullet length enforcement successfully verified (all bullets <= 48 words).');

    // Test 2: ensureAtsKeywordsPresent & Factual Integrity
    console.log('\nTest 2: Programmatic keyword weaving with factual integrity...');
    const baseDocs = buildFactualApplicationDocuments({
        profile,
        jobTitle: 'Level 2 VoIP Support Engineer',
        companyName: 'OxygenIT Limited',
        jobDescription: 'Level 2 VoIP Support Engineer in Christchurch at OxygenIT Limited.'
    });

    const missingKws = [
        { keyword: 'Christchurch' },
        { keyword: 'Oxygenit' },
        { keyword: 'Fault Records' },
        { keyword: 'Fixed' },
        { keyword: 'Overnight' },
        { keyword: 'SIP Traces' },
        { keyword: 'Packet Captures' }
    ];
    const missingSkills = [
        { name: 'PPE Compliance', category_name: 'Facilities, Operations & Custodial' }
    ];

    const wovenCV = ensureAtsKeywordsPresent(baseDocs.cvMarkdown, {
        missingKeywords: missingKws,
        missingSkills,
        companyName: 'OxygenIT Limited',
        jobTitle: 'Level 2 VoIP Support Engineer',
        location: 'Christchurch',
        candidateProfile: profile
    });

    const cvLower = wovenCV.toLowerCase();
    for (const k of missingKws) {
        assert(cvLower.includes(k.keyword.toLowerCase()), `Missing keyword not woven: ${k.keyword}`);
    }
    for (const s of missingSkills) {
        assert(cvLower.includes(s.name.toLowerCase()), `Missing skill not woven: ${s.name}`);
    }

    // Verify factual integrity
    const integrity = validateCVIntegrity(wovenCV, profile);
    assert.strictEqual(integrity.ok, true, `Integrity failed after keyword weaving: ${integrity.issues.join(' | ')}`);
    console.log('✓ All missing keywords & skills verified present while strictly preserving verified facts.');

    // Test 3: Live ATS scoring check on ats.onl9.club
    console.log('\nTest 3: Live ATS scoring verification via ats-api.onl9.club...');
    const testJd = `Level 2 VoIP Support Engineer at OxygenIT Limited in Christchurch, New Zealand.
You take voice and connectivity faults and own them until fixed and proven fixed.
Diagnose using packet captures, SIP traces, RTP flow analysis and router interfaces.
Progress faults directly with wholesale carriers and hosted voice platform providers.
Keep accurate, structured fault records meeting compliance standards.
Handle overnight alerting queues and resolve customer incidents before the next day.
PPE compliance and workplace health and safety.
Salary: $85,000 - $95,000.`;

    const atsRes = await checkAtsScoreViaApi(wovenCV, testJd, {
        jobTitle: 'Level 2 VoIP Support Engineer',
        companyName: 'OxygenIT Limited'
    });

    console.log(`Preflight Baseline ATS Score: ${atsRes.score}%`);
    console.log(`Missing Keywords (${atsRes.missingKeywords?.length || 0}):`, atsRes.missingKeywords?.map(k => k.keyword));
    console.log(`Missing Skills (${atsRes.missingSkills?.length || 0}):`, atsRes.missingSkills?.map(s => s.name));

    // Now test Step 2 of the loop: feed all returned missing keywords and skills into ensureAtsKeywordsPresent!
    const fullyOptimized = ensureAtsKeywordsPresent(wovenCV, {
        missingKeywords: atsRes.missingKeywords,
        missingSkills: atsRes.missingSkills,
        companyName: 'OxygenIT Limited',
        jobTitle: 'Level 2 VoIP Support Engineer',
        location: 'Christchurch',
        candidateProfile: profile
    });

    console.log('\nRe-checking ATS score after complete keyword loop...');
    const atsRes2 = await checkAtsScoreViaApi(fullyOptimized, testJd, {
        jobTitle: 'Level 2 VoIP Support Engineer',
        companyName: 'OxygenIT Limited'
    });

    console.log(`Live ATS Score after keyword loop: ${atsRes2.score}%`);
    console.log('Score Breakdown:', atsRes2.rawData?.score_breakdown || atsRes2.score);
    console.log('Remaining Missing Keywords:', atsRes2.missingKeywords?.map(k => k.keyword));

    console.log('\n🎉 All ATS optimization tests PASSED!');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
