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
 * Reachability model:
 *  - Forms rendered client-side are waited for (SPA boards).
 *  - Fields are collected and filled across ALL frames, so application forms
 *    embedded in cross-origin iframes (custom-domain Greenhouse/Lever boards,
 *    e.g. jobs.elastic.co) are filled too.
 *  - If a page has no form at all, the visible non-nav "Apply" CTA is followed
 *    ONCE to reach the embed page (custom-domain pattern), then filling retries.
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
 * @returns {'workday'|'greenhouse'|'lever'|'seek'|'sap'|'generic'}
 */
function detectApplyPlatform(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.includes('myworkdayjobs.com') || host.includes('myworkdaysite.com') || /(^|\.)wd\d+\./.test(host)) return 'workday';
        if (host.includes('greenhouse.io')) return 'greenhouse';
        if (host.includes('lever.co')) return 'lever';
        if (host.includes('seek.co.nz') || host.includes('seek.com.au')) return 'seek';
        // SAP SuccessFactors career sites (SAP's own board + tenant instances)
        if (host === 'careers.sap.com' || host.includes('successfactors.com') || host.includes('sapsf.com')) return 'sap';
        return 'generic';
    } catch (_) {
        return 'generic';
    }
}

/**
 * Junk frames (analytics, captcha shims, about:blank) never hold application forms.
 * Pure — unit-tested.
 */
function isUsableFormFrameUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (/^(about:|data:|chrome:)/i.test(url)) return false;
    return !/(recaptcha|googleapis\.com\/static\/proxy|doubleclick\.net|company-target\.com|googletagmanager\.com|addthis\.com|adservice\.)/i.test(url);
}

/**
 * Resolve a CTA href (possibly relative) to an absolute URL. Hash-only links
 * ("#", "#/", "#apply") are SPA routing noise, not form destinations → null.
 * Pure — unit-tested.
 */
