#!/usr/bin/env node
/**
 * Semi-Automatic Application Form Autofill
 *
 * After the pipeline generates the CV + cover letter PDFs, this module opens a
 * VISIBLE (non-headless) browser at the job posting, pre-fills the application
 * form from candidate_profile.json, attaches the generated PDFs — then STOPS
 * and lets a human review and click Submit.
 *
 * Safety model (non-negotiable):
 *  - NEVER clicks submit unless env AUTO_SUBMIT=true AND CLI --submit are BOTH set.
 *  - NEVER fills EEO/diversity survey fields, consent checkboxes, or account
 *    creation/password fields — those are logged and left for the human.
 *  - 90s per-action watchdog: a hanging selector is logged and skipped, the
 *    remaining fields still get filled.
 *
 * Env vars (all optional, see .env.example):
 *  AUTO_APPLY                    — pipeline integration switch (OFF by default)
 *  AUTO_SUBMIT                   — gated submit click (NEVER enable casually)
 *  AUTOFILL_LOGIN_WAIT_SECONDS   — how long to wait for manual sign-in (default 180)
 *  AUTOFILL_REVIEW_WAIT_SECONDS  — how long to keep the browser open for review (default 300, 0 = close immediately)
 *
 * CLI:
 *  node form_autofill.js <jobLink> [--cv <path>] [--cl <path>] [--submit] [--no-wait]
 */

const fs = require('fs');
const path = require('path');

// Load .env if present (mirrors job_application_pipeline.js hand-parsing)
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        for (const line of envContent.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const k = trimmed.substring(0, eq).trim();
            let v = trimmed.substring(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
            if (process.env[k] === undefined) process.env[k] = v;
        }
    }
} catch (_) {}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PER_ACTION_WATCHDOG_MS = 90000;

