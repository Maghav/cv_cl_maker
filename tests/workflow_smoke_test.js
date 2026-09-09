#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const Pipeline = require('../job_application_pipeline');

const {
    loadCandidateProfile,
    buildFactualApplicationDocuments,
    validateCVIntegrity,
    cvMarkdownToHtml,
} = Pipeline._internals;

const workspaceRoot = path.resolve(__dirname, '..');
const profile = loadCandidateProfile(workspaceRoot);

const fixtures = [
    {
        expectedCategory: 'serviceDesk',
        companyName: 'Mercury',
        jobTitle: 'Service Desk Analyst',
        jobDescription: 'First-line onsite and walk-up support using Jira Service Management. Windows, Active Directory, Exchange, Group Policy, asset records, user setup, diagnosis, escalation, ITIL and customer communication.'
    },
    {
        expectedCategory: 'systems',
        companyName: 'University of Otago',
        jobTitle: 'Systems Specialist',
        jobDescription: 'Systems administration and management for digital learning, core LMS and teaching tools. Troubleshoot complex information systems, document changes, collaborate with stakeholders and manage competing priorities.'
    },
    {
        expectedCategory: 'technicalSupport',
        companyName: 'Gallagher',
        jobTitle: 'Technical Support Engineer',
        jobDescription: 'Customer and channel-partner technical queries by phone and email, CRM notes, networking and device troubleshooting, root-cause analysis, escalation, knowledge base and calm communication.'
    }
];

for (const fixture of fixtures) {
    const result = buildFactualApplicationDocuments({ profile, ...fixture });
    assert.strictEqual(result.category, fixture.expectedCategory, `${fixture.companyName}: wrong job classification`);

    const integrity = validateCVIntegrity(result.cvMarkdown, profile);
    assert.deepStrictEqual(integrity.issues, [], `${fixture.companyName}: ${integrity.issues.join(' | ')}`);
    assert(result.cvMarkdown.includes(`## ${fixture.jobTitle}`), `${fixture.companyName}: missing target title`);
    for (const role of profile.experience) assert(result.cvMarkdown.includes(role.employer), `${fixture.companyName}: missing ${role.employer}`);
    for (const project of profile.projects) assert(result.cvMarkdown.includes(project.name), `${fixture.companyName}: missing ${project.name}`);

    const html = cvMarkdownToHtml(result.cvMarkdown);
    assert(html.startsWith('<header class="cv-header">'), `${fixture.companyName}: header is not wrapped`);
    assert(html.includes(`<div class="target-role">${fixture.jobTitle}</div>`), `${fixture.companyName}: subtitle is not in header`);
    assert(!html.includes('</li><br><li>'), `${fixture.companyName}: list spacing regression`);
    assert(!html.includes('**New:**'), `${fixture.companyName}: model residue found`);

    assert(result.coverLetterMarkdown.includes(fixture.companyName), `${fixture.companyName}: cover letter company mismatch`);
    assert(result.coverLetterMarkdown.includes(`**Re: ${fixture.jobTitle}**`), `${fixture.companyName}: cover letter title mismatch`);
}

console.log(`Workflow smoke tests passed (${fixtures.length} jobs, ${profile.experience.length} employers, ${profile.projects.length} project groups).`);