function resolveCtaHref(href, baseUrl) {
    if (!href || typeof href !== 'string') return null;
    const trimmed = href.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return null;
    try {
        return new URL(trimmed, baseUrl).href;
    } catch (_) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// DOM helpers (all wrapped in watchdogs by the callers)
// ---------------------------------------------------------------------------

function listUsableFrames(page) {
    return (page.frames() || []).filter((f) => isUsableFormFrameUrl(f.url()));
}

/** Collect descriptors from ONE frame (works for pages and iframes alike). */
async function collectFieldDescriptors(frame) {
    return frame.evaluate(() => {
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
        // Workday (and other modern boards) render their forms inside open SHADOW ROOTS,
        // which document.querySelectorAll cannot see. Walk them explicitly.
        const collectRoots = (root) => {
            const roots = [root];
            try {
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) roots.push(...collectRoots(el.shadowRoot));
                }
            } catch (_) {}
            return roots;
        };
        const allFields = [];
        for (const r of collectRoots(document)) {
            for (const el of r.querySelectorAll('input, textarea, select')) allFields.push(el);
        }
        for (const el of allFields) {
            if (el.type === 'hidden' || el.disabled || el.readOnly) continue;
            // File inputs are usually visually hidden behind a styled dropzone/"Choose file"
            // button — keep them even when invisible, Puppeteer can still upload into them.
            const isFileInput = el.tagName === 'INPUT' && el.type === 'file';
            if (!isFileInput && !visible(el)) continue;
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

/**
 * Collect descriptors from every usable frame. Custom-domain boards (e.g.
 * jobs.elastic.co, jobs.dropbox.com) embed the actual Greenhouse/Lever form in a
 * cross-origin iframe — a main-frame-only sweep finds nothing there.
 */
async function collectFieldDescriptorsAllFrames(frames) {
    const out = [];
    for (let fIdx = 0; fIdx < frames.length; fIdx++) {
        const frame = frames[fIdx];
        let descs = [];
        try {
            descs = (await collectFieldDescriptors(frame)) || [];
        } catch (_) { continue; } // frame navigated away mid-sweep
        for (const d of descs) {
            d.frameIdx = fIdx;
            d.frameUrl = frame.url();
            out.push(d);
        }
    }
    return out;
}

/** Re-resolve the frame a descriptor was collected from (frames can navigate mid-fill). */
function resolveDescriptorFrame(page, d, framesSnapshot) {
    const frames = listUsableFrames(page);
    if (d.frameUrl && frames.some((f) => f.url() === d.frameUrl)) {
        return frames.find((f) => f.url() === d.frameUrl);
    }
    if (framesSnapshot && framesSnapshot[d.frameIdx] && frames.includes(framesSnapshot[d.frameIdx])) {
        return framesSnapshot[d.frameIdx];
    }
    return null;
}

/** Query the first element matching `sel`, piercing open shadow roots (Workday-style UIs). */
async function deepQueryFirst(pageOrFrame, sel) {
    try {
        const handle = await pageOrFrame.evaluateHandle((s) => {
            const deep = (root) => {
                const direct = root.querySelector(s);
                if (direct) return direct;
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) {
                        const found = deep(el.shadowRoot);
                        if (found) return found;
                    }
                }
                return null;
            };
            return deep(document);
        }, sel);
        const el = handle.asElement();
        if (el) return el;
    } catch (_) {}
    try { return await pageOrFrame.$(sel); } catch (_) { return null; }
}

/** Count text-ish form fields, piercing open shadow roots. */
async function deepFieldCount(frame) {
    try {
        return await frame.evaluate(() => {
            let count = 0;
            const walk = (root) => {
                count += root.querySelectorAll('input:not([type=hidden]), textarea').length;
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) walk(el.shadowRoot);
                }
            };
            walk(document);
            return count;
        });
    } catch (_) {
        return 0;
    }
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
    const frames = listUsableFrames(page);
    const descriptors = (await withWatchdog(collectFieldDescriptorsAllFrames(frames), 'collect form fields')) || [];
    console.log(`[autofill] Found ${descriptors.length} visible form field(s) across ${frames.length} frame(s) on ${page.url()}`);
    if (descriptors.length === 0) {
        // Self-diagnosis: explain WHY nothing was found (frames blocked, still loading, junk-filtered).
        const tree = await Promise.all((page.frames() || []).map(async (f) => {
            const n = await f.evaluate(() => document.querySelectorAll('input:not([type=hidden]), textarea').length).catch(() => 'ERR');
            return `[${n} field(s) ${f === page.mainFrame() ? '' : 'iframe '}${f.url().slice(0, 90)}]`;
        }));
        console.log(`[autofill] Frame tree at collect time: ${tree.join(' ')}`);
        console.log(`[autofill] (${frames.length} of ${tree.length} frame(s) passed the usable-frame filter)`);
    }

    let resumeAttached = attachedFiles.some((f) => f.input === 'resume');
    let clAttached = attachedFiles.some((f) => f.input === 'coverLetter');
    let clFilled = false;

    // Account/login walls: a form that contains password inputs is a sign-in or
    // account-creation surface, NOT an application form. Leave it entirely for the
    // human (that includes any name/email fields in it — those belong to the account).
    const framesWithPasswords = new Set(descriptors.filter((d) => d.type === 'password').map((d) => d.frameIdx));
    if (framesWithPasswords.size > 0) {
        warnings.push('Login/account-creation form detected (password fields present) — left for the human to complete. Fill your details and sign in; do not enable AUTO_SUBMIT for these.');
        console.log('[autofill] Password field(s) detected — this looks like a login/account form; leaving it for human review.');
    }

    for (const d of descriptors) {
        if (framesWithPasswords.has(d.frameIdx)) {
            skippedFields.push(`${describeField(d)} [accountForm]`);
            continue;
        }
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

        const frame = resolveDescriptorFrame(page, d, frames);
        if (!frame) {
            warnings.push(`Field ${hint} is no longer reachable (its frame navigated away)`);
            continue;
        }
        const handle = await deepQueryFirst(frame, `[data-autofill-idx="${d.idx}"]`);
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
            let btn = await page.$(sel);
            if (!btn) btn = await deepQueryFirst(page, sel); // Workday keeps buttons in shadow roots
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

/** Many boards (Greenhouse's new UI, Workday, Lever) render their form client-side —
 *  and custom-domain boards render it inside an iframe. Wait for fields in ANY usable
 *  frame, piercing open shadow roots (Workday-style UIs). */
async function waitForAnyFormField(page, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (const frame of listUsableFrames(page)) {
            if ((await deepFieldCount(frame)) >= 1) return;
        }
        await new Promise((r) => setTimeout(r, 300));
    }
}

/**
 * Cookie/consent overlays sit on top of career pages and swallow every click
 * (including ours). Dismiss common banners once so the page becomes clickable.
 * Prefers privacy-friendly rejections ("Reject all", "Only essential") when
 * offered, falls back to accept-style buttons. Never touches containers that
 * look like real forms (text inputs/textarea present).
 */