// Reuse pipeline internals lazily (avoids a require cycle at load time and keeps
// `node tests/...` from loading the whole pipeline just for the pure helpers).
function pipelineInternals() {
    try { return require('./job_application_pipeline')._internals || {}; } catch (_) { return {}; }
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Pure helpers (no DOM, no network — covered by tests/test_form_autofill.js)
// ---------------------------------------------------------------------------

function markdownToPlainText(text) {
    if (!text) return '';
    return String(text)
        .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
        .replace(/```/g, '')
        .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
        .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s{0,3}[-*+]\s+/gm, '')
        .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
        .replace(/(\*\*|__)(.*?)\1/g, '$2')
        .replace(/(\*|_)([^*_\n]+)\1/g, '$2')
        .replace(/`([^`\n]*)`/g, '$1')
        .replace(/~~(.*?)~~/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Map candidate_profile.json facts onto canonical form field keys.
 * Missing values are omitted entirely (never empty strings) so the filler
 * leaves those fields untouched for the human to complete.
 */
function buildFormValueMap(profile, extras = {}) {
    const out = {};
    const contact = (profile && profile.contact) || {};
    const titleCase = (s) => String(s).toLowerCase().replace(/(^|\s|[-'.])([a-z])/g, (_, p, c) => p + c.toUpperCase());

    const name = String((profile && profile.name) || '').trim();
    if (name) {
        out.fullName = titleCase(name);
        const parts = name.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
            out.firstName = titleCase(parts[0]);
            out.lastName = titleCase(parts[parts.length - 1]);
        }
    }
    if (contact.email) out.email = String(contact.email).trim();
    if (contact.phone) out.phone = String(contact.phone).trim();
    if (contact.location) out.location = String(contact.location).trim();
    if (contact.linkedin) out.linkedin = String(contact.linkedin).trim();
    if (contact.github) out.github = String(contact.github).trim();
    if (contact.website || contact.portfolio) out.website = String(contact.website || contact.portfolio).trim();
    if (extras.coverLetterText) out.coverLetter = String(extras.coverLetterText);
    return out;
}

const EEO_RE = /\beeo\b|diversit|ethnic|gender|\brace\b|racial|veteran|disabilit|sexual orientation|gender identity|self.?identif|survey|accommodation|\bmaori\b|pasifika|pacific descent|deemed|underrepresented/i;
const ACCOUNT_RE = /password|passcode|create (an )?account|new account|sign ?up for|register( an)? account|username/i;
const CONSENT_RE = /consent|agree|agreement|terms|privacy|permission|opt.?in|subscri|newsletter|marketing|notification|updates|alerts?|contact(ed)? (me|by)|text me|receive|communication|sms/i;
const NOTIFICATION_RE = /notification|subscri|newsletter|updates|marketing|alerts?|opt.?in|confirm|verify/i;
const NOT_NAME_RE = /\bprefer|choice|option|rank|order|select|choose|heard|referral|referr|source\b|date|when\b|where did|company|organisation|organization|employer|school|university|manager|supervisor|recruiter|agency/i;
const NOT_ADDRESS_RE = /\bline\b|street|zip|postal|postcode|\bstate\b|province|\bcounty\b/i;

/**
 * Classify a form field descriptor into a canonical key.
 *
 * @param {{ name?, id?, label?, placeholder?, ariaLabel?, type?, tag?, dataAutomationId?, accept? }} info
 * @returns {{ key: string, skip: boolean, skipReason: string|null }}
 *   key ∈ firstName|lastName|fullName|email|phone|location|linkedin|github|website|
 *         coverLetter|resumeFile|coverLetterFile|unknown
 *   skip=true marks fields that must NEVER be auto-filled (EEO, consent, account,
 *   submit, selects/choices) — they are logged and left for human review.
 */
function classifyFormField(info = {}) {
    const type = String(info.type || '').toLowerCase();
    const tag = String(info.tag || (type ? 'input' : '')).toLowerCase();
    const norm = (v) => String(v || '').toLowerCase().replace(/[_\-–—/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
    const text = [info.label, info.name, info.id, info.ariaLabel, info.placeholder, info.dataAutomationId]
        .map(norm).filter(Boolean).join(' ');
    const t = ` ${text} `;

    // 1. Never-fill categories — checked before any value matching.
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
        return { key: 'unknown', skip: true, skipReason: 'button' };
    }
    if (type === 'password' || type === 'hidden') {
        return { key: 'unknown', skip: true, skipReason: type === 'hidden' ? 'hidden' : 'account' };
    }
    if (ACCOUNT_RE.test(text)) return { key: 'unknown', skip: true, skipReason: 'account' };
    if (EEO_RE.test(text)) return { key: 'unknown', skip: true, skipReason: 'eeo' };
    if (tag === 'select' || type === 'select') return { key: 'unknown', skip: true, skipReason: 'select-choice' };
    if (type === 'checkbox' || type === 'radio') {
        return { key: 'unknown', skip: true, skipReason: CONSENT_RE.test(text) ? 'consent' : 'choice' };
    }

    // 2. File inputs.
    if (type === 'file') {
        const accept = String(info.accept || '').toLowerCase();
        if (/cover\s?letter|\bcl\b/.test(text)) return { key: 'coverLetterFile', skip: false, skipReason: null };
        if (/resume|\bcv\b/.test(text)) return { key: 'resumeFile', skip: false, skipReason: null };
        if (accept && /image|jpg|jpeg|png|gif/.test(accept) && !/pdf|doc/.test(accept)) {
            return { key: 'unknown', skip: true, skipReason: 'file-type' };
        }
        // Generic upload slot — treated as the resume slot (first file input gets the CV).
        return { key: 'resumeFile', skip: false, skipReason: null };
    }

    // 3. Strong type hints.
    if (type === 'email') return { key: 'email', skip: false, skipReason: null };
    if (type === 'tel') return { key: 'phone', skip: false, skipReason: null };

    // 4. Keyword matching, most specific first.
    if (/\be-?mail\b/.test(t) && !NOTIFICATION_RE.test(text)) return { key: 'email', skip: false, skipReason: null };
    if (/phone|mobile|cell\b|telephone|contact number|\btel\b|\bph\b/.test(t)) return { key: 'phone', skip: false, skipReason: null };
    if (/linkedin/.test(t)) return { key: 'linkedin', skip: false, skipReason: null };
    if (/git ?hub/.test(t)) return { key: 'github', skip: false, skipReason: null };
    if (/website|portfolio|\burl\b|personal (site|page)|\bblog\b|github pages/.test(t)) return { key: 'website', skip: false, skipReason: null };
    if (NOT_NAME_RE.test(t)) {
        // "Preferred location", "Company name", "Referral source"… leave alone.
    } else if (/first\s?name|given name|\bfname\b|\bfirst\b/.test(t)) {
        return { key: 'firstName', skip: false, skipReason: null };
    } else if (/last\s?name|surname|family name|\blname\b|\blast\b/.test(t)) {
        return { key: 'lastName', skip: false, skipReason: null };
    } else if (/full name|your name|\bname\b/.test(t)) {
        return { key: 'fullName', skip: false, skipReason: null };
    }
    if (/\blocation\b|\bcity\b|suburb|\btown\b|current address|\baddress\b/.test(t) && !(NOT_ADDRESS_RE.test(text) && /address/.test(text))) {
        return { key: 'location', skip: false, skipReason: null };
    }
    if (tag === 'textarea' || type === 'textarea' || type === 'text' || !type) {
        if (/cover\s?letter|why do you want|why are you (interested|applying)|what makes you|motivation|personal statement|additional (information|comments|details)|anything else|\bcomments?\b|\bmessage\b/.test(t)) {
            return { key: 'coverLetter', skip: false, skipReason: null };
        }
    }
    return { key: 'unknown', skip: false, skipReason: null };
}

/**
 * Map an application URL onto a platform adapter key.
 * @returns {'workday'|'greenhouse'|'lever'|'seek'|'generic'}
 */
function detectApplyPlatform(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.includes('myworkdayjobs.com') || host.includes('myworkdaysite.com') || /(^|\.)wd\d+\./.test(host)) return 'workday';
        if (host.includes('greenhouse.io')) return 'greenhouse';
        if (host.includes('lever.co')) return 'lever';
        if (host.includes('seek.co.nz') || host.includes('seek.com.au')) return 'seek';
        return 'generic';
    } catch (_) {
        return 'generic';
    }
}

// ---------------------------------------------------------------------------
// DOM helpers (all wrapped in watchdogs by the callers)
// ---------------------------------------------------------------------------

async function collectFieldDescriptors(page) {
    return page.evaluate(() => {
        const visible = (el) => {
            try {
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
                const rect = el.getBoundingClientRect();
                return !(rect.width < 2 && rect.height < 2);
            } catch (_) { return false; }
        };
        const resolveLabel = (el) => {
            let text = '';
            try {
                const idAttr = el.getAttribute('id');
                if (idAttr) {
                    const esc = (window.CSS && CSS.escape) ? CSS.escape(idAttr) : idAttr;
                    const lbl = document.querySelector(`label[for="${esc}"]`);
                    if (lbl) text = ((lbl.innerText || lbl.textContent) || '').trim();
                }
                if (!text) {
                    const wrap = el.closest('label');
                    if (wrap) text = ((wrap.innerText || wrap.textContent) || '').trim();
                }
                if (!text) {
                    const labelledBy = el.getAttribute('aria-labelledby');
                    if (labelledBy) {
                        text = labelledBy.split(/\s+/)
                            .map((i) => { const n = document.getElementById(i); return n ? ((n.innerText || n.textContent) || '') : ''; })
                            .join(' ').trim();
                    }
                }
                if (!text) {
                    // Workday-style layouts: label sits in a sibling block above the input.
                    let node = el.closest('[data-automation-id]') || el.parentElement;
                    for (let hop = 0; node && hop < 3; hop++) {
                        const sib = node.previousElementSibling;
                        if (sib) {
                            const cand = ((sib.innerText || sib.textContent) || '').trim();
                            if (cand && cand.length <= 120) { text = cand; break; }
                        }
                        node = node.parentElement;
                    }
                }
            } catch (_) {}
            return (text || '').replace(/\s+/g, ' ').slice(0, 200);
        };

        const out = [];
        let idx = 0;
        for (const el of document.querySelectorAll('input, textarea, select')) {
            if (el.type === 'hidden' || el.disabled || el.readOnly) continue;
            if (!visible(el)) continue;
            const dIdx = idx++;
            el.setAttribute('data-autofill-idx', String(dIdx));
            out.push({
                idx: dIdx,
                tag: el.tagName.toLowerCase(),
                type: el.tagName.toLowerCase() === 'input' ? (el.type || 'text') : el.tagName.toLowerCase(),
                name: el.getAttribute('name') || '',
                id: el.getAttribute('id') || '',
                placeholder: el.getAttribute('placeholder') || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                label: resolveLabel(el),
                dataAutomationId: el.getAttribute('data-automation-id') || '',
                accept: el.getAttribute('accept') || '',
                required: Boolean(el.required),
            });
        }
        return out;
    });
}

function describeField(d) {
    const bits = [d.tag];
    if (d.id) bits.push(`#${d.id}`);
    if (d.name) bits.push(`[name=${d.name}]`);
    const label = d.label || d.placeholder || d.ariaLabel || '';
    if (label) bits.push(`"${String(label).slice(0, 40)}"`);
    return bits.join(' ');
}

function truncateValue(v) {
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

async function fillTextField(handle, value) {
    await handle.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const isContentEditable = await handle.evaluate((el) => el.isContentEditable === true);
    if (isContentEditable) {
        await handle.evaluate((el, v) => {
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(value));
        return;
    }
    await handle.evaluate((el, v) => {
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, v); else el.value = v;
        el.focus();
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
    }, String(value));
}

async function uploadToInput(handle, filePath) {
    await handle.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await handle.uploadFile(filePath);
    await handle.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

/** Race any action against a 90s watchdog; on timeout log a warning and continue. */
async function withWatchdog(promise, label, ms = PER_ACTION_WATCHDOG_MS) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve(promise),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`watchdog: ${label} timed out after ${ms}ms`)), ms); }),
        ]);
    } catch (e) {
        console.log(`[autofill] Warning: ${e.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// Login wall detection & manual sign-in wait
// ---------------------------------------------------------------------------

const LOGIN_PHRASES = [
    'sign in to apply', 'sign in to continue', 'sign in to view', 'log in to apply', 'log in to continue',
    'login to apply', 'login to continue', 'create an account to apply', 'create an account to continue',
    'please sign in', 'please log in', 'sign up to apply',
];

async function detectLoginWall(page) {
    try {
        const url = page.url();
        if (/authwall|\/(sign-?in|login|auth)(\/|$|\?)|checkpoint/i.test(url)) {
            return { detected: true, marker: `redirected to auth page (${url})` };
        }
        return await page.evaluate((phrases) => {
            const bodyText = ((document.body && document.body.innerText) || '').toLowerCase().slice(0, 6000);
            for (const p of phrases) {
                if (bodyText.includes(p)) return { detected: true, marker: `page text "${p}"` };
            }
            const pw = document.querySelectorAll('input[type="password"]').length;
            const textish = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea').length;
            if (pw > 0 && textish === 0) return { detected: true, marker: 'password-only form' };
            return { detected: false, marker: null };
        }, LOGIN_PHRASES);
    } catch (_) {
        return { detected: false, marker: null };
    }
}

/**
 * If a login wall is present, print guidance and poll until the human signs in
 * (up to waitSeconds). Returns 'clear' | 'timeout'.
 */
async function handleLoginWall(page, waitSeconds, warnings) {
    let check = await detectLoginWall(page);
    if (!check.detected) return 'clear';

    console.log(`[autofill] Login wall detected (${check.marker}).`);
    console.log('[autofill] >>> Please sign in inside the opened browser window. Autofill will continue automatically once you are in. <<<');
    warnings.push(`Login wall detected (${check.marker}) — waiting up to ${waitSeconds}s for manual sign-in`);

    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        check = await detectLoginWall(page).catch(() => ({ detected: true }));
        if (!check.detected) {
            console.log('[autofill] Sign-in complete — continuing with form filling...');
            await new Promise((r) => setTimeout(r, 1500));
            return 'clear';
        }
    }
    warnings.push(`Login still required after ${waitSeconds}s — application form was not filled`);
    console.log(`[autofill] Timed out after ${waitSeconds}s waiting for sign-in. Finish the application manually at: ${page.url()}`);
    return 'timeout';
}

// ---------------------------------------------------------------------------
// Shared heuristic filler
// ---------------------------------------------------------------------------

async function runHeuristicFill(ctx) {
    const { page, valueMap, cvPdfPath, clPdfPath, filledFields, attachedFiles, skippedFields, warnings } = ctx;
    const descriptors = (await withWatchdog(collectFieldDescriptors(page), 'collect form fields')) || [];
    console.log(`[autofill] Found ${descriptors.length} visible form field(s) on ${page.url()}`);

    let resumeAttached = attachedFiles.some((f) => f.input === 'resume');
    let clAttached = attachedFiles.some((f) => f.input === 'coverLetter');
    let clFilled = false;

    for (const d of descriptors) {
        const cls = classifyFormField(d);
        const hint = describeField(d);
        if (cls.skip) {
            skippedFields.push(`${hint} [${cls.skipReason}]`);
            console.log(`[autofill] Skipping ${hint} (${cls.skipReason}) — left for human review`);
            continue;
        }
        if (cls.key === 'unknown') continue;
        const isFileSlot = cls.key === 'resumeFile' || cls.key === 'coverLetterFile';
        if (!isFileSlot && !valueMap[cls.key]) {
            console.log(`[autofill] No candidate value for ${cls.key} on ${hint} — left empty for human review`);
            continue;
        }

        const handle = await page.$(`[data-autofill-idx="${d.idx}"]`);
        if (!handle) continue;

        try {
            if (cls.key === 'resumeFile' || cls.key === 'coverLetterFile') {
                let which = cls.key === 'coverLetterFile' ? 'coverLetter' : 'resume';
                let filePath = which === 'resume' ? cvPdfPath : clPdfPath;
                if (which === 'resume' && (resumeAttached || !filePath)) {
                    // A second distinct upload slot — put the cover letter there.
                    if (!clAttached && clPdfPath) { which = 'coverLetter'; filePath = clPdfPath; } else { continue; }
                }
                if (which === 'coverLetter' && (clAttached || !filePath)) continue;
                await withWatchdog(uploadToInput(handle, filePath), `upload ${which} to ${hint}`);
                attachedFiles.push({ input: which, path: filePath, field: hint });
                if (which === 'resume') resumeAttached = true; else clAttached = true;
                console.log(`[autofill] Attached ${which} PDF → ${hint}`);
            } else {
                if (cls.key === 'coverLetter') {
                    if (clFilled) continue; // never spray the same letter into every textarea
                    clFilled = true;
                }
                const value = valueMap[cls.key];
                await withWatchdog(fillTextField(handle, value), `fill ${cls.key} on ${hint}`);
                filledFields.push(`${cls.key}: ${truncateValue(value)} (${hint})`);
                console.log(`[autofill] Filled ${cls.key} → ${hint}`);
            }
        } catch (e) {
            warnings.push(`Could not fill ${cls.key} on ${hint}: ${e.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Platform adapters
// ---------------------------------------------------------------------------

async function clickApplyButton(page, selectors, warnings) {
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (!btn) continue;
            const clickable = await btn.evaluate((el) => {
                const s = window.getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return !(s.display === 'none' || s.visibility === 'hidden' || el.disabled) && r.width > 1 && r.height > 1;
            });
            if (!clickable) continue;
            await withWatchdog(btn.click({ delay: 40 }), `click ${sel}`, 30000);
            await new Promise((r) => setTimeout(r, 3000));
            return { clicked: true };
        } catch (_) {}
    }
    return { clicked: false };
}

async function resolveActivePage(browser, page) {
    try {
        const pages = await browser.pages();
        const last = pages[pages.length - 1];
        if (last && last !== page) {
            await last.bringToFront().catch(() => {});
            return last;
        }
    } catch (_) {}
    return page;
}

async function adaptWorkday(ctx) {
    const { page, warnings, loginWaitSeconds } = ctx;
    const parsed = pipelineInternals().parseWorkdayUrl ? pipelineInternals().parseWorkdayUrl(page.url()) : null;
    if (parsed) console.log(`[autofill] Workday tenant="${parsed.tenant}" site="${parsed.site}" job="${parsed.slug}"`);

    if (!/\/apply(\/|$|\?)|\/job\//i.test(page.url()) || !/\/apply(\/|$|\?)/i.test(page.url())) {
        const { clicked } = await clickApplyButton(page, [
            '[data-automation-id="applyButton"]',
            'button[data-automation-id="applyButton"]',
            'a[data-automation-id="applyButton"]',
        ], warnings);
        if (clicked) {
            ctx.page = await resolveActivePage(ctx.browser, page);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    const wall = await handleLoginWall(ctx.page, loginWaitSeconds, warnings);
    if (wall === 'timeout') { ctx.loginTimedOut = true; return; }

    // Workday renders its apply form client-side — wait for real inputs to appear.
    await ctx.page.waitForFunction(
        () => document.querySelectorAll('input:not([type=hidden]), textarea').length >= 2,
        { timeout: 15000 }
    ).catch(() => {});
    await runHeuristicFill(ctx);
    console.log('[autofill] Workday applications are multi-step — fill/review the remaining steps manually.');
}

async function adaptGreenhouse(ctx) {
    const { loginWaitSeconds, warnings } = ctx;
    await ctx.page.waitForSelector('#application_form, form', { timeout: 10000 }).catch(() => {});
    const wall = await handleLoginWall(ctx.page, loginWaitSeconds, warnings);
    if (wall === 'timeout') { ctx.loginTimedOut = true; return; }
    await runHeuristicFill(ctx);
}

async function adaptLever(ctx) {
    const { page, loginWaitSeconds, warnings } = ctx;
    const formPresent = await page.$('input[name="email"], input[name="name"], input[type="file"]');
    if (!formPresent) {
        const { clicked } = await clickApplyButton(page, [
            'a.apply', '.apply-button', 'button[data-test="apply-button"]', 'a[data-qa="show-apply-form"]',
        ], warnings);
        if (clicked) {
            ctx.page = await resolveActivePage(ctx.browser, page);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    const wall = await handleLoginWall(ctx.page, loginWaitSeconds, warnings);
    if (wall === 'timeout') { ctx.loginTimedOut = true; return; }
    await runHeuristicFill(ctx);
}

async function adaptSeek(ctx) {
    const { page, loginWaitSeconds, warnings } = ctx;
    const { clicked } = await clickApplyButton(page, [
        '[data-automation="job-detail-apply"]',
        'a[data-automation="job-detail-apply"]',
        '[data-automation="apply"]',
    ], warnings);
    if (clicked) {
        ctx.page = await resolveActivePage(ctx.browser, page);
        await new Promise((r) => setTimeout(r, 2000));
        console.log(`[autofill] Followed Apply button to: ${ctx.page.url()}`);
    }
    const wall = await handleLoginWall(ctx.page, loginWaitSeconds, warnings);
    if (wall === 'timeout') { ctx.loginTimedOut = true; return; }
    await runHeuristicFill(ctx);
}

async function adaptGeneric(ctx) {
    const { loginWaitSeconds, warnings } = ctx;
    const wall = await handleLoginWall(ctx.page, loginWaitSeconds, warnings);
    if (wall === 'timeout') { ctx.loginTimedOut = true; return; }
    await runHeuristicFill(ctx);
}

const ADAPTERS = { workday: adaptWorkday, greenhouse: adaptGreenhouse, lever: adaptLever, seek: adaptSeek, generic: adaptGeneric };

// ---------------------------------------------------------------------------
// Review wait & gated submit
// ---------------------------------------------------------------------------

function waitForEnter(timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { process.stdin.pause(); } catch (_) {}
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        process.stdin.resume();
        process.stdin.once('data', finish);
    });
}

async function waitForBrowserReview(seconds) {
    const ms = Math.max(0, seconds) * 1000;
    if (ms === 0) return;
    if (process.stdin && process.stdin.isTTY) {
        console.log(`\n⏸  Browser left open for your review. Press Enter here when done (auto-continues in ${seconds}s).`);
        await waitForEnter(ms);
    } else {
        console.log(`\n⏸  Browser left open for your review (non-interactive session — continuing automatically in ${seconds}s).`);
        await new Promise((r) => setTimeout(r, ms));
    }
}

async function clickSubmitButton(page, warnings) {
    try {
        const handle = await page.evaluateHandle(() => {
            const re = /^(submit|apply)( application| now| your application)?$/i;
            const candidates = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"], button, a'));
            return candidates.find((el) => {
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden' || el.disabled) return false;
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const text = String(el.innerText || el.value || '').trim();
                return re.test(text) || el.type === 'submit';
            });
        });
        const el = handle.asElement();
        if (!el) { warnings.push('Auto-submit: no submit button found'); return false; }
        await el.click();
        await new Promise((r) => setTimeout(r, 2000));
        console.log('[autofill] Submit button clicked (AUTO_SUBMIT mode).');
        return true;
    } catch (e) {
        warnings.push(`Auto-submit failed: ${e.message}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Semi-automatically fill the job's online application form.
 *
 * @param {{ jobLink: string, cvPdfPath?: string, clPdfPath?: string, options?: object }} args
 * options: { submit, noWait, coverLetterText, outputDir, reviewWaitSeconds, loginWaitSeconds }
 * @returns {Promise<{ok, platform, filledFields, attachedFiles, skippedFields, submitted, screenshotPath, warnings, reason, browserUrl}>}
 */
async function autofillApplication({ jobLink, cvPdfPath, clPdfPath, options = {} }) {
    const warnings = [];
    const filledFields = [];
    const attachedFiles = [];
    const skippedFields = [];
    const result = {
        ok: false,
        platform: detectApplyPlatform(jobLink || ''),
        filledFields, attachedFiles, skippedFields,
        submitted: false,
        screenshotPath: null,
        warnings,
        reason: null,
        browserUrl: null,
    };

    if (!jobLink) {
        result.reason = 'missing_job_link';
        warnings.push('No job link provided');
        return result;
    }
    if (cvPdfPath && !fs.existsSync(cvPdfPath)) {
        warnings.push(`CV PDF not found: ${cvPdfPath} — resume upload slots will be left for manual attach`);
        cvPdfPath = null;
    }
    if (clPdfPath && !fs.existsSync(clPdfPath)) {
        warnings.push(`Cover letter PDF not found: ${clPdfPath} — will be left for manual attach`);
        clPdfPath = null;
    }
    if (!cvPdfPath) warnings.push('No CV PDF available — file inputs are left for the human');

    let profile;
    try {
        profile = JSON.parse(fs.readFileSync(path.join(__dirname, 'candidate_profile.json'), 'utf8'));
    } catch (e) {
        result.reason = 'profile_unreadable';
        result.error = e.message;
        warnings.push(`Could not read candidate_profile.json: ${e.message}`);
        return result;
    }

    let coverLetterText = options.coverLetterText || '';
    if (!coverLetterText) {
        try { coverLetterText = fs.readFileSync(path.join(__dirname, 'output', 'cover_letter.md'), 'utf8'); } catch (_) {}
    }
    const valueMap = buildFormValueMap(profile, {
        coverLetterText: coverLetterText ? markdownToPlainText(coverLetterText) : null,
    });

    const loginWaitSeconds = options.loginWaitSeconds != null
        ? options.loginWaitSeconds
        : parseInt(process.env.AUTOFILL_LOGIN_WAIT_SECONDS || '180', 10);

    const puppeteer = require('puppeteer');
    const baseLaunch = pipelineInternals().getBrowserLaunchOptions ? pipelineInternals().getBrowserLaunchOptions() : { args: [] };
    const browser = await puppeteer.launch({
        ...baseLaunch,
        headless: false, // always visible — this is a human-in-the-loop feature
        args: [...(baseLaunch.args || []), '--start-maximized'],
    });

    const page = await browser.newPage();
    const ctx = {
        browser, page, valueMap, cvPdfPath, clPdfPath,
        filledFields, attachedFiles, skippedFields, warnings,
        loginWaitSeconds, loginTimedOut: false,
    };

    try {
        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: 1380, height: 940 });
        console.log(`[autofill] Opening ${jobLink} (platform: ${result.platform}) in a visible browser...`);
        await page.goto(jobLink, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise((r) => setTimeout(r, 1500));

        const adapter = ADAPTERS[result.platform] || adaptGeneric;
        await withWatchdog(adapter(ctx), `platform adapter (${result.platform})`, 300000);

        if (ctx.loginTimedOut) {
            result.reason = 'login_required';
            result.browserUrl = page.url();
            return result;
        }

        if (!filledFields.length && !attachedFiles.length) {
            warnings.push('No matching form fields were found — the application form may be multi-step, behind a button, or site-specific. Complete it manually in the browser.');
        }

        const outputDir = options.outputDir || path.join(__dirname, 'output');
        ensureDir(outputDir);
        result.screenshotPath = path.join(outputDir, 'autofill_state.png');
        await withWatchdog(page.screenshot({ path: result.screenshotPath, fullPage: true }), 'save screenshot', 30000);

        const autoSubmit = String(process.env.AUTO_SUBMIT || '').trim().toLowerCase() === 'true' && options.submit === true;
        if (autoSubmit) {
            console.log('[autofill] AUTO_SUBMIT=true with --submit — clicking the submit button...');
            result.submitted = await clickSubmitButton(page, warnings);
        } else {
            if (options.submit) warnings.push('--submit ignored: AUTO_SUBMIT env var is not enabled (safety gate)');
            console.log('\n✅ Autofill finished. Review the form and click Submit yourself — nothing was submitted.');
        }

        if (!options.noWait) {
            const reviewSeconds = options.reviewWaitSeconds != null
                ? options.reviewWaitSeconds
                : parseInt(process.env.AUTOFILL_REVIEW_WAIT_SECONDS || '300', 10);
            await waitForBrowserReview(reviewSeconds);
        }

        result.ok = true;
        return result;
    } catch (e) {
        warnings.push(`Fatal autofill error: ${e.message}`);
        result.reason = 'error';
        result.error = e.message;
        try {
            const outputDir = options.outputDir || path.join(__dirname, 'output');
            ensureDir(outputDir);
            result.screenshotPath = path.join(outputDir, 'autofill_state.png');
            await page.screenshot({ path: result.screenshotPath });
        } catch (_) {}
        return result;
    } finally {
        await browser.close().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function findNewestOutputPdf(suffixPattern) {
    const dir = path.join(__dirname, 'output');
    try {
        const files = fs.readdirSync(dir)
            .filter((f) => suffixPattern.test(f))
            .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m);
        return files.length ? path.join(dir, files[0].f) : null;
    } catch (_) {
        return null;
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (!args[0] || args.includes('--help') || args.includes('-h')) {
        console.log('Usage: node form_autofill.js <jobLink> [--cv <path>] [--cl <path>] [--submit] [--no-wait]');
        console.log('');
        console.log('  jobLink:    job posting / application URL');
        console.log('  --cv:       CV PDF to attach (default: newest *_CV.pdf in output/)');
        console.log('  --cl:       Cover letter PDF to attach (default: newest *_CL.pdf in output/)');
        console.log('  --submit:   allow clicking Submit — ONLY effective when env AUTO_SUBMIT=true');
        console.log('  --no-wait:  close the browser immediately after filling (skip review wait)');
        process.exit(args[0] ? 0 : 1);
    }

    const jobLink = args[0];
    const optVal = (name) => {
        const i = args.indexOf(name);
        return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
    };
    const cvPdfPath = optVal('--cv') || findNewestOutputPdf(/_CV\.pdf$/i);
    const clPdfPath = optVal('--cl') || findNewestOutputPdf(/_CL\.pdf$/i);

    if (!cvPdfPath) console.log('[autofill] Warning: no CV PDF found in output/ — attach it manually.');
    if (!clPdfPath) console.log('[autofill] Warning: no cover letter PDF found in output/ — attach it manually.');

    autofillApplication({
        jobLink,
        cvPdfPath,
        clPdfPath,
        options: {
            submit: args.includes('--submit'),
            noWait: args.includes('--no-wait'),
        },
    }).then((r) => {
        console.log('\nAutofill result:');
        console.log(JSON.stringify({
            ok: r.ok,
            platform: r.platform,
            filledFields: r.filledFields,
            attachedFiles: r.attachedFiles,
            skippedFields: r.skippedFields,
            submitted: r.submitted,
            screenshotPath: r.screenshotPath,
            reason: r.reason,
            warnings: r.warnings,
        }, null, 2));
        process.exit(r.ok ? 0 : (r.reason === 'login_required' ? 2 : 1));
    }).catch((err) => {
        console.error('[autofill] Fatal:', err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    });
}

module.exports = { autofillApplication, buildFormValueMap, classifyFormField, detectApplyPlatform, markdownToPlainText };
