#!/usr/bin/env node
/**
 * Form autofill tests — pure logic only (no Puppeteer, no network, no DOM).
 * Run: node tests/test_form_autofill.js
 */

const assert = require('assert');
const {
    classifyFormField,
    detectApplyPlatform,
    buildFormValueMap,
    markdownToPlainText,
} = require('../form_autofill');

let section = '';
let count = 0;
function check(name, fn) {
    count++;
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (e) {
        console.error(`\n FAILED [${section}] ${name}: ${e.message}`);
        process.exit(1);
    }
}
function suite(name) {
    section = name;
    console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
suite('classifyFormField — personal name fields');
check('input[name=firstName] → firstName', () => {
    const r = classifyFormField({ name: 'firstName', type: 'text' });
    assert.strictEqual(r.key, 'firstName');
    assert.strictEqual(r.skip, false);
});
check('label "First Name" → firstName', () => {
    assert.strictEqual(classifyFormField({ label: 'First Name', type: 'text' }).key, 'firstName');
});
check('id "last_name" → lastName', () => {
    assert.strictEqual(classifyFormField({ id: 'last_name', type: 'text' }).key, 'lastName');
});
check('label "Surname" → lastName', () => {
    assert.strictEqual(classifyFormField({ label: 'Surname', type: 'text' }).key, 'lastName');
});
check('label "Full name" → fullName', () => {
    assert.strictEqual(classifyFormField({ label: 'Full name', type: 'text' }).key, 'fullName');
});
check('label "Company name" is NOT the candidate name (unknown)', () => {
    const r = classifyFormField({ label: 'Company name', type: 'text' });
    assert.strictEqual(r.key, 'unknown');
    assert.strictEqual(r.skip, false);
});
check('aria-label "Preferred first choice" is NOT a name (unknown)', () => {
    assert.strictEqual(classifyFormField({ ariaLabel: 'Preferred first choice', type: 'text' }).key, 'unknown');
});

suite('classifyFormField — contact fields');
check('input[type=email] → email', () => {
    assert.strictEqual(classifyFormField({ name: 'email', type: 'email' }).key, 'email');
});
check('label "Email address" → email', () => {
    assert.strictEqual(classifyFormField({ label: 'Email address', type: 'text' }).key, 'email');
});
check('TRICKY: "Email notifications" checkbox is NOT an email field (skipped consent)', () => {
    const r = classifyFormField({ name: 'email_notifications', label: 'Email notifications', type: 'checkbox' });
    assert.strictEqual(r.key, 'unknown');
    assert.strictEqual(r.skip, true);
});
check('label "Mobile number" (type tel) → phone', () => {
    assert.strictEqual(classifyFormField({ label: 'Mobile number', type: 'tel' }).key, 'phone');
});
check('name "phone-number" → phone', () => {
    assert.strictEqual(classifyFormField({ name: 'phone-number', type: 'text' }).key, 'phone');
});
check('label "City" → location', () => {
    assert.strictEqual(classifyFormField({ label: 'City', type: 'text' }).key, 'location');
});
check('label "Current address" → location', () => {
    assert.strictEqual(classifyFormField({ label: 'Current address', type: 'text' }).key, 'location');
});
check('name "linkedinProfile" → linkedin', () => {
    assert.strictEqual(classifyFormField({ name: 'linkedinProfile', type: 'text' }).key, 'linkedin');
});
check('id "github_url" → github', () => {
    assert.strictEqual(classifyFormField({ id: 'github_url', type: 'text' }).key, 'github');
});
check('label "Portfolio website" (type url) → website', () => {
    assert.strictEqual(classifyFormField({ label: 'Portfolio website', type: 'url' }).key, 'website');
});

suite('classifyFormField — cover letter & file inputs');
check('textarea#cover_letter_text → coverLetter', () => {
    assert.strictEqual(classifyFormField({ id: 'cover_letter_text', tag: 'textarea', type: 'textarea' }).key, 'coverLetter');
});
check('textarea placeholder "Anything else you want to tell us?" → coverLetter', () => {
    assert.strictEqual(classifyFormField({ placeholder: 'Anything else you want to tell us?', tag: 'textarea', type: 'textarea' }).key, 'coverLetter');
});
check('file input[name=resume] → resumeFile', () => {
    assert.strictEqual(classifyFormField({ name: 'resume', type: 'file' }).key, 'resumeFile');
});
check('file input[name=cover_letter] → coverLetterFile', () => {
    assert.strictEqual(classifyFormField({ name: 'cover_letter', type: 'file' }).key, 'coverLetterFile');
});
check('generic file input (pdf accept) → resumeFile slot', () => {
    assert.strictEqual(classifyFormField({ type: 'file', accept: '.pdf,.doc' }).key, 'resumeFile');
});
check('photo upload input (image accept) is skipped', () => {
    const r = classifyFormField({ name: 'photo', type: 'file', accept: 'image/*' });
    assert.strictEqual(r.skip, true);
});

suite('classifyFormField — never-fill categories');
check('select[name=gender] → skipped as EEO', () => {
    const r = classifyFormField({ name: 'gender', tag: 'select', type: 'select' });
    assert.strictEqual(r.key, 'unknown');
    assert.strictEqual(r.skip, true);
    assert.strictEqual(r.skipReason, 'eeo');
});
check('label "Veteran status" → skipped as EEO', () => {
    const r = classifyFormField({ label: 'Veteran status', type: 'text' });
    assert.strictEqual(r.skip, true);
    assert.strictEqual(r.skipReason, 'eeo');
});
check('label "Are you of Māori or Pacific descent?" → skipped as EEO', () => {
    assert.strictEqual(classifyFormField({ label: 'Are you of Māori or Pacific descent?', type: 'radio' }).skipReason, 'eeo');
});
check('label "Diversity survey" → skipped as EEO', () => {
    assert.strictEqual(classifyFormField({ label: 'Diversity survey', type: 'text' }).skip, true);
});
check('input[type=password] → skipped (account creation)', () => {
    const r = classifyFormField({ name: 'password', type: 'password' });
    assert.strictEqual(r.key, 'unknown');
    assert.strictEqual(r.skip, true);
    assert.strictEqual(r.skipReason, 'account');
});
check('consent checkbox "I agree to the Terms & Conditions" → skipped', () => {
    const r = classifyFormField({ label: 'I agree to the Terms & Conditions', type: 'checkbox' });
    assert.strictEqual(r.key, 'unknown');
    assert.strictEqual(r.skip, true);
    assert.strictEqual(r.skipReason, 'consent');
});
check('input[type=submit] → never touched', () => {
    const r = classifyFormField({ value: 'Submit', type: 'submit' });
    assert.strictEqual(r.key, 'unknown');
    assert.strictEqual(r.skip, true);
});
check('unrecognised field → unknown but NOT skipped (left for human by the filler)', () => {
    const r = classifyFormField({ name: 'how_did_you_hear', tag: 'select', type: 'select' });
    assert.strictEqual(r.key, 'unknown');
});

// ---------------------------------------------------------------------------
suite('detectApplyPlatform');
check('myworkdayjobs.com URL → workday', () => {
    assert.strictEqual(detectApplyPlatform('https://wework.wd1.myworkdayjobs.com/en-US/WExternalSite/job/Software-Engineer_R12345'), 'workday');
});
check('boards.greenhouse.io URL → greenhouse', () => {
    assert.strictEqual(detectApplyPlatform('https://boards.greenhouse.io/acme/jobs/123456'), 'greenhouse');
});
check('greenhouse embed URL → greenhouse', () => {
    assert.strictEqual(detectApplyPlatform('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=tok'), 'greenhouse');
});
check('jobs.lever.co URL → lever', () => {
    assert.strictEqual(detectApplyPlatform('https://jobs.lever.co/acme/8a2f1b0c-1234'), 'lever');
});
check('seek.co.nz URL → seek', () => {
    assert.strictEqual(detectApplyPlatform('https://www.seek.co.nz/job/94121243'), 'seek');
});
check('seek.com.au URL → seek', () => {
    assert.strictEqual(detectApplyPlatform('https://www.seek.com.au/job/94121243'), 'seek');
});
check('random company careers page → generic', () => {
    assert.strictEqual(detectApplyPlatform('https://careers.acme.com/openings/senior-engineer'), 'generic');
});
check('invalid URL → generic', () => {
    assert.strictEqual(detectApplyPlatform('not a url at all'), 'generic');
});

// ---------------------------------------------------------------------------
suite('buildFormValueMap');
const profile = {
    name: 'MAGHAV AHUJA',
    contact: {
        email: 'maghav@example.com',
        phone: '+64 (022) 807-9079',
        location: 'Auckland, New Zealand',
        linkedin: 'linkedin.com/in/maghavahuja',
    },
};
check('splits name into first/last and title-cases it', () => {
    const vm = buildFormValueMap(profile);
    assert.strictEqual(vm.fullName, 'Maghav Ahuja');
    assert.strictEqual(vm.firstName, 'Maghav');
    assert.strictEqual(vm.lastName, 'Ahuja');
});
check('maps contact fields', () => {
    const vm = buildFormValueMap(profile);
    assert.strictEqual(vm.email, 'maghav@example.com');
    assert.strictEqual(vm.phone, '+64 (022) 807-9079');
    assert.strictEqual(vm.location, 'Auckland, New Zealand');
    assert.strictEqual(vm.linkedin, 'linkedin.com/in/maghavahuja');
});
check('missing contact fields are omitted, never empty strings', () => {
    const vm = buildFormValueMap(profile);
    assert(!('github' in vm), 'github should be absent');
    assert(!('website' in vm), 'website should be absent');
    assert(!('coverLetter' in vm), 'coverLetter should be absent without extras');
    for (const [k, v] of Object.entries(vm)) assert.notStrictEqual(v, '', `${k} must not be empty`);
});
check('coverLetterText extra is included', () => {
    const vm = buildFormValueMap(profile, { coverLetterText: 'Dear Hiring Team' });
    assert.strictEqual(vm.coverLetter, 'Dear Hiring Team');
});
check('empty/absent profile yields an empty map without throwing', () => {
    assert.deepStrictEqual(buildFormValueMap(null), {});
    assert.deepStrictEqual(buildFormValueMap({}), {});
});

// ---------------------------------------------------------------------------
suite('markdownToPlainText');
check('strips ATX headers', () => {
    assert.strictEqual(markdownToPlainText('# Heading\nBody text'), 'Heading\nBody text');
});
check('strips bold and italic markers', () => {
    assert.strictEqual(markdownToPlainText('**bold** and *italic*'), 'bold and italic');
});
check('strips bullet markers', () => {
    assert.strictEqual(markdownToPlainText('- one\n- two\n* three'), 'one\ntwo\nthree');
});
check('strips links, keeping the label', () => {
    assert.strictEqual(markdownToPlainText('See [my portfolio](https://example.com) here'), 'See my portfolio here');
});
check('handles a realistic cover letter block', () => {
    const md = '## Re: Platform Engineer\n\nDear Hiring Team,\n\nI build **resilient** systems:\n- Linux\n- AWS\n\n[My website](https://portfolio.onl9.club)';
    assert.strictEqual(
        markdownToPlainText(md),
        'Re: Platform Engineer\n\nDear Hiring Team,\n\nI build resilient systems:\nLinux\nAWS\n\nMy website'
    );
});
check('null/empty input returns empty string', () => {
    assert.strictEqual(markdownToPlainText(null), '');
    assert.strictEqual(markdownToPlainText(''), '');
});

console.log(`\nAll ${count} form autofill checks passed.`);