async function dismissCookieOverlay(page) {
    try {
        const handle = await page.evaluateHandle(() => {
            // Banners can live inside open shadow roots (Workday-style encapsulated UIs).
            const collectRoots = (root) => {
                const roots = [root];
                try {
                    for (const el of root.querySelectorAll('*')) {
                        if (el.shadowRoot) roots.push(...collectRoots(el.shadowRoot));
                    }
                } catch (_) {}
                return roots;
            };
            const roots = collectRoots(document);
            const all = (sel) => {
                const out = [];
                for (const r of roots) for (const el of r.querySelectorAll(sel)) out.push(el);
                return out;
            };
            const isConsentContainer = (el) => {
                const s = getComputedStyle(el);
                const nm = `${el.id} ${(el.className || '')}`.toString();
                return s.position === 'fixed' || s.position === 'absolute' || /cookie|consent|onetrust|trustarc|truste|gdpr|ccpa/i.test(nm);
            };
            const containers = all('div, section, aside, [role="dialog"]')
                .filter((el) => {
                    const s = getComputedStyle(el);
                    if (s.display === 'none' || s.visibility === 'hidden') return false;
                    const r = el.getBoundingClientRect();
                    if (r.width < 200 || r.height < 60) return false;
                    if (el.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea').length > 0) return false; // a real form — hands off
                    return isConsentContainer(el);
                });
            const prefer = [
                /reject all|reject|deny|only (necessary|essential)|essential cookies/i,
                /accept( all)?|agree|allow all|allow|got it|understood|i understand|dismiss|ok(ay)?$|continue/i,
            ];
            for (const pattern of prefer) {
                for (const c of containers) {
                    const cRoots = collectRoots(c);
                    for (const r of cRoots) {
                        for (const b of Array.from(r.querySelectorAll('button, a, [role="button"]'))) {
                            const s = getComputedStyle(b);
                            const rect = b.getBoundingClientRect();
                            if (s.display === 'none' || s.visibility === 'hidden' || rect.width < 10 || rect.height < 10) continue;
                            const text = (b.innerText || b.value || '').trim();
                            if (text && text.length < 30 && pattern.test(text)) return b;
                        }
                    }
                }
            }
            return null;
        });
        const el = handle.asElement();
        if (!el) return false;
        const label = (await el.evaluate((n) => (n.innerText || n.value || '').trim())).slice(0, 40);
        console.log(`[autofill] Dismissing a cookie/consent overlay ("${label}") so the page becomes clickable...`);
        await el.click().catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        return true;
    } catch (_) {
        return false;
    }
}

async function anyFieldsAcrossFrames(page) {
    for (const frame of listUsableFrames(page)) {
        if ((await deepFieldCount(frame)) >= 1) return true;
    }
    return false;
}

/**
 * Custom-domain boards (e.g. jobs.elastic.co) park the application form behind an
 * "Apply Now for <role>" CTA that navigates to an embed page. Follow the most
 * plausible CTA once: visible, NOT header/nav/banner chrome, not a pure "#/" SPA link.
 * Note: target=_blank CTAs that open a new tab are not chased in v1 — the run reports
 * "no fields found" and the human finishes manually.
 */
async function followApplyCta(page, warnings) {
    const browser = page.browser();
    const pagesBefore = new Set((await browser.pages().catch(() => [])));

    const handle = await page.evaluateHandle(() => {
        const re = /apply/i;
        const els = Array.from(document.querySelectorAll('a, button, [role="button"]'));
        let best = null;
        let bestScore = 0;
        for (const el of els) {
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            if (s.display === 'none' || s.visibility === 'hidden' || el.disabled) continue;
            if (r.width < 2 || r.height < 2) continue;
            const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
            const href = el.getAttribute('href') || '';
            if (!re.test(text + ' ' + href)) continue;
            // SPA-noise rejection: hash-only anchors and absolute "/#..." links navigate nowhere.
            if (href.trim().startsWith('#')) continue;
            let resolved = null;
            try { resolved = new URL(href, window.location.href); } catch (_) { continue; }
            const pathIsEmpty = resolved.pathname === '/' || resolved.pathname === window.location.pathname;
            if (pathIsEmpty && resolved.hash) continue; // e.g. "https://site/#/" or "#/apply"
            let score = 0;
            if (re.test(text)) score += 2;
            if (/(form|apply|gh_jid|job)/i.test(href)) score += 3;
            if (text.length > 8) score += 1; // "Apply Now for IT Support Admin" beats a bare "Apply"
            // Header/nav banners often hold dead marketing CTAs — penalize, don't hard-exclude:
            // legitimate CTAs do live in page headers on some boards (e.g. Lever postings).
            if (el.closest('header, nav, [class*="nav" i], [class*="header" i], [class*="banner" i], [class*="menu" i]')) score -= 3;
            if (score > bestScore) { bestScore = score; best = el; }
        }
        return best;
    });
    const el = handle.asElement();
    if (!el) return { followed: false, page };
    const href = await el.evaluate((n) => n.getAttribute('href')).catch(() => null);
    console.log(`[autofill] No form fields on this page — following apply CTA (href=${href || '(click)'}) to reach the application form...`);
    try {
        await withWatchdog(el.click({ delay: 40 }), 'click apply CTA', 30000);
    } catch (e) {
        warnings.push(`Could not click the apply CTA: ${e.message}`);
        return { followed: false, page };
    }
    // Some boards open the apply flow in a NEW TAB (e.g. SAP SuccessFactors dialog
    // popups). Detect it and keep filling on the new page.
    await new Promise((r) => setTimeout(r, 1500));
    let activePage = page;
    try {
        const pagesAfter = await browser.pages();
        const newPage = pagesAfter.find((p) => !pagesBefore.has(p));
        if (newPage) {
            console.log(`[autofill] Apply CTA opened a new tab (${newPage.url().slice(0, 90)}) — continuing there...`);
            await newPage.bringToFront().catch(() => {});
            activePage = newPage;
        }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1000)); // brief settle; caller re-waits for fields
    return { followed: true, page: activePage };
}

/**
 * A real application form has name/email/phone/resume-type fields. Job pages often
 * carry a search box or newsletter input — those are NOT form surfaces and must not
 * stop us from following the apply CTA.
 */
async function hasApplicationFields(page) {
    const frames = listUsableFrames(page);
    let descriptors = [];
    try {
        descriptors = (await collectFieldDescriptorsAllFrames(frames)) || [];
    } catch (_) { return false; }
    const pwFrames = new Set(descriptors.filter((d) => d.type === 'password').map((d) => d.frameIdx));
    return descriptors.some((d) => {
        if (pwFrames.has(d.frameIdx)) return false; // login/account forms are not application fields
        const cls = classifyFormField(d);
        return !cls.skip && cls.key !== 'unknown';
    });
}

/**
 * Shared adapter flow: wait for a rendered form in any frame; if no APPLICATION
 * fields exist (search boxes and newsletter inputs don't count), follow one apply
 * CTA (custom-domain boards) and wait again; then fill everything found.
 * Embed forms (cross-origin iframes) can mount slowly after CTA navigation, so if
 * the first fill pass finds nothing we wait patiently once more and retry.
 */
async function heuristicFillWithCta(ctx) {
    let { page } = ctx;
    await waitForAnyFormField(page);
    if (!(await hasApplicationFields(page))) {
        const followed = await followApplyCta(page, ctx.warnings);
        if (followed.followed) {
            ctx.page = page = followed.page; // the apply flow may have opened a new tab
            await dismissCookieOverlay(page); // new pages bring new consent banners
            await waitForAnyFormField(page, 30000);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    await runHeuristicFill(ctx);
    // An account wall is a terminal state — retrying just re-detects the same wall.
    const hitAccountWall = (ctx.skippedFields || []).some((s) => String(s).includes('[accountForm]'));
    if (!hitAccountWall && ctx.filledFields.length + ctx.attachedFiles.length === 0) {
        console.log('[autofill] Nothing filled yet — embedded forms can mount slowly; retrying once...');
        await waitForAnyFormField(page, 20000);
        await new Promise((r) => setTimeout(r, 2000));
        await runHeuristicFill(ctx);
    }
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

    // Workday renders its apply form client-side; the shared flow waits for real inputs
    // (in any frame) and falls back to following an apply CTA when none are present.
    await heuristicFillWithCta(ctx);
    console.log('[autofill] Workday applications are multi-step — fill/review the remaining steps manually.');
}

async function adaptGreenhouse(ctx) {
    const { loginWaitSeconds, warnings } = ctx;
    await ctx.page.waitForSelector('#application_form, form', { timeout: 10000 }).catch(() => {});
    const wall = await handleLoginWall(ctx.page, loginWaitSeconds, warnings);
    if (wall === 'timeout') { ctx.loginTimedOut = true; return; }
    await heuristicFillWithCta(ctx);
}

async function adaptLever(ctx) {
    const { page, loginWaitSeconds, warnings } = ctx;
    const formPresent = await page.$('input[name="email"], input[name="name"], input[type="file"]');
    if (!formPresent) {
        const { clicked } = await clickApplyButton(page, [
            'a.postings-btn.template-btn-submit', // Lever's real apply button
            'a[href$="/apply"]',                   // Lever postings: <posting-url>/apply
            'a.apply', '.apply-button', 'button[data-test="apply-button"]', 'a[data-qa="show-apply-form"]',
        ], warnings);
        if (clicked) {
            ctx.page = await resolveActivePage(ctx.browser, page);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
    const wall = await handleLoginWall(ctx.page, loginWaitSeconds, warnings);
    if (wall === 'timeout') { ctx.loginTimedOut = true; return; }
    await heuristicFillWithCta(ctx);
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
    await heuristicFillWithCta(ctx);
}

async function adaptGeneric(ctx) {
    const { loginWaitSeconds, warnings } = ctx;
    const wall = await handleLoginWall(ctx.page, loginWaitSeconds, warnings);
    if (wall === 'timeout') { ctx.loginTimedOut = true; return; }
    await heuristicFillWithCta(ctx);
}

/**
 * SAP SuccessFactors boards (careers.sap.com, *.successfactors.com, *.sapsf.com):
 * client-side rendered; the application form sits behind an Apply button and is
 * frequently iframe-embedded — exactly what the shared CTA-following + all-frame
 * fill flow handles. Login/account-creation walls are left to the human as usual.
 */
async function adaptSap(ctx) {
    const { loginWaitSeconds, warnings } = ctx;
    const wall = await handleLoginWall(ctx.page, loginWaitSeconds, warnings);
    if (wall === 'timeout') { ctx.loginTimedOut = true; return; }
    await heuristicFillWithCta(ctx);
}

const ADAPTERS = { workday: adaptWorkday, greenhouse: adaptGreenhouse, lever: adaptLever, seek: adaptSeek, sap: adaptSap, generic: adaptGeneric };

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
    // Forms are often iframe-embedded or shadow-hidden — search every usable frame.
    for (const frame of listUsableFrames(page)) {
        try {
            const handle = await frame.evaluateHandle(() => {
                // gather across open shadow roots (Workday-style UIs)
                const collectRoots = (root) => {
                    const roots = [root];
                    try {
                        for (const el of root.querySelectorAll('*')) {
                            if (el.shadowRoot) roots.push(...collectRoots(el.shadowRoot));
                        }
                    } catch (_) {}
                    return roots;
                };
                const candidates = [];
                for (const r of collectRoots(document)) {
                    for (const el of r.querySelectorAll('input[type="submit"], button[type="submit"], button, a')) candidates.push(el);
                }
                const re = /^(submit|apply)( application| now| your application)?$/i;
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
            if (!el) continue;
            await el.click();
            await new Promise((r) => setTimeout(r, 2000));
            console.log('[autofill] Submit button clicked (AUTO_SUBMIT mode).');
            return true;
        } catch (e) {
            // try the next frame
        }
    }
    warnings.push('Auto-submit: no submit button found');
    return false;
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
        await dismissCookieOverlay(page); // consent banners swallow every click we make later

        const adapter = ADAPTERS[result.platform] || adaptGeneric;
        await withWatchdog(adapter(ctx), `platform adapter (${result.platform})`, 300000);

        if (ctx.loginTimedOut) {
            result.reason = 'login_required';
            result.browserUrl = page.url();
            return result;
        }

        if (!filledFields.length && !attachedFiles.length) {
            warnings.push(skippedFields.some((s) => String(s).includes('[accountForm]'))
                ? 'Reached a login/account-creation wall — this employer requires signing in before the application form appears. Complete it manually in the open browser (we never touch passwords); autofill has taken you as far as it safely can.'
                : 'No matching form fields were found — the application form may be multi-step, behind a button, or site-specific. Complete it manually in the browser.');
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

module.exports = {
    autofillApplication,
    buildFormValueMap,
    classifyFormField,
    detectApplyPlatform,
    markdownToPlainText,
    isUsableFormFrameUrl,
    resolveCtaHref,
};
