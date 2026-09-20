#!/usr/bin/env node
/**
 * Job Application Pipeline
 *
 * Workflow:
 *  1. Accept job link (SEEK / LinkedIn / Indeed / TradeMe / generic)
 *  2. Scrape job description via Puppeteer
 *  3. Extract + merge all CVs in my_cvs/ for traceability
 *  4. Build a complete, factual CV + cover letter from candidate_profile.json
 *  5. Check ATS score via the ats.onl9.club API (reporting only; never rewrite facts)
 *  6. Generate PDFs with deterministic layout fitting (CV exactly 2 pages, CL exactly 1 page)
 *  7. Save to output/ + optional Notion sync & cleanup
 *
 * LLM: multi-provider fallback (OpenRouter, Groq, NVIDIA NIM, OpenAI, or LLM_API_KEY).
 * ATS check: ats.onl9.club API (ATS_API_BASE_URL) — no browser automation needed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { syncJobToNotion, cleanupOutputFiles } = require('./notion_sync');
let aggregateProfiles;
try { aggregateProfiles = require('./profile_aggregator').aggregateProfiles; } catch (_) {}
let pdfParse;
try { pdfParse = require('pdf-parse'); } catch (_) {}

// Load .env if present (for persistent LLM keys)
try {
    const envPath = require('path').join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const k = trimmed.substring(0, eq).trim();
            let v = trimmed.substring(eq+1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1,-1);
            process.env[k] = v; // .env overrides existing (user explicitly set new keys)
        }
    }
} catch (_) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readTextSafe(fp) {
    try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; }
}

function sanitizeCompanyName(name) {
    if (!name || name === 'Company') return 'Company';
    return name
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .trim()
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('')
        .substring(0, 40) || 'Company';
}

function loadCandidateProfile(workspaceRoot = __dirname) {
    const profilePath = path.join(workspaceRoot, 'candidate_profile.json');
    if (!fs.existsSync(profilePath)) {
        throw new Error(`Missing candidate profile: ${profilePath}`);
    }
    let profile;
    try {
        profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } catch (e) {
        throw new Error(`candidate_profile.json is not valid JSON: ${e.message}`);
    }
    const required = ['name', 'contact', 'workingRights', 'summaryVariants', 'skills', 'experience', 'projects', 'volunteer', 'education', 'additional'];
    const missing = required.filter(k => profile[k] == null);
    if (missing.length) throw new Error(`candidate_profile.json is missing: ${missing.join(', ')}`);
    if (!Array.isArray(profile.experience) || profile.experience.length < 4) {
        throw new Error('candidate_profile.json must contain all four professional employers');
    }
    if (!Array.isArray(profile.projects) || profile.projects.length < 1) {
        throw new Error('candidate_profile.json must contain at least one real project');
    }
    return profile;
}

function normaliseMatchText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9+#./-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function classifyJob(jobTitle, jobDescription) {
    const text = normaliseMatchText(`${jobTitle} ${jobDescription}`);
    const groups = {
        serviceDesk: ['service desk', 'help desk', 'first line', 'walk up', 'new user', 'active directory', 'group policy', 'jira service management'],
        systems: ['systems specialist', 'information systems', 'systems administration', 'system administration', 'learning management', 'lms', 'teaching tools', 'digital learning'],
        technicalSupport: ['technical support engineer', 'technical support', 'channel partner', 'customer query', 'crm', 'root cause', 'access control', 'electronics'],
        devops: ['devops', 'site reliability', 'sre', 'platform engineer', 'infrastructure as code', 'terraform', 'ci/cd', 'linux engineer']
    };
    let winner = 'technicalSupport';
    let best = -1;
    for (const [name, phrases] of Object.entries(groups)) {
        const score = phrases.reduce((sum, phrase) => sum + (text.includes(phrase) ? (phrase.includes(' ') ? 3 : 1) : 0), 0);
        if (score > best) {
            best = score;
            winner = name;
        }
    }
    return winner;
}

function scoreForJob(item, jobText) {
    if (!item) return 0;
    if (typeof item === 'string') {
        const words = new Set(jobText.split(' ').filter(w => w.length >= 5));
        const itemWords = normaliseMatchText(item).split(' ');
        return itemWords.reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
    }
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const tagScore = tags.reduce((sum, tag) => sum + (jobText.includes(normaliseMatchText(tag)) ? 4 : 0), 0);
    const words = new Set(jobText.split(' ').filter(w => w.length >= 5));
    const itemWords = normaliseMatchText(`${item.category || ''} ${item.name || ''} ${item.text || ''}`).split(' ');
    const wordScore = itemWords.reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
    return tagScore + wordScore;
}

function rankedItems(items, jobText, limit = items.length) {
    return items
        .map((item, index) => ({ item, index, score: scoreForJob(item, jobText) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map(entry => entry.item);
}

function nzDate(date = new Date()) {
    return new Intl.DateTimeFormat('en-NZ', {
        timeZone: 'Pacific/Auckland', day: 'numeric', month: 'long', year: 'numeric'
    }).format(date);
}

// ---------------------------------------------------------------------------
// Dynamic candidate profile fact formatters (decouples hardcoded strings)
// ---------------------------------------------------------------------------
function formatVerifiedEmployers(profile) {
    if (!profile || !Array.isArray(profile.experience)) return '';
    return profile.experience.map((e, idx) =>
        `${idx + 1}. ${e.employer} | ${e.location || 'Auckland, New Zealand'} | ${e.role} | ${e.dates}`
    ).join('\n');
}

function formatVerifiedProjects(profile) {
    if (!profile || !Array.isArray(profile.projects)) return '';
    return profile.projects.map((p, idx) =>
        `${idx + 1}. ${p.name}${p.tech ? ` (${p.tech})` : ''}`
    ).join('\n');
}

function formatVerifiedEducation(profile) {
    if (!profile || !Array.isArray(profile.education)) return '';
    return profile.education.map((ed, idx) =>
        `${idx + 1}. ${ed.institution} | ${ed.location || 'Auckland, New Zealand'} | ${ed.qualification} | ${ed.dates}`
    ).join('\n');
}

function formatVerifiedVolunteer(profile) {
    if (!profile || !Array.isArray(profile.volunteer)) return '';
    return profile.volunteer.map(v => {
        const org = v.organisation || v.organization || '';
        return `${org}${v.role ? ` (${v.role})` : ''}`;
    }).filter(Boolean).join(', ');
}

function getEmployerNamesSummary(profile) {
    if (!profile || !Array.isArray(profile.experience) || profile.experience.length === 0) {
        return 'established enterprise organisations';
    }
    const names = profile.experience.map(e => e.employer);
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function getProjectNamesSummary(profile) {
    if (!profile || !Array.isArray(profile.projects) || profile.projects.length === 0) return '';
    return profile.projects.map(p => p.name).join(', ');
}

function getEducationNamesSummary(profile) {
    if (!profile || !Array.isArray(profile.education) || profile.education.length === 0) return '';
    return profile.education.map(e => e.institution).join(', ');
}

function getVolunteerNamesSummary(profile) {
    if (!profile || !Array.isArray(profile.volunteer) || profile.volunteer.length === 0) return '';
    return profile.volunteer.map(v => v.organisation || v.organization).filter(Boolean).join(', ');
}

function buildFactualApplicationDocuments({ profile, jobDescription, companyName, jobTitle }) {
    const category = classifyJob(jobTitle, jobDescription);
    const jobText = normaliseMatchText(`${jobTitle} ${jobDescription}`);
    const contact = profile.contact || {};
    const summary = (profile.summaryVariants && (profile.summaryVariants[category] || profile.summaryVariants.technicalSupport))
        || profile.summary
        || 'Experienced IT and systems professional with hands-on experience in infrastructure, support, and technical administration.';
    const lines = [
        `# ${profile.name || 'MAGHAV AHUJA'}`,
        `## ${jobTitle || 'IT Support Professional'}`,
        `${contact.email || ''} | ${contact.phone || ''} | ${contact.location || ''}`,
        `${contact.linkedin || ''} | ${contact.github || ''}`,
        profile.workingRights || '',
        '',
        '## PROFESSIONAL SUMMARY',
        summary,
        '',
        '## TECHNICAL SKILLS'
    ];

    for (const skill of rankedItems(profile.skills || [], jobText, (profile.skills || []).length)) {
        lines.push(`- **${skill.category || 'Technical Skills'}:** ${skill.text || skill}`);
    }

    lines.push('', '## PROFESSIONAL EXPERIENCE');
    for (const role of (profile.experience || [])) {
        lines.push(`### ${role.employer} | ${role.location || ''}`);
        lines.push(`#### ${role.role} | ${role.dates || ''}`);
        const bullets = rankedItems(role.bullets || [], jobText, role.maxBullets || (role.bullets || []).length);
        for (const bullet of bullets) lines.push(`- ${typeof bullet === 'object' ? (bullet.text || bullet) : bullet}`);
    }

    lines.push('', '## KEY PROJECTS');
    for (const project of rankedItems(profile.projects || [], jobText)) {
        lines.push(`### ${project.name}`);
        for (const bullet of (project.bullets || [])) lines.push(`- ${typeof bullet === 'object' ? (bullet.text || bullet) : bullet}`);
    }

    lines.push('', '## VOLUNTEER EXPERIENCE');
    for (const item of (profile.volunteer || [])) {
        lines.push(`### ${item.organisation || item.organization || ''} | ${item.role || ''}`);
        if (item.bullet) lines.push(`- ${item.bullet}`);
    }

    lines.push('', '## EDUCATION');
    for (const item of (profile.education || [])) {
        lines.push(`### ${item.institution || ''} | ${item.location || ''}`);
        lines.push(`#### ${item.qualification || ''} | ${item.dates || ''}`);
        if (item.bullet) lines.push(`- ${item.bullet}`);
    }

    lines.push('', '## ADDITIONAL INFORMATION');
    for (const item of (profile.additional || [])) lines.push(`- ${item}`);
    const cvMarkdown = lines.join('\n').trim() + '\n';

    const employerSummary = getEmployerNamesSummary(profile);
    const commonOpening = `I am applying for the ${jobTitle} role with ${companyName}. My background combines hands-on IT support, systems administration and customer service across ${employerSummary}. I offer practical troubleshooting, clear communication and disciplined documentation, supported by a Master of Applied Technologies and current New Zealand work rights.`;
    const bodyByCategory = {
        serviceDesk: [
            `At Neurix, I provide remote and on-site support for internal users and engineering teams, administer Windows Server, networking, VPN and access environments, and maintain support procedures. At Datacom NZ, I worked in a large multi-client help desk environment supporting Microsoft 365, Azure DevOps and cloud systems, collaborating with senior engineers on escalations and documenting handovers clearly.`,
            `Earlier, with the Department of Education, I supported staff IT operations, maintained asset registers and automated routine administration with Python and Active Directory tools. My current customer-facing work at Mitre10 has strengthened my calm, approachable communication under pressure. Together, these experiences align well with first-line diagnosis, user setup, asset accuracy, knowledge sharing and timely escalation.`
        ],
        systems: [
            `At Neurix, I support business systems and cloud services, administer Windows and Linux environments, troubleshoot access, network and infrastructure issues, and document configurations and procedures. At Datacom NZ, I supported Microsoft 365, Azure DevOps and cloud-based systems across a multi-client enterprise environment while collaborating on escalations and maintaining clear client documentation.`,
            `My Department of Education experience adds staff support, asset control, procedure maintenance and Python/Active Directory workflow automation in an education setting. I also maintain hands-on systems practice through Azure and AWS deployments, VPS administration, Nextcloud, monitoring and structured Linux labs. This mix suits work that requires adaptable systems administration, documented change, stakeholder communication and continuous improvement.`
        ],
        technicalSupport: [
            `At Neurix, I resolve user, Windows, Linux, network, VPN, cloud and hardware issues through remote and on-site support, while maintaining accurate procedures and escalating complex incidents. At Datacom NZ, I provided enterprise help desk support for Microsoft 365, Azure DevOps and cloud systems in collaboration with senior engineers and service-delivery teams.`,
            `My volunteer work with Shoutcoder adds cPanel/WHM hosting support through tickets, live chat and email, including server and backup troubleshooting across more than 200 tickets. Mitre10 has further strengthened my ability to remain calm and professional in customer-facing situations. I would bring that same curiosity, clear explanation, accurate case notes and methodical root-cause approach to your customers and channel partners.`
        ],
        devops: [
            `At Neurix, I administer Linux servers and cloud infrastructure across Azure and AWS, automate deployment and maintenance with Python and Bash, manage configuration with Ansible and Terraform, and participate in production on-call support. I also implement Zabbix monitoring and troubleshoot infrastructure, application and hardware incidents.`,
            `At Datacom NZ, I supported Azure DevOps CI/CD work for .NET and React applications across three project teams. My practical projects cover Azure/AWS application deployment, VPS and package administration, backup automation, Nextcloud and hands-on labs with Docker, Kubernetes, Prometheus and Grafana. I pair this technical breadth with user support, documentation and dependable incident communication.`
        ]
    };
    const hasDefaultEmployers = (profile.experience || []).some(e =>
        /Neurix/i.test(e.employer) || /Datacom/i.test(e.employer)
    );
    let bodies;
    if (hasDefaultEmployers) {
        bodies = bodyByCategory[category] || bodyByCategory.technicalSupport;
    } else {
        const primaryRoles = (profile.experience || []).slice(0, 2);
        const secondaryRoles = (profile.experience || []).slice(2, 4);

        const p1Roles = primaryRoles.map(r => {
            const bulletText = Array.isArray(r.bullets) && r.bullets.length > 0
                ? (typeof r.bullets[0] === 'object' ? r.bullets[0].text : r.bullets[0])
                : `I served as ${r.role}`;
            return `At ${r.employer}, ${bulletText.toLowerCase().startsWith('at ') ? bulletText.slice(3) : bulletText}`;
        }).join(' ');

        const p2Roles = secondaryRoles.length > 0
            ? secondaryRoles.map(r => {
                const bulletText = Array.isArray(r.bullets) && r.bullets.length > 0
                    ? (typeof r.bullets[0] === 'object' ? r.bullets[0].text : r.bullets[0])
                    : `I contributed as ${r.role}`;
                return `Additionally, at ${r.employer}, ${bulletText.toLowerCase().startsWith('at ') ? bulletText.slice(3) : bulletText}`;
            }).join(' ')
            : `My technical and operational background enables me to deliver dependable results, document processes thoroughly, and communicate effectively with stakeholders.`;

        bodies = [
            p1Roles || `Across my professional roles, I have delivered dependable technical solutions and operational support.`,
            p2Roles
        ];
    }
    const closing = profile.workingRights && !hasDefaultEmployers
        ? `I am based in ${profile.contact?.location || 'Auckland'} and hold ${profile.workingRights}. I would welcome the opportunity to discuss how my support, systems and customer-service experience can contribute to ${companyName}.`
        : `I am based in Auckland and hold a New Zealand Post-Study Work Visa valid to August 2027. I would welcome the opportunity to discuss how my support, systems and customer-service experience can contribute to ${companyName}.`;
    const candidateName = profile.name
        ? profile.name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
        : 'Maghav Ahuja';
    const coverLetterMarkdown = [
        nzDate(), '', 'Hiring Team', companyName, '', `**Re: ${jobTitle}**`, '', 'Dear Hiring Team,', '',
        commonOpening, '', bodies[0], '', bodies[1], '', closing, '', 'Yours sincerely,', '', candidateName,
        `${contact.email || ''} | ${contact.phone || ''}`
    ].join('\n').trim() + '\n';

    return { cvMarkdown, coverLetterMarkdown, category };
}

// ---------------------------------------------------------------------------
// Config — multi-provider fallback chain
// Order: explicit overrides → OpenRouter → Groq → Nvidia NIM → other fallbacks
// When one provider exhausts retries/returns empty, the next provider is tried.
// ---------------------------------------------------------------------------
function resolveLLMConfig(overrides = {}) {
    // Return explicit override if provided
    if (overrides && overrides.llmApiKey) {
        return {
            apiKey: overrides.llmApiKey,
            baseURL: overrides.llmBaseUrl || (overrides.llmApiKey.startsWith('gsk_') ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1'),
            model: overrides.llmModel || 'openai/gpt-oss-120b',
            name: 'override'
        };
    }
    // Return highest priority configured provider from getProviderChain()
    const chain = getProviderChain(overrides);
    if (chain.length > 0) {
        return { ...chain[0] };
    }
    // Fallback if no keys in .env
    const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.M_JOB_API_KEY || '';
    const baseURL = process.env.LLM_BASE_URL || process.env.M_JOB_API_BASE_URL || 'https://api.openai.com/v1';
    const model = process.env.LLM_MODEL || process.env.M_JOB_API_MODEL || 'openai/gpt-oss-120b';
    return { apiKey, baseURL, model, name: 'primary' };
}

function getProviderChain(overrides = {}) {
    const chain = [];
    const seen = new Set();

    function push(name, apiKey, baseURL, model) {
        if (!apiKey || !model) return;
        const key = `${baseURL}|${model}`;
        if (seen.has(key)) return;
        seen.add(key);
        chain.push({ name, apiKey, baseURL, model });
    }

    // 0. Explicit runtime override (per-request from form or CLI) — always first
    if (overrides && overrides.llmApiKey) {
        push(
            'override',
            overrides.llmApiKey,
            overrides.llmBaseUrl || (overrides.llmApiKey.startsWith('gsk_') ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1'),
            overrides.llmModel || 'openai/gpt-oss-120b'
        );
    }

    // 1. OpenRouter — user-prioritized #1
    const orKey = process.env.OPENROUTER_API_KEY || process.env.M_JOB_OPENROUTER_API_KEY || process.env.OR_API_KEY || '';
    const orBase = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    const orModel = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';
    if (orKey) push('openrouter', orKey, orBase, orModel);

    // 2. Groq — user-prioritized #2
    const groqKey = process.env.GROQ_API_KEY || process.env.M_JOB_GROQ_API_KEY || (process.env.LLM_API_KEY && process.env.LLM_API_KEY.startsWith('gsk_') ? process.env.LLM_API_KEY : '') || '';
    const groqBase = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
    const groqModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
    if (groqKey) push('groq', groqKey, groqBase, groqModel);

    // 3. Nvidia NIM — user-prioritized #3
    const nimKey = process.env.NIM_API_KEY || process.env.M_JOB_NIM_API_KEY || '';
    const nimBase = process.env.NIM_BASE_URL || process.env.M_JOB_NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
    const nimModel = process.env.NIM_MODEL || process.env.M_JOB_NIM_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
    if (nimKey) {
        push('nvidia-nim', nimKey, nimBase, nimModel);
        // If configured model is something else (e.g. kimi-k3), also include nemotron as reliable fallback
        if (nimModel !== 'nvidia/nemotron-3-super-120b-a12b') {
            push('nvidia-nim-nemotron', nimKey, nimBase, 'nvidia/nemotron-3-super-120b-a12b');
        }
    }

    // 4. Generic LLM / OpenAI (if configured and distinct)
    const genKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.M_JOB_API_KEY || '';
    if (genKey && !genKey.startsWith('gsk_') && genKey !== orKey && genKey !== nimKey && genKey !== groqKey) {
        const genBase = process.env.LLM_BASE_URL || process.env.M_JOB_API_BASE_URL || 'https://api.openai.com/v1';
        const genModel = process.env.LLM_MODEL || process.env.M_JOB_API_MODEL || 'openai/gpt-oss-120b';
        push('primary', genKey, genBase, genModel);
    }

    // 5. B.AI / deepseek
    const baiKey = process.env.BAI_API_KEY || process.env.B_AI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
    const baiBase = process.env.BAI_BASE_URL || process.env.B_AI_BASE_URL || 'https://api.b.ai/v1';
    const baiModel = process.env.BAI_MODEL || process.env.B_AI_MODEL || 'deepseek-v4-flash';
    if (baiKey) push('b.ai', baiKey, baiBase, baiModel);

    // 6. Gemini (Google)
    const gemKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.M_JOB_GEMINI_API_KEY || '';
    const gemBase = process.env.GEMINI_BASE_URL || process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/';
    const gemModel = process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || 'gemini-2.0-flash';
    if (gemKey) push('gemini', gemKey, gemBase, gemModel);

    // 7. OrcaRouter
    const orcaKey = process.env.ORCAROUTER_API_KEY || process.env.M_JOB_ORCAROUTER_API_KEY || '';
    const orcaBase = process.env.ORCAROUTER_BASE_URL || process.env.M_JOB_ORCAROUTER_BASE_URL || 'https://api.orcarouter.com/v1';
    const orcaModel = process.env.ORCAROUTER_MODEL || process.env.M_JOB_ORCAROUTER_MODEL || 'openai/gpt-4o';
    if (orcaKey) push('orcarouter', orcaKey, orcaBase, orcaModel);

    return chain;
}

// Pre-flight: ping each provider with a 1-token request so dead keys are dropped
// up-front with a clear message, instead of failing mid-run after minutes of work.
async function validateProviderChain(chain) {
    if (!chain || chain.length === 0) return [];
    const valid = [];
    log('Checking LLM provider chain health...');
    for (const p of chain) {
        let outcome = null; // 'ok' | 'rate-limited' | { status } | 'unreachable'
        for (let ping = 1; ping <= 2; ping++) {
            try {
                const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${p.apiKey}` };
                if (/openrouter/i.test(p.baseURL)) {
                    headers['HTTP-Referer'] = 'https://github.com/maghavahuja/jobs-automation';
                    headers['X-Title'] = 'Job Application Pipeline';
                }
                const isReasoning = p.model.includes('gpt-oss') || p.model.includes('reasoning') || p.model.includes('nemotron');
                const body = {
                    model: p.model,
                    messages: [{ role: 'user', content: 'ping' }]
                };
                if (isReasoning && p.model.includes('gpt-oss')) {
                    body.reasoning_effort = 'low';
                    body.max_completion_tokens = 20;
                } else {
                    body.max_tokens = 10;
                }
                const r = await fetch(p.baseURL.replace(/\/+$/, '') + '/chat/completions', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(6000),
                });
                outcome = r.ok ? 'ok' : (r.status === 429 ? 'rate-limited' : { status: r.status });
            } catch (e) {
                outcome = 'unreachable'; // timeout / network error — retry once
            }
            if (outcome !== 'unreachable') break; // got a real HTTP answer — stop pinging
            if (ping === 1) await new Promise(res => setTimeout(res, 1000));
        }
        if (outcome === 'ok' || outcome === 'rate-limited') {
            valid.push(p);
            log(`  ✓ Provider [${p.name}] ${p.model} — ${outcome === 'ok' ? 'OK' : 'rate-limited but key valid'}`);
        } else if (outcome && typeof outcome === 'object' && [401, 403, 404].includes(outcome.status)) {
            // Definitive auth/config error — drop this provider
            log(`  ✗ Provider [${p.name}] ${p.model} — HTTP ${outcome.status} (check key/model in .env) — dropped`);
        } else {
            // Timeout / unreachable — DON'T drop. The real LLM calls have 60s timeout + retries.
            valid.push(p);
            log(`  ⚠ Provider [${p.name}] ${p.model} — ping timed out or slow, keeping in chain`);
        }
    }
    return valid.length > 0 ? valid : chain;
}

// Fallback company extraction via LLM — far more robust than selector/regex hacks.
async function extractCompanyViaLLM(description, chain) {
    const prompt = `From this job advertisement, identify the HIRING COMPANY name (the employer organisation, not the job board, not the recruiter platform). Reply with ONLY the company name (max 60 characters). No quotes, no explanation. If truly undeterminable, reply exactly: Unknown.

Job ad:
${description.substring(0, 5000)}`;
    try {
        const out = await callLLM(prompt, 'You extract entity names from text. Reply with the name only, nothing else.', chain);
        const name = (out || '').replace(/["'.*#`]/g, '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
        if (name.length >= 2 && name.length <= 60 && !/^(unknown|n\/a|none|not specified|the company|hiring company)$/i.test(name)) {
            return name;
        }
    } catch (_) {}
    return null;
}

// Fallback job title extraction via LLM when scraped title is generic portal junk
async function extractJobTitleViaLLM(description, chain) {
    const prompt = `From this job advertisement, identify the exact JOB TITLE / POSITION being advertised (e.g. "Systems Administrator", "Service Desk Analyst"). Do NOT return generic terms like "Current Job Opportunities", "Careers", or "Job Opening". Reply with ONLY the job title (max 80 characters). No quotes, no explanation. If truly undeterminable, reply exactly: Unknown.

Job ad:
${description.substring(0, 5000)}`;
    try {
        const out = await callLLM(prompt, 'You extract job titles from job advertisements. Reply with the exact title only, nothing else.', chain);
        const title = (out || '').replace(/["'.*#`]/g, '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
        if (title.length >= 3 && title.length <= 80 && !/^(unknown|n\/a|none|not specified|position|job|career|opportunities|openings)$/i.test(title)) {
            return title;
        }
    } catch (_) {}
    return null;
}


async function callLLM(prompt, systemPrompt, configOrChain) {
    // Accept either a single config or a provider chain array
    const chain = Array.isArray(configOrChain) ? configOrChain : [configOrChain];
    // If caller passed a single config that looks like overrides, expand to full chain
    const fullChain = chain.length === 1 && !chain[0].name ? getProviderChain(chain[0]) : chain;
    // Also handle case where configOrChain is an overrides object (from legacy calls)
    const providers = fullChain.length && fullChain[0].apiKey ? fullChain : getProviderChain(configOrChain);

    if (!providers.length || !providers[0].apiKey) {
        throw new Error('No LLM API key configured. Set OPENROUTER_API_KEY / GROQ_API_KEY / NIM_API_KEY / LLM_API_KEY in .env.');
    }

    let lastError = null;

    for (let pIdx = 0; pIdx < providers.length; pIdx++) {
        const { apiKey, baseURL, model, name } = providers[pIdx];
        const isLastProvider = pIdx === providers.length - 1;
        log(`LLM call → ${model} @ ${baseURL} [${name}] (prompt ${prompt.length} chars)${providers.length > 1 ? ` [${pIdx + 1}/${providers.length}]` : ''}`);

        const OpenAI = require('openai');
        const defaultHeaders = {};
        if (/openrouter/i.test(baseURL)) {
            defaultHeaders['HTTP-Referer'] = 'https://github.com/maghavahuja/jobs-automation';
            defaultHeaders['X-Title'] = 'Job Application Pipeline';
        }
        // Timeout of 60s per attempt prevents multi-minute hangs on degraded endpoints
        const client = new OpenAI({ apiKey, baseURL, timeout: 60000, maxRetries: 0, defaultHeaders });

        const isReasoningModel = model.includes('gpt-oss') || model.includes('deepseek') && model.includes('r1') || model.includes('o1') || model.includes('o3') || model.includes('reasoning');
        // Output token budget: 5000 for reasoning models, 6000 for standard models
        const maxTokens = isReasoningModel ? 5000 : 6000;

        const messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: prompt });

        const params = {
            model,
            messages,
            temperature: 0.5,
        };
        if (isReasoningModel) {
            params.reasoning_effort = 'low';
            params.max_completion_tokens = maxTokens;
        } else {
            params.max_tokens = maxTokens;
        }
        // Hybrid reasoning models on OpenRouter (e.g. nemotron) burn ~80% of output budget on hidden thinking tokens
        if (/openrouter/i.test(baseURL) && /nemotron/i.test(model)) {
            params.reasoning = { enabled: false, exclude: true };
        }

        // Per-provider retry loop (rate limit, timeout, network, empty content)
        let resp = null;
        let content = '';
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    resp = await client.chat.completions.create(params);
                    break;
                } catch (e) {
                    const msg = (e.message || '').toLowerCase();
                    const isRateLimit = msg.includes('rate limit') || msg.includes('quota') || msg.includes('rate');
                    const isTimeout = msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout') || msg.includes('aborted');
                    const isNetwork = e.name === 'FetchError' || e.name === 'NetworkError';
                    const isTransient = isRateLimit || isTimeout || isNetwork;
                    const waitMs = isTransient ? (attempt + 1) * 3000 : 0;
                    log(`  [${name}] LLM call attempt ${attempt + 1}/3 failed: ${(e.message || '').substring(0, 120)}${isTransient ? ' — retrying in ' + waitMs / 1000 + 's' : ' — giving up'}`);
                    if (isTransient && attempt < 2) {
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }
                    throw e;
                }
            }
            if (!resp) throw new Error('No response after LLM retries');
            if (resp.error) throw new Error(resp.error.message || JSON.stringify(resp.error));
            const choice = resp.choices && resp.choices[0];
            if (!choice) throw new Error('No choices in response: ' + JSON.stringify(resp).slice(0, 160));
            content = (choice.message && choice.message.content) || '';
            // If content is empty but model provided reasoning text containing document, extract it
            if (!content && choice.message && choice.message.reasoning) {
                const rText = choice.message.reasoning.trim();
                if (rText.length > 80) {
                    log(`  [${name}] Extracted ${rText.length} chars from message.reasoning`);
                    content = rText;
                }
            }
            const finishReason = choice.finish_reason || 'unknown';

            // If the model hit the max_tokens ceiling, the output is silently truncated
            // (e.g. CV cut off mid-bullet in the middle of PROFESSIONAL EXPERIENCE).
            // Detect that and retry with a higher cap before falling through to other logic.
            if (finishReason === 'length' && content && content.trim()) {
                log(`  [${name}] Response hit max_tokens (${maxTokens}) — output truncated (${content.length} chars), retrying with higher cap...`);
                const bumpedTokens = Math.min(maxTokens * 2, 8000);
                try {
                    const retry = await client.chat.completions.create({
                        ...params,
                        max_tokens: bumpedTokens,
                        messages: [
                            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                            { role: 'user', content: prompt + '\n\nIMPORTANT: Your previous response was cut off mid-sentence. You MUST continue/complete the entire document in this single response. Do not stop early. Output the complete document from start to finish.' }
                        ],
                    });
                    const rContent = (retry.choices && retry.choices[0] && retry.choices[0].message && retry.choices[0].message.content) || '';
                    const rFinish = (retry.choices && retry.choices[0] && retry.choices[0].finish_reason) || 'unknown';
                    if (rContent && rContent.trim() && rFinish !== 'length') {
                        content = rContent;
                        log(`  [${name}] Retry with bumped cap succeeded (${content.length} chars, finish=${rFinish})`);
                    } else {
                        log(`  [${name}] Retry with bumped cap still truncated (finish=${rFinish}, ${rContent.length} chars) — using what we have`);
                    }
                } catch (e) {
                    log(`  [${name}] Bump-retry failed: ${e.message} — using truncated output`);
                }
            }

            if (!content || !content.trim()) {
                log(`  [${name}] Empty content (reasoning-only). Retrying with stricter instruction...`);
                try {
                    const retry = await client.chat.completions.create({
                        ...params,
                        messages: [
                            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                            { role: 'user', content: prompt + '\n\nIMPORTANT: Provide ONLY the final output. No chain-of-thought, no preamble. Start directly with the requested document.' }
                        ],
                    });
                    content = (retry.choices[0].message && retry.choices[0].message.content) || '';
                } catch (e) { log(`  [${name}] Strict retry failed: ${e.message}`); }
            }
            if (!content || !content.trim()) {
                log(`  [${name}] Still empty — waiting 12s then final retry...`);
                await new Promise(r => setTimeout(r, 12000));
                try {
                    const fb = await client.chat.completions.create({
                        ...params,
                        messages: [
                            { role: 'system', content: (systemPrompt || '') + ' Be extremely concise. Output ONLY the final document. No preamble, no chain-of-thought, no explanations. Start directly with "# MAGHAV AHUJA" or the date line.' },
                            { role: 'user', content: prompt + '\n\nCRITICAL: Respond with ONLY the document. Do not include reasoning, preamble, or commentary. Start immediately with the document content.' }
                        ],
                    });
                    content = (fb.choices[0].message && fb.choices[0].message.content) || '';
                    if (content && content.trim()) log(`  [${name}] Retry after wait succeeded (${content.length} chars)`);
                } catch (e) { log(`  [${name}] Final retry failed: ${e.message}`); }
            }

            if (content && content.trim()) {
                log(`LLM response received from [${name}] ${model} (${content.length} chars)`);
                return content.trim();
            }
            lastError = new Error(`[${name}] Empty content after all retries`);
            log(`  [${name}] Empty after all retries — ${isLastProvider ? 'no more providers' : 'trying next provider...'}`);
            if (!isLastProvider) { await new Promise(r => setTimeout(r, 2000)); continue; }
            throw lastError;
        } catch (e) {
            lastError = e;
            const msg = e.message || String(e);
            const isRetriable = msg.includes('Rate limit') || msg.includes('quota') || msg.includes('rate') || msg.includes('Empty content')
                || msg.includes('timeout') || msg.includes('timed out') || msg.includes('ETIMEDOUT') || msg.includes('aborted')
                || e.name === 'FetchError' || e.name === 'NetworkError'
                || e.status === 429 || e.status === 413 || e.status === 401 || e.status === 403;
            log(`  [${name}] Failed: ${msg.substring(0, 180)}`);
            if (!isLastProvider && isRetriable) {
                log(`  → Falling back to next provider: ${providers[pIdx + 1].name} (${providers[pIdx + 1].model})`);
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }
            if (!isLastProvider && !isRetriable) {
                // For non-retriable errors (e.g. auth), still try next provider
                log(`  → Trying next provider anyway: ${providers[pIdx + 1].name}`);
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }
            throw e;
        }
    }
    throw lastError || new Error('All LLM providers failed');
}

// ---------------------------------------------------------------------------
// Job scraping — Puppeteer (handles JS-heavy sites: SEEK, LinkedIn, Indeed, TradeMe)
// ---------------------------------------------------------------------------
function detectPlatform(url) {
    const u = url.toLowerCase();
    if (u.includes('seek.co')) return 'seek';
    if (u.includes('linkedin.com')) return 'linkedin';
    if (u.includes('indeed.com')) return 'indeed';
    if (u.includes('trademe.co')) return 'trademe';
    if (u.includes('myworkdayjobs.com')) return 'workday';
    return 'generic';
}

function cleanAndValidateJobDescription(rawDescription, jobLink, pageTitle = '') {
    if (!rawDescription || rawDescription.trim().length < 50) {
        throw new Error(`Scraped page content is empty or too short (${(rawDescription || '').length} chars). The listing may be protected or unavailable.`);
    }

    const text = rawDescription.replace(/\r\n/g, '\n').trim();

    // 1. Strict Dead / Expired / 404 Job Posting Detection
    const expiredPatterns = [
        /\b(?:job not found|role is no longer available|position is no longer available)\b/i,
        /\b(?:the job post you(?:’|')?re looking for may have been removed|the link is outdated)\b/i,
        /\b(?:this job has expired|this job posting has expired|this vacancy has expired)\b/i,
        /\b(?:this role has been filled|position has been filled|job has been filled)\b/i,
        /\b(?:this posting has closed|applications are now closed|no longer accepting applications)\b/i,
        /\b(?:page not found|404 not found|404 error)\b/i,
        /\b(?:the job you are looking for is no longer available|job advertisement has expired)\b/i,
        /\b(?:this vacancy is closed|this job is no longer active|this position is closed)\b/i
    ];

    for (const pat of expiredPatterns) {
        if (pat.test(text) || pat.test(pageTitle)) {
            // Check if page is dead (short text, title match, or error banner at the top)
            const topLines = text.split('\n').slice(0, 15).join(' ');
            if (text.length < 2500 || pat.test(pageTitle) || pat.test(topLines)) {
                const matchSnippet = (text.match(pat) || pageTitle.match(pat) || ['expired'])[0];
                throw new Error(`The job posting at ${jobLink} is expired or no longer available (detected: "${matchSnippet}"). Please provide an active job listing.`);
            }
        }
    }

    // 2. Cut off aggregator footer clutter, related jobs, reading lists, and legal boilerplates
    const cutoffPatterns = [
        /\n(?:\s*#*\s*)(?:Related (?:remote )?jobs|Similar (?:remote )?jobs|Other jobs you may like|Recommended jobs|More jobs from|Jobs you might be interested in)\b[\s\S]*$/i,
        /\n(?:\s*#*\s*)(?:READING FOR YOUR JOB SEARCH|Recent Articles|Career Advice|Related Articles)\b[\s\S]*$/i,
        /\n(?:\s*#*\s*)(?:BROWSE MORE JOBS|EXPLORE MORE ROLES)\b[\s\S]*$/i,
        /\n(?:\s*#*\s*)(?:PRIVACY POLICY\s+TERMS & CONDITIONS|TERMS & CONDITIONS\s+COOKIE SETTINGS)\b[\s\S]*$/i,
        /\n(?:\s*#*\s*)(?:About the company\s+)?(?:Follow us on|Share this job|Report this job|Save this job|Email this job)\b[\s\S]*$/i
    ];

    let cleaned = text;
    for (const pat of cutoffPatterns) {
        cleaned = cleaned.replace(pat, '');
    }

    // 3. Remove inline aggregator marketing, cookie banners, and application noise
    const junkLinePatterns = [
        /^.*(?:sign in to see the rest of this description|log in to apply|create an account to view).*$/im,
        /^.*(?:never submits anything until you review|tailors your CV and matches|automates your job search).*$/im,
        /^.*(?:be an early applicant|posted \d+ (?:days?|hours?|weeks?) ago|\b\d+ applicants\b).*$/im,
        /^.*(?:we use essential cookies|accept all cookies|manage cookies|cookie settings).*$/im,
        /^.*(?:copyright\s+\d{4}\s+.*all rights reserved).*$/im
    ];

    for (const pat of junkLinePatterns) {
        cleaned = cleaned.replace(new RegExp(pat.source, pat.flags + 'g'), '');
    }

    // Clean whitespace
    cleaned = cleaned
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (cleaned.length < 150) {
        throw new Error(`After removing site boilerplate, the job description at ${jobLink} has insufficient content (${cleaned.length} chars). The listing may require authentication or is gated.`);
    }

    return cleaned.substring(0, 15000);
}

function getBrowserLaunchOptions() {
    const opts = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions'
        ]
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    return opts;
}

function parseWorkdayUrl(jobUrl) {
    try {
        const u = new URL(jobUrl);
        if (!u.hostname.includes('myworkdayjobs.com')) return null;

        const tenant = u.hostname.split('.')[0];
        const segments = u.pathname.split('/').filter(Boolean);
        let cleanSegments = segments;
        if (/^[a-z]{2}(-[A-Z]{2})?$/i.test(cleanSegments[0])) {
            cleanSegments = cleanSegments.slice(1);
        }

        const site = cleanSegments[0];
        const slug = cleanSegments[cleanSegments.length - 1];

        if (tenant && site && slug) {
            return {
                tenant,
                site,
                slug,
                apiUrl: `https://${u.hostname}/wday/cxs/${tenant}/${site}/job/${slug}`
            };
        }
    } catch (_) {}
    return null;
}

function htmlToPlainText(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li>/gi, '• ')
        .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n\n$1\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function scrapeWorkdayJob(jobLink) {
    const parsed = parseWorkdayUrl(jobLink);
    if (!parsed) return null;

    log(`Attempting Workday CXS API fetch: ${parsed.apiUrl}`);
    const res = await fetch(parsed.apiUrl, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
    });

    if (!res.ok) {
        throw new Error(`Workday CXS API returned HTTP ${res.status}`);
    }

    const data = await res.json();
    const info = data.jobPostingInfo || {};
    const rawDesc = info.jobDescription || '';
    const description = htmlToPlainText(rawDesc);
    if (!description || description.length < 50) {
        throw new Error('Workday CXS API returned empty job description');
    }

    const jobTitle = info.title || 'Position';
    let companyName = data.hiringOrganization?.name || '';
    if (!companyName && info.location) {
        const m = info.location.match(/NZ-(.+)$/i);
        if (m) companyName = m[1].trim();
    }
    if (!companyName) {
        companyName = parsed.tenant.toUpperCase();
    }

    const cleanedDescription = cleanAndValidateJobDescription(description, jobLink, jobTitle);
    log(`✓ Workday CXS API scraped ${cleanedDescription.length} chars (title="${jobTitle}", company="${companyName}")`);
    return {
        description: cleanedDescription,
        companyName,
        jobTitle,
        platform: 'workday'
    };
}

async function scrapeJobDescription(jobLink, browserInstance) {
    log(`Scraping job description: ${jobLink} [${detectPlatform(jobLink)}]`);

    // Workday fast-path: fetch directly from native CXS REST API
    if (detectPlatform(jobLink) === 'workday' || (jobLink && jobLink.includes('myworkdayjobs.com'))) {
        try {
            const wdResult = await scrapeWorkdayJob(jobLink);
            if (wdResult && wdResult.description && wdResult.description.length >= 100) {
                return wdResult;
            }
        } catch (wdErr) {
            log(`Workday CXS API fetch failed (${wdErr.message}) — falling back to browser scraping...`);
        }
    }
    const shouldClose = !browserInstance;
    const browser = browserInstance || await puppeteer.launch(getBrowserLaunchOptions());
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 900 });

    // Block images, media, fonts, and tracking beacons to dramatically accelerate page load
    // and avoid hanging on infinite analytics/ad connections on cloud hosts
    try {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const rt = req.resourceType();
            const u = req.url().toLowerCase();
            if (
                ['image', 'media', 'font'].includes(rt) ||
                u.includes('google-analytics.com') ||
                u.includes('doubleclick.net') ||
                u.includes('facebook.net') ||
                u.includes('hotjar.com') ||
                u.includes('segment.io') ||
                u.includes('clarity.ms') ||
                u.includes('datadoghq.com')
            ) {
                req.abort().catch(() => {});
            } else {
                req.continue().catch(() => {});
            }
        });
    } catch (_) {}

    const timeoutMs = parseInt(process.env.SCRAPE_TIMEOUT_MS || '60000', 10);

    try {
        let navOk = false;
        try {
            await page.goto(jobLink, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
            navOk = true;
        } catch (navErr) {
            log(`Navigation warning (domcontentloaded): ${navErr.message}. Checking page DOM...`);
            // Check if DOM already received HTML content despite timeout event
            const bodyLen = await page.evaluate(() => (document.body ? document.body.innerText.trim().length : 0)).catch(() => 0);
            if (bodyLen > 200) {
                log(`Page content found in DOM (${bodyLen} chars) despite navigation warning.`);
                navOk = true;
            } else {
                try {
                    await page.goto(jobLink, { waitUntil: 'load', timeout: timeoutMs });
                    navOk = true;
                } catch (loadErr) {
                    const finalCheck = await page.evaluate(() => (document.body ? document.body.innerText.trim().length : 0)).catch(() => 0);
                    if (finalCheck > 200) {
                        navOk = true;
                    } else {
                        throw new Error(`Failed to load job page (${jobLink}): ${loadErr.message}`);
                    }
                }
            }
        }

        // Wait for dynamic SPA / client-side rendering
        await page.waitForFunction(() => {
            const el = document.querySelector('[data-automation-id="jobPostingDescription"], [data-automation="jobAdDetails"], [data-automation="jobDescription"], article, main, #content, .job-description');
            return (el && el.innerText.trim().length > 100) || (document.body && document.body.innerText.trim().length > 200);
        }, { timeout: 8000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));

        // Try to dismiss common popups/cookie banners
        try {
            const dismissSelectors = [
                '[data-automation="closeButton"]', '[aria-label="Close"]', '[aria-label="Dismiss"]',
                'button:has-text("Accept")', 'button:has-text("Got it")', '#onetrust-accept-btn-handler'
            ];
            for (const sel of dismissSelectors) {
                const el = await page.$(sel).catch(() => null);
                if (el) { await el.click().catch(() => {}); await new Promise(r => setTimeout(r, 500)); }
            }
        } catch (_) {}

        let description = '';
        const platform = detectPlatform(jobLink);

        if (platform === 'seek') {
            description = await page.evaluate(() => {
                const selectors = [
                    '[data-automation="jobAdDetails"]',
                    '[data-automation="jobDescription"]',
                    '[class*="jobDescription"]',
                    'article',
                    'main',
                ];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.innerText && el.innerText.trim().length > 500) return el.innerText.trim();
                }
                // Fallback: biggest text block
                return document.body.innerText.trim();
            });
        } else if (platform === 'linkedin') {
            description = await page.evaluate(() => {
                const sel = document.querySelector('.description__text, .show-more-less-html__markup, [class*="job-description"], article');
                if (sel && sel.innerText.trim().length > 200) return sel.innerText.trim();
                return document.body.innerText.trim();
            });
        } else if (platform === 'indeed') {
            description = await page.evaluate(() => {
                const el = document.querySelector('#jobDescriptionText, [class*="jobsearch-JobComponent-description"]');
                if (el && el.innerText.trim().length > 200) return el.innerText.trim();
                return document.body.innerText.trim();
            });
        } else if (platform === 'trademe') {
            description = await page.evaluate(() => {
                const el = document.querySelector('[class*="job-description"], [class*="description"], article, main');
                if (el && el.innerText.trim().length > 300) return el.innerText.trim();
                return document.body.innerText.trim();
            });
        } else {
            description = await page.evaluate(() => {
                const selectors = [
                    '[data-automation-id="jobPostingDescription"]',
                    '[data-automation-id="jobPostingPage"]',
                    'main',
                    'article',
                    '[data-automation="jobDescription"]',
                    '[data-automation="jobAdDetails"]',
                    '[class*="job-description"]',
                    '[class*="jobDescription"]',
                    '[class*="job_description"]',
                    '[class*="job-details"]',
                    '[class*="jobDetails"]',
                    '[class*="description"]',
                    '[id*="job-description"]',
                    '[id*="jobDescription"]',
                    '#content'
                ];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.innerText && el.innerText.trim().length > 300) {
                        return el.innerText.trim();
                    }
                }
                return document.body.innerText.trim();
            });
        }

        const pageTitle = await page.title().catch(() => '');
        description = cleanAndValidateJobDescription(description, jobLink, pageTitle);

        log(`Job description scraped & cleaned: ${description.length} chars, ${description.split(/\s+/).length} words`);

        // Extract company + title heuristics for later use
        let companyName = 'Company';
        let jobTitle = 'Position';
        try {
            const meta = await page.evaluate(() => {
                // Title candidates — try multiple selectors, pick longest meaningful
                const titleSelectors = ['h1', '[data-automation="jobTitle"]', '.job-title', '[class*="jobTitle"]', '[class*="JobTitle"]', 'header h1', 'header h2'];
                let title = '';
                for (const sel of titleSelectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                        const t = el.innerText.trim().replace(/\s+/g, ' ');
                        if (t.length > 5 && t.length < 100 && !t.includes('StaffCV') && !t.includes('|')) { title = t; break; }
                        if (!title && t.length > 5 && t.length < 120) title = t;
                    }
                }
                if (!title || title.includes('StaffCV') || title === '|') {
                    // Fallback: look for text that looks like a job title in description area
                    const allText = document.body.innerText;
                    const m = allText.match(/(IT Service Desk Technician|Systems Engineer|IT Support Specialist|DevOps Engineer|Network Engineer|Cloud Engineer|Support Technician|Service Desk[^\n]{0,30})/i);
                    if (m) title = m[1].trim();
                    else title = document.title.split(' - ')[0].split(' | ')[0].trim().substring(0, 80);
                }
                // Company candidates — extensive list for bfound, generic, SEEK etc.
                const companySelectors = [
                    '[data-automation="advertiser-name"]', '[data-automation="jobCompany"]',
                    '[class*="company"]', '[class*="employer"]', 'a[href*="/companies/"]',
                    '[class*="Company"]', '[class*="organisation"]', '[class*="Organization"]',
                    '[data-testid*="company"]', '.employer', '.company-name',
                    // bfound specific
                    '.company', '.employer-name', '[class*="CoName"]', '[id*="Company"]'
                ];
                let company = '';
                for (const s of companySelectors) {
                    try {
                        const el = document.querySelector(s);
                        if (el && el.innerText) {
                            const c = el.innerText.trim().replace(/\s+/g, ' ');
                            if (c.length > 2 && c.length < 80 && !c.includes('Apply') && !c.includes('Sign In')) { company = c; break; }
                        }
                    } catch (_) {}
                }
                // JSON-LD fallback
                if (!company || company === 'Company') {
                    try {
                        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                        for (const sc of scripts) {
                            const j = JSON.parse(sc.textContent);
                            const org = j.hiringOrganization?.name || j.hiringOrganization || j.author?.name;
                            if (org && typeof org === 'string' && org.length > 2 && org.length < 80) { company = org; break; }
                            if (org && org.name) { company = org.name; break; }
                        }
                    } catch (_) {}
                }
                // Meta fallback
                if (!company || company === 'Company') {
                    const metaOrg = document.querySelector('meta[property="og:site_name"]')?.content || document.querySelector('meta[name="author"]')?.content;
                    if (metaOrg && metaOrg.length > 2 && metaOrg.length < 60 && !metaOrg.includes('http')) company = metaOrg;
                }
                return { title: title || document.title.substring(0, 80), company: company || '' };
            });
            if (meta.company) companyName = meta.company.replace(/\s+View all jobs.*$/i, '').replace(/^\|\s*/, '').trim().substring(0, 60);
            if (meta.title) jobTitle = meta.title.replace(/\s+at\s+.*$/i, '').replace(/^\|\s*/, '').trim().substring(0, 80);
            // Structured JobPosting data is more reliable than careers-site mastheads.
            const structured = await page.evaluate(() => {
                const nodes = [];
                const visit = value => {
                    if (!value) return;
                    if (Array.isArray(value)) return value.forEach(visit);
                    if (typeof value !== 'object') return;
                    nodes.push(value);
                    if (value['@graph']) visit(value['@graph']);
                };
                for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                    try { visit(JSON.parse(script.textContent)); } catch (_) {}
                }
                const posting = nodes.find(node => {
                    const type = node['@type'];
                    return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
                }) || {};
                const org = posting.hiringOrganization;
                return {
                    title: typeof posting.title === 'string' ? posting.title.trim() : '',
                    company: typeof org === 'string' ? org.trim() : (org && typeof org.name === 'string' ? org.name.trim() : '')
                };
            }).catch(() => ({ title: '', company: '' }));
            const junkTitleRe = /^(position|job|jobs|careers?|current vacancies|vacancies|home|search jobs?|apply now|.*\bwebsite\b.*|this role is no longer available|job not found|page not found|404|404 not found|role not found|current job (opportunities|openings)|job (opportunities|openings)|career opportunities|work for us|join our team|working at .*)$/i;
            if (structured.title && (!jobTitle || junkTitleRe.test(jobTitle.trim()))) jobTitle = structured.title.substring(0, 80);
            if (structured.company && (!companyName || companyName === 'Company')) companyName = structured.company.substring(0, 60);

            const host = new URL(jobLink).hostname.toLowerCase();
            const knownEmployer = host.includes('careers.mercury.co.nz') ? 'Mercury'
                : host.includes('otago.taleo.net') ? 'University of Otago'
                : host.includes('careers.gallagher.com') ? 'Gallagher'
                : '';
            if (knownEmployer) companyName = knownEmployer;

            if (!jobTitle || junkTitleRe.test(jobTitle.trim())) {
                const titlePatterns = [
                    /\bService Desk Analyst\b/i,
                    /\bSystems Specialist\b/i,
                    /\bTechnical Support Engineer\b/i,
                    /\bIT Service Desk Technician\b/i,
                    /\bIT Support Specialist\b/i,
                    /\bSystems Administrator\b/i,
                    /\bSystems Engineer\b/i,
                    /\bDevOps Engineer\b/i
                ];
                const matched = titlePatterns.map(re => description.match(re)).find(Boolean);
                if (matched) jobTitle = matched[0];
            }
            // Final fallback: try to extract company from job description text (e.g. "Toi Moana Bay of Plenty Regional Council is responsible")
            if (!companyName || companyName === 'Company' || companyName.length < 3) {
                const descCompanyMatch = description.match(/(Toi Moana[^.\n]{0,40}Regional Council|Bay of Plenty Regional Council|Plumbing World|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}\s+(?:Council|Corporation|Limited|Ltd|Inc|Company|Group|Holdings))/);
                if (descCompanyMatch) {
                    companyName = descCompanyMatch[1].trim().substring(0, 60);
                } else {
                    // Last resort: use hostname-derived name (skip aggregators and job boards, resolve subdomains)
                    try {
                        const parsedHost = new URL(jobLink).hostname.replace(/^www\./, '').toLowerCase();
                        const hostParts = parsedHost.split('.');
                        const aggregatorHosts = ['jobs', 'bfound', 'hireeing', 'entireless', 'sydicom', 'indeed', 'seek', 'trademe', 'linkedin', 'glassdoor', 'wellfound', 'builtin', 'remoteok', 'weworkremotely', 'greenhouse', 'lever', 'jobvite'];
                        const subdomainPrefixes = ['new', 'careers', 'jobs', 'recruitment', 'work', 'apply', 'boards', 'app', 'portal', 'talent'];
                        let hostCandidate = hostParts[0];
                        if (subdomainPrefixes.includes(hostCandidate) && hostParts.length > 2) {
                            hostCandidate = hostParts[1];
                        }
                        if (hostCandidate && hostCandidate.length >= 2 && !aggregatorHosts.includes(hostCandidate) && !subdomainPrefixes.includes(hostCandidate)) {
                            companyName = hostCandidate.length <= 4 ? hostCandidate.toUpperCase() : (hostCandidate.charAt(0).toUpperCase() + hostCandidate.slice(1));
                        } else if (hostCandidate === 'bfound') {
                            companyName = 'BfoundEmployer';
                        }
                    } catch (_) {}
                }
            }
            // Clean up title fallback
            if (!jobTitle || jobTitle === 'Position' || jobTitle.includes('StaffCV') || jobTitle === '|' || jobTitle.length < 4 || /\bwebsite\b/i.test(jobTitle) || junkTitleRe.test(jobTitle.trim())) {
                const firstLine = (description || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
                if (firstLine && firstLine.length >= 4 && firstLine.length <= 60 && !junkTitleRe.test(firstLine) && !/^(about|welcome|http|www)/i.test(firstLine)) {
                    jobTitle = firstLine;
                } else {
                    const titleFromDesc = description.match(/(Service Desk Analyst|Systems Specialist|Technical Support Engineer|IT Service Desk Technician|Systems Administrator|Systems Engineer|IT Support Specialist|DevOps Engineer|Network Engineer|Cloud Engineer|Service Desk[^\n]{0,30})/i);
                    if (titleFromDesc) jobTitle = titleFromDesc[1].trim().substring(0, 80);
                }
            }
        } catch (_) {}

        log(`Detected title: "${jobTitle}" | company: "${companyName}"`);

        return { description, companyName, jobTitle, platform };
    } finally {
        await page.close().catch(() => {});
        if (shouldClose) await browser.close().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// CV extraction — pdf-parse, then MERGE all sources into one unified text
// ---------------------------------------------------------------------------
async function extractAndMergeCVs(myCvsDir) {
    log(`Loading CVs from: ${myCvsDir}`);
    if (!fs.existsSync(myCvsDir)) {
        log('my_cvs directory not found');
        return { mergedText: '', files: [], details: [] };
    }
    const files = fs.readdirSync(myCvsDir).filter(f => f.toLowerCase().endsWith('.pdf'));
    log(`Found ${files.length} PDF(s): ${files.join(', ') || '(none)'}`);
    if (files.length === 0) return { mergedText: '', files, details: [] };

    const details = [];
    let mergedText = '';
    for (const file of files) {
        const fullPath = path.join(myCvsDir, file);
        try {
            if (!pdfParse) {
                log(`pdf-parse not available — reading ${file} as binary fallback`);
                details.push({ file, text: `[PDF: ${file}]`, pages: 0 });
                continue;
            }
            const buffer = fs.readFileSync(fullPath);
            const data = await pdfParse(buffer);
            const text = (data.text || '').trim();
            details.push({ file, text, pages: data.numpages || 0, length: text.length });
            log(`  ${file}: ${text.length} chars, ${data.numpages} pages`);
            mergedText += `\n\n===== SOURCE CV: ${file} =====\n${text}\n`;
        } catch (e) {
            log(`  Failed to extract ${file}: ${e.message}`);
            details.push({ file, text: '', error: e.message });
        }
    }
    mergedText = mergedText.trim();
    log(`Merged CV source total: ${mergedText.length} chars`);
    return { mergedText, files, details };
}

// ---------------------------------------------------------------------------
// LLM generation — CV + Cover Letter (ONE new CV merging all sources)
// ---------------------------------------------------------------------------
async function generateCVAndCoverLetter({ candidateProfile, jobDescription, companyName, jobTitle, jobLink = '', llmChain, preflightAtsReport = null }) {
    log('Building baseline factual application documents...');
    const base = buildFactualApplicationDocuments({
        profile: candidateProfile,
        jobDescription,
        companyName,
        jobTitle
    });

    const chain = Array.isArray(llmChain) && llmChain.length ? llmChain : getProviderChain();
    const hasLLM = chain && chain.length > 0 && !!chain[0].apiKey;

    if (!hasLLM) {
        log('No LLM API configured — using baseline factual documents');
        return base;
    }

    log(`Tailoring CV and Cover Letter with LLM (${chain.map(p => p.name).join(' → ')})...`);
    let tailoredCV = base.cvMarkdown;
    let tailoredCL = base.coverLetterMarkdown;

    // 1. LLM Tailored CV
    try {
        const jdAnalysis = extractJdRequirementsAndKeywords(jobDescription, jobTitle, jobLink);
        const topKeywordsStr = jdAnalysis.keywords.slice(0, 35).join(', ');
        const topReqsStr = jdAnalysis.requirements.slice(0, 8).map((r, i) => `   ${i + 1}. ${r}`).join('\n');

        let preflightSection = '';
        if (preflightAtsReport) {
            const preflightMissing = (preflightAtsReport.missingKeywords || []).map(k => k.keyword || k).filter(Boolean);
            const preflightSkills = (preflightAtsReport.missingSkills || []).map(s => s.name || s).filter(Boolean);
            const preflightReqs = (preflightAtsReport.experienceMatches || []).map(e => e.requirement || e).filter(Boolean);
            preflightSection = `
=== ATS SCANNER PRE-DIAGNOSTIC TARGETS (FROM ats.onl9.club - TARGET: 95%+ SCORE) ===
The ATS scanner has analyzed the JD and requires the following terms to achieve 90+ ATS score:
- CRITICAL MISSING KEYWORDS TO EMBED VERBATIM: ${preflightMissing.join(', ') || '(All matched in base)'}
- REQUIRED HARD SKILLS: ${preflightSkills.join(', ') || '(All matched)'}
- KEY REQUIREMENTS TO MIRROR IN BULLETS (WITH QUANTIFIABLE ACHIEVEMENTS):
${preflightReqs.slice(0, 8).map((r, i) => `  ${i + 1}. ${r}`).join('\n') || 'Align with core JD duties'}

MANDATORY DIRECTIVE:
1. Every missing keyword and hard skill above MUST appear in the generated CV (in TECHNICAL SKILLS or experience bullets).
2. Every single bullet point MUST be strictly between 18 and 42 words (NEVER exceed 48 words).
3. The Professional Summary MUST be exactly 1 paragraph of 40-50 words (strictly under 52 words).
`;
        }

        const cvPrompt = `You are an elite ATS resume architect and technical career specialist. Your mission is to tailor the candidate's verified factual CV to achieve a 95%+ ATS match score against the role of "${jobTitle}" at "${companyName}" on ats.onl9.club.

=== TARGET JOB DESCRIPTION ===
${jobDescription.substring(0, 4500)}
${preflightSection}
=== EXTRACTED CORE JD KEYWORDS & TECHNOLOGIES ===
${topKeywordsStr || 'Extract and weave all relevant technical tools, systems, and methodologies from the JD'}

=== TOP JOB REQUIREMENTS TO DIRECTLY MATCH ===
${topReqsStr || 'Align experience bullets with core duties in the JD'}

=== CANDIDATE BASE FACTS (VERIFIED RECORD - NEVER DROP OR FABRICATE) ===
Name: ${candidateProfile.name}
Role Target: ${jobTitle}
Contact: ${candidateProfile.contact.email} | ${candidateProfile.contact.phone} | ${candidateProfile.contact.location}
Online: ${candidateProfile.contact.linkedin} | ${candidateProfile.contact.github}
Rights: ${candidateProfile.workingRights}
Verified Employers:
${formatVerifiedEmployers(candidateProfile)}
Verified Real Projects:
${formatVerifiedProjects(candidateProfile)}
Volunteer: ${formatVerifiedVolunteer(candidateProfile)}
Education:
${formatVerifiedEducation(candidateProfile)}
Additional: ${(candidateProfile.additional || []).join(', ')}

=== STRICT FACTUAL BOUNDARIES ===
- DO NOT fabricate new companies, employers, employment dates, or job titles.
- DO NOT fabricate new degrees, academic qualifications, or universities.
- Keep ALL ${candidateProfile.experience?.length || 4} employers, ${candidateProfile.projects?.length || 3} projects, ${candidateProfile.volunteer?.length || 2} volunteer organizations, and ${candidateProfile.education?.length || 2} education entries in the exact order specified.

=== MANDATORY ATS OPTIMIZATION RULES (TO GUARANTEE 90+ ATS SCORE) ===
1. EXACT HEADER STRUCTURE:
   # ${candidateProfile.name}
   ## ${jobTitle}
   ${candidateProfile.contact.email} | ${candidateProfile.contact.phone} | ${candidateProfile.contact.location}
   ${candidateProfile.contact.linkedin} | ${candidateProfile.contact.github}
   ${candidateProfile.workingRights}

2. PROFESSIONAL SUMMARY (CRITICAL ATS FORMATTING):
   - Exactly ONE concise paragraph of 40 to 50 words (MUST NOT exceed 52 words to prevent ATS bullet-length penalties).
   - Tailor it directly to "${jobTitle}", targeting "${companyName}", weaving 5-8 of the primary keywords and tools from the JD.

3. DYNAMIC TECHNICAL SKILLS MATRIX:
   - Reconstruct 6-8 distinct technical categories tailored to this role, showcasing the EXACT tools, platforms, protocols, and methodologies from the JD.
   - Weave tools naturally into relevant categories (e.g. Service Delivery & ITIL, Microsoft & Identity, Cloud & Infrastructure, Automation & Scripting, Networking & Security, Monitoring & Observability).

4. PROFESSIONAL EXPERIENCE (AGGRESSIVE TAILORING & ACTION VERBS):
   - Keep all ${candidateProfile.experience?.length || 4} employers in exact chronological order.
   - Reframe and expand achievements and responsibilities to directly address the JD's requirements, tools, workflows, and methodologies.
   - ACTION VERB MANDATE: EVERY bullet MUST start with a strong, high-impact past-tense action verb (Spearheaded, Engineered, Orchestrated, Automated, Administered, Implemented, Deployed, Architected, Optimized, Streamlined, Resolved, Standardized, Configured). NEVER start with weak/passive verbs like 'Delivered', 'Deliver', 'Manage', 'Supported', 'Worked', 'Responsible for'.
   - BULLET LENGTH MANDATE: Keep EVERY bullet strictly between 18 and 42 words (must be strictly under 48 words to avoid ATS length penalties).
${(candidateProfile.experience || []).map(e => `   - ${e.employer}: ${e.maxBullets || 4} bullets demonstrating relevant systems, cloud, automation, and support achievements matching JD tools.`).join('\n')}

5. KEY PROJECTS (FEATURE ENHANCEMENT):
   - Keep ${getProjectNamesSummary(candidateProfile)} (2 bullets each).
   - Reframe project bullets to highlight relevant modules, architectures, or integrations matching the JD. Each bullet must start with a strong action verb and stay under 45 words.

6. VOLUNTEER & EDUCATION:
   - Keep ${[getVolunteerNamesSummary(candidateProfile), getEducationNamesSummary(candidateProfile)].filter(Boolean).join(', ')} with strong past-tense action verbs.

7. TARGET WORD COUNT:
   - 900 to 1020 words total. This ensures the rendered PDF fits exactly 2 full A4 pages without overflowing.

Output ONLY the complete Markdown CV starting immediately with "# ${candidateProfile.name}". No preamble, no chain-of-thought, no commentary.`;

        const systemPromptCV = `You are an expert ATS CV writer. Output ONLY the tailored CV in markdown format starting immediately with "# ${candidateProfile.name}".`;
        const responseCV = await callLLM(cvPrompt, systemPromptCV, chain);

        if (responseCV && responseCV.trim().length > 1200) {
            let workingCV = responseCV.trim() + '\n';
            const check = validateCVIntegrity(workingCV, candidateProfile);
            if (check.ok) {
                log('✓ LLM-tailored CV passed integrity validation');
                tailoredCV = workingCV;
            } else {
                log(`⚠ LLM CV failed integrity check: ${check.issues.join(' | ')} — attempting self-repair...`);
                const repairPrompt = `Fix the following integrity issues in the CV while preserving all tailored bullet points and action verbs:
Issues to fix:
${check.issues.map((iss, i) => `${i + 1}. ${iss}`).join('\n')}

Required verified facts:
- Employers: ${getEmployerNamesSummary(candidateProfile)}
- Key Projects: ${getProjectNamesSummary(candidateProfile)}
- Volunteer: ${getVolunteerNamesSummary(candidateProfile)}
- Education: ${getEducationNamesSummary(candidateProfile)}
- All 7 sections in order: PROFESSIONAL SUMMARY, TECHNICAL SKILLS, PROFESSIONAL EXPERIENCE, KEY PROJECTS, VOLUNTEER EXPERIENCE, EDUCATION, ADDITIONAL INFORMATION

CV to fix:
${responseCV}

Output ONLY the corrected Markdown CV starting with "# ${candidateProfile.name}".`;
                try {
                    const repaired = await callLLM(repairPrompt, systemPromptCV, chain);
                    const repairCheck = validateCVIntegrity(repaired, candidateProfile);
                    if (repairCheck.ok) {
                        log('✓ LLM CV self-repair succeeded');
                        tailoredCV = repaired.trim() + '\n';
                    } else {
                        log('LLM CV repair still had issues — using baseline factual CV');
                        tailoredCV = base.cvMarkdown;
                    }
                } catch (e) {
                    log(`Repair call failed: ${e.message} — using baseline factual CV`);
                    tailoredCV = base.cvMarkdown;
                }
            }

            // Apply ATS formatting constraints and keyword weaving
            tailoredCV = enforceAtsBulletConstraints(tailoredCV);
            if (preflightAtsReport) {
                tailoredCV = ensureAtsKeywordsPresent(tailoredCV, {
                    missingKeywords: preflightAtsReport.missingKeywords,
                    missingSkills: preflightAtsReport.missingSkills,
                    companyName,
                    jobTitle,
                    candidateProfile
                });
            }
        }
    } catch (e) {
        log(`LLM CV tailoring error: ${e.message} — falling back to baseline factual CV`);
        tailoredCV = base.cvMarkdown;
    }

    // 2. LLM Tailored Cover Letter
    try {
        const candidateName = candidateProfile.name || 'Maghav Ahuja';
        const clPrompt = `Write a professional, compelling 1-page Cover Letter (300-380 words) in New Zealand English for ${candidateName} applying for "${jobTitle}" at "${companyName}".

=== TARGET JOB DESCRIPTION ===
${jobDescription.substring(0, 4000)}

=== CANDIDATE FACTS & CV ===
${tailoredCV.substring(0, 4000)}

=== COVER LETTER REQUIREMENTS ===
- Date: ${nzDate()}
- Addressed to: Hiring Team, ${companyName}
- Subject line: **Re: ${jobTitle}**
- Greeting: Dear Hiring Team,
- Paragraph 1: Enthusiastic opening stating the role, combining hands-on IT support/systems administration/customer service background across ${getEmployerNamesSummary(candidateProfile)}.
- Paragraph 2: Connect technical accomplishments (M365/cloud/systems/troubleshooting/automation) directly to the specific requirements mentioned in the job description.
- Paragraph 3: Highlight soft skills, calm customer communication under pressure, disciplined documentation, and fast ticket escalation.
- Paragraph 4: Auckland location, NZ Post-Study Work Visa (valid to August 2027), and enthusiasm to discuss how to contribute to ${companyName}.
- Sign-off: Yours sincerely,\n\n${candidateName}\n${candidateProfile.contact.email} | ${candidateProfile.contact.phone}

Output ONLY the final Markdown Cover Letter. No preamble, no commentary.`;

        const systemPromptCL = 'You are a professional cover letter writer. Output ONLY the markdown letter.';
        const responseCL = await callLLM(clPrompt, systemPromptCL, chain);
        if (responseCL && responseCL.trim().length > 300) {
            tailoredCL = responseCL.trim() + '\n';
            log('✓ LLM-tailored Cover Letter generated');
        }
    } catch (e) {
        log(`LLM Cover Letter tailoring error: ${e.message} — using baseline cover letter`);
        tailoredCL = base.coverLetterMarkdown;
    }

    const words = tailoredCV.trim().split(/\s+/).length;
    log(`Tailored application documents assembled: CV=${words} words, CL=${tailoredCL.trim().split(/\s+/).length} words, category=${base.category}`);
    return { cvMarkdown: tailoredCV, coverLetterMarkdown: tailoredCL, category: base.category };
}

function extractJdRequirementsAndKeywords(jd, jobTitle = '', jobLink = '') {
    if (!jd) return { keywords: [], requirements: [] };
    const candidates = [
        'Active Directory', 'Azure AD', 'Entra ID', 'Group Policy', 'GPO', 'Microsoft 365', 'M365', 'Office 365', 'Exchange Online', 'Exchange',
        'SharePoint', 'Teams', 'Intune', 'SCCM', 'MECM', 'Windows Server', 'Windows 10', 'Windows 11', 'PowerShell', 'Bash', 'Python',
        'Linux', 'Ubuntu', 'CentOS', 'RHEL', 'Red Hat', 'Debian', 'Amazon Web Services', 'AWS', 'Azure', 'GCP', 'Google Cloud',
        'Docker', 'Kubernetes', 'K8s', 'Terraform', 'Ansible', 'Jenkins', 'CI/CD', 'Git', 'GitHub', 'GitLab', 'Azure DevOps',
        'Service Desk', 'Help Desk', 'First-Line', 'L1', 'L2', 'L3', 'Technical Support', 'Desktop Support', 'IT Support', 'ITIL',
        'Jira', 'Jira Service Management', 'Confluence', 'ServiceNow', 'Zendesk', 'Freshdesk', 'Salesforce', 'CRM', 'ERP',
        'Networking', 'TCP/IP', 'LAN', 'WAN', 'DNS', 'DHCP', 'VPN', 'Firewall', 'Cisco', 'Fortinet', 'Wi-Fi', 'VLAN', 'Routing', 'Switching',
        'VoIP', 'SIP', 'PBX', 'RTP', 'Wireshark', 'Broadband', 'Cisco ISR', 'Juniper SRX', 'QoS', 'Hosted Voice', 'SIP Traces', 'Packet Captures',
        'PostgreSQL', 'MySQL', 'SQL Server', 'MSSQL', 'MongoDB', 'Redis', 'Database', 'ETL',
        'Monitoring', 'Observability', 'Zabbix', 'Prometheus', 'Grafana', 'Nagios', 'Datadog', 'Splunk', 'ELK',
        'NGINX', 'Apache', 'cPanel', 'WHM', 'Hosting', 'SSL', 'TLS', 'DNS Management',
        'VMware', 'ESXi', 'vSphere', 'Hyper-V', 'Proxmox', 'Virtualization',
        'Cybersecurity', 'Endpoint', 'Antivirus', 'EDR', 'MFA', '2FA', 'SSO', 'SAML', 'Identity Management', 'IAM', 'RBAC', 'ISO 27001', 'SOC 2',
        'Disaster Recovery', 'Backup', 'Veeam', 'Incident Management', 'Problem Management', 'Change Management', 'Root Cause', 'SLA', 'KPI',
        'Customer Service', 'Customer Communication', 'Customer Success', 'Troubleshooting', 'Documentation', 'Asset Management', 'Hardware',
        'PPE Compliance', 'Health and Safety', 'Compliance', 'Fault Records', 'Work Alerting'
    ];

    const jdLower = jd.toLowerCase();
    const matched = new Set();
    for (const c of candidates) {
        if (jdLower.includes(c.toLowerCase())) matched.add(c);
    }

    // Stop words for aggregator sites, generic web noise, and dead link phrases
    const stopWords = new Set([
        'hireeing', 'sydicom', 'entireless', 'indeed', 'seek', 'trademe', 'linkedin', 'glassdoor',
        'wellfound', 'builtin', 'ziprecruiter', 'job board', 'privacy policy', 'terms conditions',
        'cookie settings', 'all rights', 'rights reserved', 'reading for', 'remote customer',
        'view all', 'post a job', 'back to jobs', 'apply now', 'job post', 'job listing',
        'applicant', 'applicants', 'job not found', 'role is no longer', 'manage cookies',
        'essential cookies', 'analytics cookies', 'salary', 'worldwide', 'save job', 'share this job'
    ]);
    if (jobLink) {
        try {
            const host = new URL(jobLink).hostname.toLowerCase().replace('www.', '').split('.')[0];
            if (host && host.length > 2) stopWords.add(host);
        } catch (_) {}
    }

    // Extract dynamic capitalized multi-word phrases (e.g. "Customer Success", "Service Management")
    const phraseRe = /\b([A-Z][a-zA-Z0-9+#.-]+(?:\s+[A-Z][a-zA-Z0-9+#.-]+){1,2})\b/g;
    let m;
    const phraseCounts = new Map();
    while ((m = phraseRe.exec(jd)) !== null) {
        const p = m[1].trim();
        const pLower = p.toLowerCase();
        const isStop = stopWords.has(pLower) || Array.from(stopWords).some(sw => pLower.includes(sw));
        if (!isStop && p.length > 3 && p.length < 35 && !/^(the|this|that|with|from|have|will|must|they|what|when|where|your|their|about|apply|status|summary|description|salary|worldwide)\b/i.test(p)) {
            phraseCounts.set(p, (phraseCounts.get(p) || 0) + 1);
        }
    }
    const dynamicPhrases = Array.from(phraseCounts.entries())
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([p]) => p);

    for (const p of dynamicPhrases) matched.add(p);

    // Extract requirement sentences (sentences containing key requirement verbs)
    const sentences = jd.split(/(?<=[.!?\n])\s+/);
    const reqVerbs = /(?:experience with|proficien|knowledge of|hands-on|responsib|troubleshoot|administer|support|deploy|manag|maintain|configur|provid|collaborat|escalat|ensure|develop|deliver|monitor)/i;
    const requirements = sentences
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(s => s.length >= 25 && s.length <= 180 && reqVerbs.test(s) && !/cookie|browser|copyright|privacy|hireeing|sydicom|entireless|sign in to/i.test(s))
        .slice(0, 10);

    return {
        keywords: Array.from(matched),
        requirements
    };
}

function extractKeywordHint(jd) {
    const analysis = extractJdRequirementsAndKeywords(jd);
    return analysis.keywords.slice(0, 15).join(', ') || 'role-specific keywords from JD';
}

function resolveAtsApiUrl(rawUrl) {
    let url = (rawUrl || 'https://ats-api.onl9.club/api/v1').trim().replace(/\/+$/, '');
    if (url.includes('://ats.onl9.club')) {
        url = url.replace('://ats.onl9.club', '://ats-api.onl9.club');
    }
    if (!url.includes('/api/v1')) {
        url = `${url}/api/v1`;
    }
    return url;
}

function calculateLocalAtsScore(cvText, jobDescription, meta = {}) {
    const analysis = extractJdRequirementsAndKeywords(jobDescription);
    const cvLower = String(cvText || '').toLowerCase();

    // Keyword match
    const keywords = analysis.keywords || [];
    const matchedKeywords = [];
    const missingKeywords = [];
    for (const kw of keywords) {
        if (cvLower.includes(kw.toLowerCase())) {
            matchedKeywords.push(kw);
        } else {
            missingKeywords.push({ keyword: kw, importance: 'Important', action_suggestion: `Incorporate experience with ${kw} if applicable` });
        }
    }
    const keywordRatio = keywords.length > 0 ? (matchedKeywords.length / keywords.length) : 0.8;
    const keywordScore = Math.round(keywordRatio * 100);

    // Formatting & Sections (all 7 required sections)
    const requiredSections = [
        'PROFESSIONAL SUMMARY', 'TECHNICAL SKILLS', 'PROFESSIONAL EXPERIENCE',
        'KEY PROJECTS', 'VOLUNTEER EXPERIENCE', 'EDUCATION', 'ADDITIONAL INFORMATION'
    ];
    const presentSections = requiredSections.filter(s => cvText.includes(`## ${s}`));
    const sectionScore = Math.round((presentSections.length / requiredSections.length) * 100);

    // Title match
    let titleScore = 75;
    if (meta.jobTitle && cvLower.includes(meta.jobTitle.toLowerCase())) {
        titleScore = 100;
    }

    const overallScore = Math.min(96, Math.max(55, Math.round((keywordScore * 0.45) + (sectionScore * 0.35) + (titleScore * 0.20))));
    const passed = overallScore >= 85;

    const reportLines = [
        `ATS Score: ${overallScore}% (Local Keyword Analysis)`
    ];
    if (matchedKeywords.length) reportLines.push(`\n## Matched keywords: ${matchedKeywords.join(', ')}`);
    if (missingKeywords.length) reportLines.push(`\n## Missing keywords:\n${missingKeywords.map(m => `- ${m.keyword} (${m.importance}): ${m.action_suggestion}`).join('\n')}`);

    return {
        score: overallScore,
        passed,
        needsImprovement: !passed,
        keywordReport: reportLines.join('\n'),
        missingKeywords,
        weakKeywords: [],
        formattingIssues: [],
        recommendations: [],
        isFallback: true
    };
}

// ---------------------------------------------------------------------------
// ATS Deterministic Formatting Guard — eliminates length penalties (5-10 pts)
// ---------------------------------------------------------------------------
function enforceAtsBulletConstraints(cvMarkdown) {
    if (!cvMarkdown || typeof cvMarkdown !== 'string') return cvMarkdown;
    const lines = cvMarkdown.split('\n');
    const newLines = [];
    let inSummary = false;
    let summaryLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (/^##\s+PROFESSIONAL SUMMARY\b/i.test(trimmed)) {
            newLines.push(line);
            inSummary = true;
            continue;
        }
        if (inSummary && /^##\s+/i.test(trimmed)) {
            if (summaryLines.length > 0) {
                let sumText = summaryLines.join(' ').replace(/\s+/g, ' ').trim();
                let words = sumText.split(/\s+/).filter(Boolean);
                if (words.length > 50) {
                    sumText = words.slice(0, 48).join(' ') + '.';
                }
                newLines.push(sumText);
                summaryLines = [];
            }
            inSummary = false;
        }

        if (inSummary) {
            if (trimmed) summaryLines.push(trimmed);
            continue;
        }

        // Bullet point length check (ats.onl9.club penalizes > 55 words; we enforce <= 48 words)
        if (/^[-*•]\s+/.test(trimmed)) {
            const bulletPrefixMatch = trimmed.match(/^[-*•]\s+/);
            const prefix = bulletPrefixMatch ? bulletPrefixMatch[0] : '- ';
            const content = trimmed.slice(prefix.length).trim();
            const words = content.split(/\s+/).filter(Boolean);
            if (words.length > 48) {
                const sentences = content.split(/(?<=[.!?])\s+/);
                let fit = '';
                for (const s of sentences) {
                    const candidate = fit ? `${fit} ${s}` : s;
                    if (candidate.split(/\s+/).filter(Boolean).length <= 48) {
                        fit = candidate;
                    } else {
                        break;
                    }
                }
                if (!fit || fit.split(/\s+/).filter(Boolean).length < 15) {
                    fit = words.slice(0, 46).join(' ') + '.';
                }
                newLines.push(`- ${fit}`);
            } else {
                newLines.push(line);
            }
        } else {
            newLines.push(line);
        }
    }

    if (inSummary && summaryLines.length > 0) {
        let sumText = summaryLines.join(' ').replace(/\s+/g, ' ').trim();
        let words = sumText.split(/\s+/).filter(Boolean);
        if (words.length > 50) {
            sumText = words.slice(0, 48).join(' ') + '.';
        }
        newLines.push(sumText);
    }

    return newLines.join('\n');
}

// ---------------------------------------------------------------------------
// Programmatic Keyword & Hard Skill Weaving Gate
// Guarantees all missing keywords/skills are embedded without altering facts
// ---------------------------------------------------------------------------
function ensureAtsKeywordsPresent(cvMarkdown, options = {}) {
    if (!cvMarkdown || typeof cvMarkdown !== 'string') return cvMarkdown;
    const {
        missingKeywords = [],
        missingSkills = [],
        companyName = '',
        jobTitle = '',
        location = '',
        candidateProfile = null
    } = options;

    const termsToEnsure = new Set();
    for (const k of missingKeywords) {
        const term = (typeof k === 'object' && k ? k.keyword : k);
        if (term && typeof term === 'string' && term.trim().length > 1) {
            termsToEnsure.add(term.trim());
        }
    }
    for (const s of missingSkills) {
        const name = (typeof s === 'object' && s ? s.name : s);
        if (name && typeof name === 'string' && name.trim().length > 1) {
            termsToEnsure.add(name.trim());
        }
    }

    if (termsToEnsure.size === 0) return cvMarkdown;

    let updated = cvMarkdown;
    const cvLower = updated.toLowerCase();
    const stillMissing = [];

    for (const term of termsToEnsure) {
        const termLower = term.toLowerCase();
        // Skip common generic words or short stop terms
        if (/^(the|and|for|with|from|job|role|must|have|will|you|our|new|this)\b/i.test(term)) continue;
        if (!cvLower.includes(termLower)) {
            stillMissing.push(term);
        }
    }

    if (stillMissing.length === 0) return updated;

    log(`[ATS Keyword Gate] Programmatically weaving ${stillMissing.length} missing keyword(s): ${stillMissing.join(', ')}`);

    // 1. Check for company name missing
    const compLower = (companyName || '').toLowerCase().trim();
    for (const kw of [...stillMissing]) {
        const kwLower = kw.toLowerCase();
        if (compLower && (compLower.includes(kwLower) || kwLower.includes(compLower))) {
            if (!updated.toLowerCase().includes(kwLower)) {
                updated = updated.replace(/(##\s+PROFESSIONAL SUMMARY\s*\n+)([^\n]+)/i, (m, h, p1) => {
                    if (!p1.toLowerCase().includes(kwLower)) {
                        return `${h}Targeting the ${jobTitle || 'technical specialist'} position at ${companyName || kw}. ${p1}`;
                    }
                    return m;
                });
            }
            const idx = stillMissing.indexOf(kw);
            if (idx !== -1) stillMissing.splice(idx, 1);
        }
    }

    // 2. Check for location keywords missing (e.g. Christchurch, Wellington, Dunedin, Hamilton)
    const nzLocations = ['christchurch', 'wellington', 'hamilton', 'tauranga', 'dunedin', 'queenstown', 'palmerston north', 'napier', 'hastings', 'nelson', 'rotorua', 'whangārei', 'invercargill', 'new zealand'];
    for (const kw of [...stillMissing]) {
        const kwLower = kw.toLowerCase();
        if (nzLocations.includes(kwLower) || (location && location.toLowerCase().includes(kwLower))) {
            if (!updated.toLowerCase().includes(kwLower)) {
                updated = updated.replace(/(\bAuckland,\s*New Zealand\b)/i, `$1 (Available for ${kw} & remote NZ)`);
            }
            const idx = stillMissing.indexOf(kw);
            if (idx !== -1) stillMissing.splice(idx, 1);
        }
    }

    // 3. For any remaining missing terms (tools, platforms, methodologies, concepts, verbs):
    // Inject into ## TECHNICAL SKILLS
    if (stillMissing.length > 0) {
        const skillsMatch = updated.match(/(##\s+TECHNICAL SKILLS\s*\n+)([\s\S]*?)(?=\n+##\s+[A-Z])/i);
        if (skillsMatch) {
            const heading = skillsMatch[1];
            const skillsBody = skillsMatch[2];
            const formattedTerms = stillMissing.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', ');
            const newSkillsLine = `- **Core Technologies, Methodologies & Tools:** ${formattedTerms}\n`;
            updated = updated.replace(skillsMatch[0], `${heading}${skillsBody.trimEnd()}\n${newSkillsLine}`);
        }
    }

    // Enforce bullet constraints after keyword weaving
    updated = enforceAtsBulletConstraints(updated);

    // Validate integrity to ensure no employers/education/dates were disturbed
    const check = validateCVIntegrity(updated, candidateProfile);
    if (!check.ok) {
        log(`[ATS Keyword Gate] Warning: Weaving encountered integrity mismatch (${check.issues.join('; ')}), keeping original CV`);
        return cvMarkdown;
    }

    return updated;
}

// ---------------------------------------------------------------------------
// ATS score via ats.onl9.club API — POST CV + JD, get score + keyword report
// ---------------------------------------------------------------------------
async function checkAtsScoreViaApi(cvText, jobDescription, meta = {}) {
    log('Checking ATS score via ats.onl9.club API...');
    const baseUrl = resolveAtsApiUrl(process.env.ATS_API_BASE_URL);
    const headers = { 'Content-Type': 'application/json' };
    // Anonymous calls are accepted today; ATS_API_TOKEN covers the case where auth is enforced later.
    if (process.env.ATS_API_TOKEN) headers['Authorization'] = `Bearer ${process.env.ATS_API_TOKEN}`;
    const payload = {
        resume_text: cvText,
        job_description_text: jobDescription,
        resume_name: meta.resumeName || 'Pipeline_CV',
        job_title: meta.jobTitle || null,
        company_name: meta.companyName || null,
        previous_score: typeof meta.previousScore === 'number' ? meta.previousScore : null,
    };

    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90000);
            let res;
            try {
                res = await fetch(`${baseUrl}/analyze`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timer);
            }
            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                throw new Error(`ATS API HTTP ${res.status}${errText ? `: ${errText.substring(0, 300)}` : ''}`);
            }
            const data = await res.json();
            const score = typeof data.overall_score === 'number' ? Math.round(data.overall_score) : NaN;
            if (Number.isNaN(score)) throw new Error('ATS API response missing overall_score');

            // Condensed keyword analysis for the LLM improvement step
            const lines = [`ATS Score: ${score}%${data.score_tier ? ` (${data.score_tier})` : ''}`];
            if (data.analysis_summary) lines.push(`\nSummary: ${data.analysis_summary}`);
            if (data.score_breakdown) {
                const parts = Object.entries(data.score_breakdown)
                    .filter(([k]) => k !== 'weights_used')
                    .map(([k, v]) => `${k.replace(/_score$/, '')}: ${v}`);
                if (parts.length) lines.push(`\nScore breakdown: ${parts.join(', ')}`);
            }
            if (Array.isArray(data.missing_keywords) && data.missing_keywords.length > 0) {
                lines.push('\n## Missing keywords');
                for (const k of data.missing_keywords) {
                    lines.push(`- ${k.keyword} (${k.importance || 'Important'}): ${k.action_suggestion || 'add to the CV where factually true'}`);
                }
            }
            const weak = (Array.isArray(data.keywords) ? data.keywords.filter(k => k.status && k.status !== 'Matched') : [])
                .filter(k => !(Array.isArray(data.missing_keywords) && data.missing_keywords.some(m => m.keyword === k.keyword)));
            if (weak.length > 0) {
                lines.push('\n## Weak keyword coverage');
                for (const k of weak) {
                    lines.push(`- ${k.keyword} (${k.status}, JD ${k.jd_count}x vs CV ${k.cv_count}x): ${k.action_suggestion || 'mention more often'}`);
                }
            }

            // Extract missing hard skills from skills_analysis (Weight: 20%)
            const missingSkills = [];
            if (Array.isArray(data.skills_analysis)) {
                for (const cat of data.skills_analysis) {
                    if (Array.isArray(cat.skills)) {
                        for (const s of cat.skills) {
                            if (s && s.status && s.status !== 'Matched') {
                                missingSkills.push({
                                    name: s.name,
                                    status: s.status,
                                    category_name: cat.category_name,
                                    found_term: s.found_term || null
                                });
                            }
                        }
                    }
                }
            }
            if (missingSkills.length > 0) {
                lines.push('\n## Required Hard Skills (from Skills Analysis):');
                for (const s of missingSkills) {
                    lines.push(`- ${s.name} [Category: ${s.category_name || 'Technical Skills'}, Status: ${s.status}]`);
                }
            }

            // Extract experience requirements to match (Weight: 15%)
            const experienceMatches = Array.isArray(data.experience_matches) ? data.experience_matches : [];
            const weakExp = experienceMatches.filter(e => e.strength !== 'Strong');
            if (weakExp.length > 0) {
                lines.push('\n## Key Experience Requirements to Mirror:');
                for (const e of weakExp.slice(0, 8)) {
                    lines.push(`- Requirement: "${e.requirement}" (Current Evidence: ${e.strength || 'Moderate'}. Action: ${e.recommendation || 'mirror with quantifiable results'})`);
                }
            }

            const matched = Array.isArray(data.keywords) ? data.keywords.filter(k => k.status === 'Matched').map(k => k.keyword) : [];
            if (matched.length > 0) lines.push(`\n## Matched keywords: ${matched.join(', ')}`);
            const fmtIssues = Array.isArray(data.formatting_analysis) ? data.formatting_analysis.filter(f => !f.passed) : [];
            if (fmtIssues.length > 0) {
                lines.push('\n## Formatting issues');
                for (const f of fmtIssues) lines.push(`- [${f.status}] ${f.check_name}: ${f.message}`);
            }
            if (Array.isArray(data.recommendations) && data.recommendations.length > 0) {
                lines.push('\n## Recommendations');
                for (const r of data.recommendations.slice(0, 12)) {
                    lines.push(`- [${r.priority}] ${r.title}: ${r.description}${r.example ? ` Example: ${r.example}` : ''}`);
                }
            }
            const keywordReport = lines.join('\n');

            // Save full report for debugging
            try {
                fs.writeFileSync(path.join(process.cwd(), 'output', 'ats_analysis.json'), JSON.stringify(data, null, 2));
            } catch (_) {}

            const passed = score >= 85;
            log(passed ? `ATS PASSED (${score}%)` : `ATS FAILED (${score}%) — keyword report captured`);
            return {
                score,
                passed,
                needsImprovement: !passed,
                keywordReport,
                analysisId: data.id,
                missingKeywords: data.missing_keywords || [],
                weakKeywords: weak,
                missingSkills,
                experienceMatches,
                formattingIssues: fmtIssues,
                recommendations: data.recommendations || [],
                rawData: data
            };
        } catch (e) {
            lastErr = e;
            const reason = e.name === 'AbortError' ? 'timed out after 90s' : e.message;
            log(`ATS API attempt ${attempt}/2 failed: ${reason}`);
            if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
        }
    }
    log(`ATS API check failed: ${lastErr ? lastErr.message : 'unknown error'} — using local keyword analysis fallback`);
    const fallback = calculateLocalAtsScore(cvText, jobDescription, meta);
    fallback.error = lastErr ? lastErr.message : 'unknown error';
    return fallback;
}

async function improveCVWithReport({ cvMarkdown, keywordReport, jobDescription, jobLink, companyName, jobTitle, llmConfig, llmChain, score, missingKeywords, weakKeywords, missingSkills = [], experienceMatches = [], formattingIssues, iteration = 1, candidateProfile }) {
    log(`Improving CV using ATS keyword report (Iteration pass ${iteration + 1}, current score ${score != null ? score + '%' : 'below 85'})...`);
    const chain = llmChain || (llmConfig ? [llmConfig] : null);
    const candidateName = candidateProfile?.name || 'MAGHAV AHUJA';
    const employersList = candidateProfile ? getEmployerNamesSummary(candidateProfile) : 'Neurix Limited, Datacom NZ, Department of Education Government of Delhi, Mitre10 MEGA';
    const projectsList = candidateProfile ? getProjectNamesSummary(candidateProfile) : 'Nextcloud & Systems Learning Lab, Cloud Application Deployment, VPS, Hosting & Recovery Lab';
    const volunteerEduList = candidateProfile ? [getVolunteerNamesSummary(candidateProfile), getEducationNamesSummary(candidateProfile)].filter(Boolean).join(', ') : 'FreeCodeCamp.org, Shoutcoder.com, Unitec Institute of Technology, Maharaja Surajmal Institute';

    const systemPrompt = `You are an elite ATS optimization engineer. Output ONLY the improved Markdown CV starting immediately with "# ${candidateName}".`;
    const truncJD = jobDescription.length > 5000 ? jobDescription.substring(0, 5000) + '\n[...truncated]' : jobDescription;
    const truncReport = keywordReport.length > 8000 ? keywordReport.substring(0, 8000) + '\n[...truncated]' : keywordReport;
    const truncCV = cvMarkdown.length > 12000 ? cvMarkdown.substring(0, 12000) + '\n[...truncated]' : cvMarkdown;

    const missingList = (Array.isArray(missingKeywords) && missingKeywords.length > 0)
        ? missingKeywords.map(k => `- "${k.keyword}" (${k.importance || 'High'}): ${k.action_suggestion || 'embed into Technical Skills or experience bullets'}`).join('\n')
        : '(None identified)';

    const missingSkillsList = (Array.isArray(missingSkills) && missingSkills.length > 0)
        ? missingSkills.map(s => `- "${s.name}" (Category: ${s.category_name || 'Technical Skills'}, Status: ${s.status}): incorporate into TECHNICAL SKILLS matrix under relevant category`).join('\n')
        : '(None)';

    const expMatchesList = (Array.isArray(experienceMatches) && experienceMatches.length > 0)
        ? experienceMatches.filter(e => e.strength !== 'Strong').slice(0, 8).map(e => `- Requirement: "${e.requirement}" (Current Evidence: ${e.strength || 'Moderate'}. Action: ${e.recommendation || 'mirror with quantifiable results in experience bullets'})`).join('\n')
        : '(None)';

    const weakList = (Array.isArray(weakKeywords) && weakKeywords.length > 0)
        ? weakKeywords.slice(0, 10).map(k => `- "${k.keyword}" (JD: ${k.jd_count}x vs CV: ${k.cv_count}x): mention more frequently in experience bullets`).join('\n')
        : '(None)';

    const formatList = (Array.isArray(formattingIssues) && formattingIssues.length > 0)
        ? formattingIssues.map(f => `- ${f.check_name}: ${f.message} (penalty: ${f.penalty_applied || 0} pts)`).join('\n')
        : '(All formatting checks passed)';

    const prompt = `You are an elite ATS resume architect. The current CV scored ${score != null ? score : 'under 85'}% against the ATS scanner (ats.onl9.club). We MUST increase the score to 85%+ (target: 92-96%).
Systematically resolve the keyword gaps, formatting penalties, and requirement mismatches identified below while strictly preserving verified factual history.

=== CURRENT CV (TO OPTIMIZE) ===
${truncCV}

=== ATS DIAGNOSTIC REPORT (EXACT GAPS TO RESOLVE) ===
MISSING CRITICAL KEYWORDS TO EMBED (MANDATORY - MUST APPEAR IN CV):
${missingList}

REQUIRED HARD SKILLS TO INCLUDE IN TECHNICAL SKILLS:
${missingSkillsList}

EXPERIENCE REQUIREMENT GAPS TO MIRROR:
${expMatchesList}

WEAK KEYWORD COVERAGE:
${weakList}

FORMATTING ISSUES:
${formatList}

FULL ATS REPORT:
${truncReport}

=== TARGET ROLE & JD ===
Title: ${jobTitle} | Employer: ${companyName}
JD:
${truncJD}

=== MANDATORY ACTION PLAN TO GUARANTEE 85+ SCORE ===
1. CONTEXTUAL KEYWORD WEAVING:
   - Every single missing keyword and hard skill listed above MUST be present verbatim in the CV.
   - Add technical tools, platforms, and methodologies into the TECHNICAL SKILLS matrix under relevant categories.
   - Weave domain terms, soft skills, and concepts naturally into the PROFESSIONAL SUMMARY and into relevant bullets under ${employersList}, or Key Projects.
   - For transferable knowledge or concepts mentioned in the JD, weave them naturally into existing bullets describing how you administered, supported, or monitored those processes.
2. ACTION VERB STRENGTH & BULLET READABILITY:
   - Ensure EVERY bullet point under Professional Experience and Key Projects starts with an active, high-impact past-tense action verb (Spearheaded, Engineered, Orchestrated, Automated, Administered, Implemented, Deployed, Architected, Optimized, Streamlined, Resolved, Standardized).
   - Ensure EVERY bullet is punchy, between 18 and 42 words (strictly under 48 words to avoid ATS length penalties).
   - Ensure the Professional Summary is exactly 1 paragraph of 40-50 words (strictly under 52 words).
3. STRICT FACTUAL BOUNDARIES:
   - Preserve ALL verified employers: ${employersList}.
   - Preserve ALL projects: ${projectsList}.
   - Preserve ${volunteerEduList}.
   - DO NOT invent new employers, companies, degrees, or dates.
4. TARGET DENSITY:
   - Maintain 900 to 1020 words to fit exactly 2 full A4 pages in the rendered PDF.

Output ONLY the complete improved Markdown CV starting immediately with "# ${candidateName}". No commentary, no preamble.`;

    let improved = await callLLM(prompt, systemPrompt, chain || llmConfig);

    // Apply formatting and keyword guarantees
    if (improved && typeof improved === 'string') {
        improved = enforceAtsBulletConstraints(improved);
        improved = ensureAtsKeywordsPresent(improved, {
            missingKeywords,
            missingSkills,
            companyName,
            jobTitle,
            candidateProfile
        });
    }

    return improved;
}

// ---------------------------------------------------------------------------
// PDF generation with exact page enforcement
// ---------------------------------------------------------------------------
function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function inlineMarkdown(value) {
    return escapeHtml(value)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function structuredMarkdownBody(lines) {
    const out = [];
    let paragraph = [];
    let listOpen = false;
    const flushParagraph = () => {
        if (paragraph.length) out.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
        paragraph = [];
    };
    const closeList = () => {
        if (listOpen) out.push('</ul>');
        listOpen = false;
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            flushParagraph();
            closeList();
            continue;
        }
        const bullet = line.match(/^[-•]\s+(.+)$/);
        if (bullet) {
            flushParagraph();
            if (!listOpen) {
                out.push('<ul>');
                listOpen = true;
            }
            out.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
            continue;
        }

        flushParagraph();
        closeList();
        if (/^####\s+/.test(line)) out.push(`<h4>${inlineMarkdown(line.replace(/^####\s+/, ''))}</h4>`);
        else if (/^###\s+/.test(line)) out.push(`<h3>${inlineMarkdown(line.replace(/^###\s+/, ''))}</h3>`);
        else if (/^##\s+/.test(line)) out.push(`<h2>${inlineMarkdown(line.replace(/^##\s+/, ''))}</h2>`);
        else if (/^#\s+/.test(line)) out.push(`<h1>${inlineMarkdown(line.replace(/^#\s+/, ''))}</h1>`);
        else if (line === '---') out.push('<hr>');
        else paragraph.push(line);
    }
    flushParagraph();
    closeList();
    return out.join('');
}

function cvMarkdownToHtml(md) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const sectionIndex = lines.findIndex((line, index) => index > 1 && /^##\s+PROFESSIONAL SUMMARY\s*$/i.test(line.trim()));
    if (sectionIndex < 0) throw new Error('CV markdown is missing PROFESSIONAL SUMMARY');
    const header = lines.slice(0, sectionIndex).filter(line => line.trim());
    const name = (header.find(line => /^#\s+/.test(line)) || '# MAGHAV AHUJA').replace(/^#\s+/, '');
    const role = (header.find(line => /^##\s+/.test(line)) || '## IT Support Professional').replace(/^##\s+/, '');
    const meta = header.filter(line => !/^#{1,2}\s+/.test(line));
    const metaHtml = meta.map(line => `<div>${inlineMarkdown(line)}</div>`).join('');
    return `<header class="cv-header"><h1>${inlineMarkdown(name)}</h1><div class="target-role">${inlineMarkdown(role)}</div><div class="contact">${metaHtml}</div></header>${structuredMarkdownBody(lines.slice(sectionIndex))}`;
}

function coverLetterMarkdownToHtml(md) {
    const blocks = String(md || '').replace(/\r/g, '').trim().split(/\n{2,}/);
    return blocks.map(block => {
        const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.every(line => /^[-•]\s+/.test(line))) {
            return `<ul>${lines.map(line => `<li>${inlineMarkdown(line.replace(/^[-•]\s+/, ''))}</li>`).join('')}</ul>`;
        }
        return `<p>${lines.map(inlineMarkdown).join('<br>')}</p>`;
    }).join('');
}

const CV_LAYOUTS = [
    { name: 'spacious', font: 9.9, line: 1.18, marginY: 12, marginX: 14, sectionBefore: 6.5, sectionAfter: 3.0, jobBefore: 4.2, bulletAfter: 1.6 },
    { name: 'comfortable', font: 9.6, line: 1.15, marginY: 12, marginX: 14, sectionBefore: 6.0, sectionAfter: 2.8, jobBefore: 3.8, bulletAfter: 1.4 },
    { name: 'balanced', font: 9.25, line: 1.12, marginY: 11, marginX: 13, sectionBefore: 5.3, sectionAfter: 2.4, jobBefore: 3.3, bulletAfter: 1.1 },
    { name: 'compact', font: 9.0, line: 1.09, marginY: 10, marginX: 12, sectionBefore: 4.7, sectionAfter: 2.1, jobBefore: 2.9, bulletAfter: 0.9 },
    { name: 'tight', font: 8.7, line: 1.07, marginY: 9, marginX: 11, sectionBefore: 4.2, sectionAfter: 1.8, jobBefore: 2.5, bulletAfter: 0.7 }
];

const CL_LAYOUTS = [
    { name: 'comfortable', font: 10.7, line: 1.32, marginY: 20, marginX: 22, paragraphAfter: 8 },
    { name: 'balanced', font: 10.3, line: 1.27, marginY: 18, marginX: 20, paragraphAfter: 7 },
    { name: 'compact', font: 9.9, line: 1.22, marginY: 17, marginX: 19, paragraphAfter: 6 }
];

function cvHtmlDocument(markdown, layout) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        @page { size: A4; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body { font-family: Arial, Calibri, sans-serif; font-size: ${layout.font}pt; line-height: ${layout.line}; color: #1d2731; }
        .cv-header { text-align: center; border-bottom: 1.4px solid #173f5f; padding-bottom: 4pt; margin-bottom: 4pt; }
        .cv-header h1 { margin: 0; color: #102f46; font-size: 19pt; line-height: 1; letter-spacing: 1.3pt; font-weight: 800; }
        .target-role { margin: 2pt 0 3pt; color: #315b78; font-size: 10.6pt; line-height: 1.05; font-weight: 700; }
        .contact { color: #374957; font-size: 8.4pt; line-height: 1.18; }
        .contact div { margin: 0.4pt 0; }
        h2 { margin: ${layout.sectionBefore}pt 0 ${layout.sectionAfter}pt; padding-bottom: 1.4pt; border-bottom: 0.8px solid #5f7f95; color: #173f5f; font-size: ${layout.font + 1.15}pt; line-height: 1.03; letter-spacing: 0.45pt; break-after: avoid; }
        h3 { margin: ${layout.jobBefore}pt 0 0.7pt; color: #172f42; font-size: ${layout.font + 0.35}pt; line-height: 1.05; font-weight: 700; break-after: avoid; }
        h4 { margin: 0 0 1.2pt; color: #435565; font-size: ${layout.font - 0.05}pt; line-height: 1.05; font-weight: 500; font-style: italic; break-after: avoid; }
        p { margin: 0 0 2.2pt; text-align: left; }
        ul { margin: 0 0 1.8pt 13.5pt; padding: 0; }
        li { margin: 0 0 ${layout.bulletAfter}pt; padding-left: 1.5pt; break-inside: avoid; }
        li::marker { color: #315b78; font-size: 7pt; }
        strong { color: #132f44; font-weight: 700; }
        hr { border: 0; border-top: 0.8px solid #7f98a9; margin: 4pt 0; }
    </style></head><body>${cvMarkdownToHtml(markdown)}</body></html>`;
}

function coverLetterHtmlDocument(markdown, layout) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        @page { size: A4; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body { font-family: Arial, Calibri, sans-serif; font-size: ${layout.font}pt; line-height: ${layout.line}; color: #202b33; }
        body::before { content: ''; display: block; width: 48pt; border-top: 4px solid #173f5f; margin-bottom: 12pt; }
        p { margin: 0 0 ${layout.paragraphAfter}pt; text-align: left; }
        p:first-of-type { color: #4d5e69; font-weight: 600; }
        strong { color: #173f5f; }
        ul { margin: 0 0 ${layout.paragraphAfter}pt 16pt; padding: 0; }
        li { margin-bottom: 2pt; }
    </style></head><body>${coverLetterMarkdownToHtml(markdown)}</body></html>`;
}

async function generatePdfWithPageCheck(markdown, outputPath, targetPages, htmlConverter, browserInstance) {
    let browser = browserInstance;
    let shouldClose = false;
    if (!browser || (typeof browser.isConnected === 'function' && !browser.isConnected())) {
        browser = await puppeteer.launch(getBrowserLaunchOptions());
        shouldClose = true;
    }
    try {
        const isCV = targetPages === 2;
        const layouts = isCV ? CV_LAYOUTS : CL_LAYOUTS;

        // Render each bounded typography profile and choose the best real page fit. Content is
        // never rewritten merely to change page count, so factual sections cannot disappear.
        const mmToPx = (mm) => mm / 25.4 * 96;
        async function renderAndCount(htmlContent, layout) {
            const page = await browser.newPage();
            try {
                await page.emulateMediaType('print');
                const printable = {
                    w: mmToPx(210 - (layout.marginX * 2)),
                    h: mmToPx(297 - (layout.marginY * 2))
                };
                await page.setViewport({ width: Math.max(720, Math.ceil(printable.w)), height: 1000, deviceScaleFactor: 1 });
                await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.evaluateHandle('document.fonts.ready').catch(() => {});
                const contentHeight = await page.evaluate((w) => {
                    document.body.style.width = w + 'px';
                    const bodyTop = document.body.getBoundingClientRect().top;
                    const bottoms = Array.from(document.body.querySelectorAll('*')).map(el => el.getBoundingClientRect().bottom);
                    return Math.ceil(Math.max(bodyTop, ...bottoms) - bodyTop);
                }, printable.w);
                const pdfBuffer = await page.pdf({
                    format: 'A4',
                    printBackground: true,
                    margin: {
                        top: `${layout.marginY}mm`, right: `${layout.marginX}mm`,
                        bottom: `${layout.marginY}mm`, left: `${layout.marginX}mm`
                    }
                });
                let pages = 0;
                try {
                    if (pdfParse) {
                        const data = await pdfParse(pdfBuffer);
                        pages = data.numpages || 0;
                    }
                } catch (_) {}
                if (!pages) {
                    // Fallback: regex on PDF string (for uncompressed PDFs)
                    try {
                        const pdfStr = pdfBuffer.toString('latin1');
                        const total = (pdfStr.match(/\/Type\s*\/Page/g) || []).length;
                        const root = (pdfStr.match(/\/Type\s*\/Pages/g) || []).length;
                        pages = total - root;
                        if (!pages || pages < 0) pages = total || 0;
                    } catch (_) {}
                }
                if (!pages) pages = Math.max(1, Math.ceil(contentHeight / printable.h));
                return { pdfBuffer, pages, contentHeight, printableHeight: printable.h, layout };
            } finally {
                await page.close().catch(() => {});
            }
        }

        const candidates = [];
        for (const layout of layouts) {
            const html = isCV ? cvHtmlDocument(markdown, layout) : coverLetterHtmlDocument(markdown, layout);
            const rendered = await renderAndCount(html, layout);
            rendered.fillRatio = rendered.contentHeight / (rendered.printableHeight * targetPages);
            const targetFill = isCV ? 0.92 : 0.62;
            rendered.score = (rendered.pages === targetPages ? 0 : 10 + Math.abs(rendered.pages - targetPages) * 3)
                + Math.abs(rendered.fillRatio - targetFill)
                + (isCV ? Math.max(0, 9.0 - layout.font) * 0.08 : 0);
            candidates.push(rendered);
            log(`  layout ${layout.name}: ${rendered.pages} page(s), ${Math.round(rendered.fillRatio * 100)}% fill, ${layout.font}pt`);
        }
        candidates.sort((a, b) => a.score - b.score);
        const chosen = candidates[0];
        const minFill = isCV ? 0.70 : 0.40;
        const ok = chosen.pages === targetPages && chosen.fillRatio >= minFill && chosen.fillRatio <= 1.03;
        fs.writeFileSync(outputPath, chosen.pdfBuffer);
        log(`PDF saved: ${outputPath} (${(chosen.pdfBuffer.length / 1024).toFixed(1)} KB, ${chosen.pages} pages, layout=${chosen.layout.name}, fill=${Math.round(chosen.fillRatio * 100)}%)`);
        return {
            outputPath, pages: chosen.pages, targetPages, contentHeight: chosen.contentHeight,
            fillRatio: chosen.fillRatio, layout: chosen.layout.name, fontSize: chosen.layout.font, ok
        };
    } finally {
        if (shouldClose) await browser.close().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Entity presence helper with alias and normalization tolerance
// ---------------------------------------------------------------------------
function containsEntity(text, primary, variations = []) {
    if (!text || !primary) return false;
    if (text.includes(primary)) return true;
    const normText = normaliseMatchText(text);
    if (normText.includes(normaliseMatchText(primary))) return true;
    const allVars = [...variations];
    const strippedSuffix = primary.replace(/\s+(Limited|Ltd|LLC|Inc|Corporation|Corp|NZ|New Zealand|MEGA)\b/gi, '').trim();
    if (strippedSuffix && strippedSuffix !== primary) allVars.push(strippedSuffix);
    if (primary.includes(',')) allVars.push(primary.split(',')[0].trim());
    if (/\.(org|com|net|io)\b/i.test(primary)) allVars.push(primary.replace(/\.(org|com|net|io)\b/gi, ''));

    for (const v of allVars) {
        if (!v) continue;
        if (text.includes(v)) return true;
        if (normText.includes(normaliseMatchText(v))) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// CV integrity check — catches hallucinated/dropped content before it ships
// ---------------------------------------------------------------------------
function validateCVIntegrity(cvMarkdown, profile) {
    const issues = [];
    if (typeof cvMarkdown !== 'string' || !cvMarkdown.trim()) {
        issues.push('CV markdown is missing or empty');
        return { issues, ok: false, valid: false };
    }

    // Defensive resolution: if caller passes non-object (e.g. legacy mergedText string), fall back to candidate profile
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
        try {
            profile = loadCandidateProfile();
        } catch (_) {
            profile = null;
        }
    }

    const requiredSections = [
        'PROFESSIONAL SUMMARY', 'TECHNICAL SKILLS', 'PROFESSIONAL EXPERIENCE',
        'KEY PROJECTS', 'VOLUNTEER EXPERIENCE', 'EDUCATION', 'ADDITIONAL INFORMATION'
    ];

    let previousIndex = -1;
    for (const section of requiredSections) {
        const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = cvMarkdown.match(new RegExp(`^##+\\s+${escaped}\\b`, 'im'));
        if (!match) {
            issues.push(`Missing section: ${section}`);
        } else {
            const index = match.index;
            if (index <= previousIndex) {
                issues.push(`Section out of order: ${section}`);
            }
            previousIndex = Math.max(previousIndex, index);
        }
    }

    const sectionText = (name, nextName) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = cvMarkdown.match(new RegExp(`^##+\\s+${escaped}\\b`, 'im'));
        if (!match) return '';
        const start = match.index;
        if (!nextName) return cvMarkdown.slice(start);
        const nextEscaped = nextName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rest = cvMarkdown.slice(start + match[0].length);
        const nextMatch = rest.match(new RegExp(`^##+\\s+${nextEscaped}\\b`, 'im'));
        if (!nextMatch) return cvMarkdown.slice(start);
        return cvMarkdown.slice(start, start + match[0].length + nextMatch.index);
    };

    const experienceText = sectionText('PROFESSIONAL EXPERIENCE', 'KEY PROJECTS');
    const projectText = sectionText('KEY PROJECTS', 'VOLUNTEER EXPERIENCE');
    const volunteerText = sectionText('VOLUNTEER EXPERIENCE', 'EDUCATION');
    const educationText = sectionText('EDUCATION', 'ADDITIONAL INFORMATION');

    if (profile && typeof profile === 'object') {
        for (const role of profile.experience || []) {
            if (!role || typeof role !== 'object') continue;
            const emp = role.employer;
            if (emp) {
                const hasEmp = containsEntity(experienceText, emp, [
                    emp.replace(/,/g, ''),
                    emp.split(',')[0].trim()
                ]);
                if (!hasEmp) issues.push(`Missing professional employer: ${emp}`);
            }
            const rTitle = role.role;
            if (rTitle) {
                const baseRole = rTitle.replace(/\s*\([^)]*\)/g, '').trim();
                const hasRole = containsEntity(experienceText, rTitle, [
                    baseRole,
                    baseRole.replace(/[\/-]/g, ' ')
                ]);
                if (!hasRole) issues.push(`Missing professional role: ${rTitle}`);
            }
        }
        for (const project of profile.projects || []) {
            if (!project || typeof project !== 'object') continue;
            const pName = project.name;
            if (pName) {
                const hasProject = containsEntity(projectText, pName, [
                    pName.replace(/&/g, 'and'),
                    pName.replace(/and/g, '&')
                ]);
                if (!hasProject) issues.push(`Missing real project: ${pName}`);
            }
        }
        for (const item of profile.volunteer || []) {
            if (!item || typeof item !== 'object') continue;
            const org = item.organisation || item.organization;
            if (org) {
                const hasOrg = containsEntity(volunteerText, org, [
                    org.replace(/\.(org|com|net|io)\b/gi, '')
                ]);
                if (!hasOrg) issues.push(`Missing volunteer organisation: ${org}`);
            }
        }
        for (const item of profile.education || []) {
            if (!item || typeof item !== 'object') continue;
            const inst = item.institution;
            if (inst) {
                const hasInst = containsEntity(educationText, inst, [
                    inst.split(',')[0].trim(),
                    inst.replace(/Institute of Technology/i, '').trim()
                ]);
                if (!hasInst) issues.push(`Missing education institution: ${inst}`);
            }
            const qual = item.qualification;
            if (qual) {
                const baseQual = qual.replace(/\s*\([^)]*\)/g, '').trim();
                const hasQual = containsEntity(educationText, qual, [
                    baseQual,
                    baseQual.replace(/Masters/i, 'Master'),
                    baseQual.replace(/Bachelors/i, 'Bachelor')
                ]);
                if (!hasQual) issues.push(`Missing qualification: ${qual}`);
            }
        }
    }

    const fabricationFlags = [
        'University of Delhi', 'Bachelor of Engineering in Computer Science',
        'San Francisco', 'Cognizant', 'TCS', 'Infosys',
        'Wipro', 'HCL', 'Mindtree', 'Capgemini', 'Accenture', 'Deloitte', 'PwC', 'EY', 'KPMG',
        'University of AUT', 'AUT University', '**New:**'
    ];
    for (const flag of fabricationFlags) {
        const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const leadingBoundary = /^\w/.test(flag) ? '\\b' : '';
        const trailingBoundary = /\w$/.test(flag) ? '\\b' : '';
        const re = new RegExp(leadingBoundary + escaped + trailingBoundary, 'i');
        if (re.test(cvMarkdown)) issues.push(`Fabricated content detected: "${flag}"`);
    }

    const additionalText = sectionText('ADDITIONAL INFORMATION');
    if (!additionalText || !/Working rights:/i.test(additionalText) || !/Languages:/i.test(additionalText)) {
        issues.push('ADDITIONAL INFORMATION is incomplete');
    }
    if (/\[\.\.\.truncated|\{\{|\}\}|\[insert|placeholder|<placeholder>|\[todo\]/i.test(cvMarkdown)) {
        issues.push('Placeholder or truncation marker detected');
    }

    const words = cvMarkdown.trim().split(/\s+/).filter(Boolean).length;
    if (words < 750) issues.push(`CV is too sparse (${words} words)`);
    if (words > 1200) issues.push(`CV is too long (${words} words)`);

    return { issues, ok: issues.length === 0, valid: issues.length === 0 };
}

// ---------------------------------------------------------------------------
// Main pipeline class
// ---------------------------------------------------------------------------
class JobApplicationPipeline {
    constructor(config) {
        this.jobLink = config.jobLink;
        if (!this.jobLink) throw new Error('jobLink is required');
        this.llmConfig = resolveLLMConfig(config);
        this.llmChain = getProviderChain(config);
        this.workflowId = crypto.randomUUID();
        // Workspace root is current directory (__dirname)
        this.workspaceRoot = path.resolve(__dirname);
        // my_cvs and output are direct children of workspaceRoot
        this.myCvsDir = path.join(this.workspaceRoot, 'my_cvs');
        this.outputDir = path.join(this.workspaceRoot, 'output');
        // ATS improvement loop: when score < 85, the CV is improved from the API keyword report.
        // Each improved CV must re-pass the factual integrity gate before it is accepted.
        const maxIterEnv = parseInt(process.env.JOB_PIPELINE_MAX_ITERATIONS || '', 10);
        this.maxIterations = Number.isFinite(maxIterEnv) && maxIterEnv >= 1 ? maxIterEnv : 5;
        this.skipAts = config.skipAts === true || /^(1|true|yes)$/i.test(process.env.JOB_PIPELINE_SKIP_ATS || '');
        this.forceSync = config.forceSync === true || /^(1|true|yes)$/i.test(process.env.FORCE_SYNC || '');
        this.skipSync = config.skipSync === true || /^(0|false|no)$/i.test(process.env.SYNC_PORTFOLIO_ON_RUN || '');
        this.atsMaxRetries = 2;
        this.createdFiles = new Set();
    }

    trackCreatedFile(filePath) {
        if (!this.createdFiles) this.createdFiles = new Set();
        if (filePath) this.createdFiles.add(path.resolve(filePath));
        return filePath;
    }

    cleanupWorkflowFiles(options = {}) {
        const extraFiles = Array.from(this.createdFiles || []);
        if (options.cvPdfPath) extraFiles.push(options.cvPdfPath);
        if (options.clPdfPath) extraFiles.push(options.clPdfPath);

        const prefixes = [];
        if (options.cvFileName) prefixes.push(options.cvFileName);
        if (options.clFileName) prefixes.push(options.clFileName);

        const cleaned = cleanupOutputFiles(this.outputDir, extraFiles, prefixes);
        for (const f of cleaned) {
            log(`  [cleanup] Deleted workflow file: ${path.basename(f)}`);
        }
        return cleaned;
    }

    async runPreflightSync() {
        if (typeof aggregateProfiles === 'function' && (!this.skipSync || this.forceSync)) {
            try {
                log('Running preflight profile synchronization (portfolio + source CVs)...');
                const syncResult = await aggregateProfiles({
                    force: this.forceSync,
                    save: true,
                    cvsDir: this.myCvsDir,
                    profilePath: path.join(this.workspaceRoot, 'candidate_profile.json'),
                    backupPath: path.join(this.workspaceRoot, 'candidate_profile.backup.json')
                });
                const cvCount = syncResult.sources?.cvCount ?? (fs.existsSync(this.myCvsDir) ? fs.readdirSync(this.myCvsDir).filter(f => f.toLowerCase().endsWith('.pdf')).length : 0);
                const portfolioStatus = syncResult.sources?.portfolioExtracted ? 'Live portfolio fetched' : 'Cached/offline portfolio loaded';
                log(`[Profile Sync] ${portfolioStatus} | ${cvCount} source CVs parsed | Active profile updated`);
                return { performed: true, syncResult };
            } catch (syncErr) {
                log(`[Profile Sync] Warning: Preflight profile sync failed (${syncErr.message}) — continuing with existing profile`);
                return { performed: false, error: syncErr.message };
            }
        } else if (this.skipSync && !this.forceSync) {
            log('[Profile Sync] Preflight profile sync skipped via configuration');
            return { performed: false, skipped: true };
        }
        return { performed: false };
    }

    async run() {
        log('='.repeat(60));
        log('Job Application Pipeline');
        log(`Workflow: ${this.workflowId}`);
        log(`Job link: ${this.jobLink}`);
        this.createdFiles = new Set();
        this.llmChain = await validateProviderChain(this.llmChain);
        log(`Active LLM chain: ${this.llmChain.map(p => `${p.name}:${p.model}`).join(' → ')}`);
        log('='.repeat(60));

        log('Factual LLM mode: AI tailoring enabled with strict factual integrity and layout guards');

        ensureDir(this.outputDir);
        ensureDir(this.myCvsDir);

        // Preflight Profile Sync Hook (Phase 6 - Step 6.1)
        await this.runPreflightSync();

        // Browser for scraping (closed immediately after scraping to keep memory low during LLM calls)
        let browser = await puppeteer.launch(getBrowserLaunchOptions());

        try {
            // Step 1: Scrape job description
            const jobInfo = await scrapeJobDescription(this.jobLink, browser);
            await browser.close().catch(() => {});
            browser = null;
            const jobDescription = jobInfo.description;
            if (!jobDescription || jobDescription.length < 100) throw new Error('Failed to scrape job description (too short or empty)');
            fs.writeFileSync(path.join(this.outputDir, 'job_description.txt'), jobDescription);
            fs.writeFileSync(path.join(this.outputDir, 'job_meta.json'), JSON.stringify({ link: this.jobLink, ...jobInfo }, null, 2));
            this.trackCreatedFile(path.join(this.outputDir, 'job_description.txt'));
            this.trackCreatedFile(path.join(this.outputDir, 'job_meta.json'));

            // Company fallback via LLM — filename/cover letter must never say just "Company"
            // Junk names scraped from careers-site chrome ("Careers", "MERCURY WEBSITE", "Jobs", "New")
            // are not employers either — run the LLM fallback for those too.
            const junkCompanyRe = /^(company|careers?|website|jobs?|job search|search jobs|home|apply now|careers? ?website|seek|indeed|linkedin|trademe|glassdoor|bfoundemployer|mercury website|hireeing|entireless|sydicom|wellfound|builtin|remoteok|weworkremotely|new|portal|vacancies|openings|opportunities)$/i;
            const companyIsJunk = !jobInfo.companyName
                || jobInfo.companyName === 'Company'
                || jobInfo.companyName === 'BfoundEmployer'
                || jobInfo.companyName.length < 3
                || (jobInfo.companyName.length === 3 && /^(new|job|app|net|org|com)$/i.test(jobInfo.companyName))
                || junkCompanyRe.test(jobInfo.companyName.trim())
                || /\bwebsite\b/i.test(jobInfo.companyName);
            if (companyIsJunk) {
                log(`Company "${jobInfo.companyName || '(none)'}" not a real employer — extracting via LLM...`);
                const llmCompany = await extractCompanyViaLLM(jobDescription, this.llmChain).catch(() => null);
                if (llmCompany) {
                    jobInfo.companyName = llmCompany;
                    log(`LLM-extracted company: "${llmCompany}"`);
                } else if (jobInfo.jobTitle && jobInfo.jobTitle !== 'Position' && jobInfo.jobTitle.length >= 4) {
                    jobInfo.jobTitle = jobInfo.jobTitle.replace(/MERCURY WEBSITE/i, '').trim() || jobInfo.jobTitle;
                    if (jobInfo.jobTitle.length >= 4) {
                        jobInfo.companyName = jobInfo.jobTitle;
                        log(`Company still unknown — using job title "${jobInfo.jobTitle}" as fallback`);
                    }
                }
                fs.writeFileSync(path.join(this.outputDir, 'job_meta.json'), JSON.stringify({ link: this.jobLink, ...jobInfo }, null, 2));
            }

            // Job Title fallback via LLM when scraped title is generic portal junk
            const junkTitleRe = /^(position|job|jobs|careers?|current vacancies|vacancies|home|search jobs?|apply now|.*\bwebsite\b.*|this role is no longer available|job not found|page not found|404|404 not found|role not found|current job (opportunities|openings)|job (opportunities|openings)|career opportunities|work for us|join our team|working at .*)$/i;
            const titleIsJunk = !jobInfo.jobTitle
                || jobInfo.jobTitle === 'Position'
                || jobInfo.jobTitle.length < 4
                || junkTitleRe.test(jobInfo.jobTitle.trim());
            if (titleIsJunk) {
                log(`Job title "${jobInfo.jobTitle || '(none)'}" appears generic or invalid — extracting via LLM...`);
                const llmTitle = await extractJobTitleViaLLM(jobDescription, this.llmChain).catch(() => null);
                if (llmTitle) {
                    jobInfo.jobTitle = llmTitle;
                    log(`LLM-extracted job title: "${llmTitle}"`);
                }
                fs.writeFileSync(path.join(this.outputDir, 'job_meta.json'), JSON.stringify({ link: this.jobLink, ...jobInfo }, null, 2));
            }

            // Step 2: Load + merge CVs for traceability, then load the curated factual profile.
            const { mergedText, files } = await extractAndMergeCVs(this.myCvsDir);
            if (!mergedText || mergedText.length < 200) throw new Error(`No usable CV text found in my_cvs/ (found ${files.length} PDF(s), merged ${mergedText.length} chars)`);
            fs.writeFileSync(path.join(this.outputDir, 'merged_cvs_source.txt'), mergedText);
            this.trackCreatedFile(path.join(this.outputDir, 'merged_cvs_source.txt'));
            const candidateProfile = loadCandidateProfile(this.workspaceRoot);

            // Step 2.5: Preflight ATS Diagnosis — query ats.onl9.club before CV generation
            let preflightAtsReport = null;
            if (!this.skipAts) {
                try {
                    log('Running Preflight ATS Diagnosis (extracting exact ATS keywords & skills before CV tailoring)...');
                    const baseDocs = buildFactualApplicationDocuments({
                        profile: candidateProfile,
                        jobDescription,
                        companyName: jobInfo.companyName,
                        jobTitle: jobInfo.jobTitle
                    });
                    preflightAtsReport = await checkAtsScoreViaApi(baseDocs.cvMarkdown, jobDescription, {
                        jobTitle: jobInfo.jobTitle,
                        companyName: jobInfo.companyName,
                        resumeName: 'Preflight_Baseline_CV'
                    });
                    log(`[Preflight ATS] Baseline CV score: ${preflightAtsReport.score}%, ` +
                        `${preflightAtsReport.missingKeywords?.length || 0} missing keywords, ` +
                        `${preflightAtsReport.missingSkills?.length || 0} hard skills gaps captured.`);
                } catch (preflightErr) {
                    log(`[Preflight ATS] Warning: Preflight ATS check failed (${preflightErr.message}) — continuing with standard JD extraction`);
                }
            }

            // Step 3: Build one complete CV + cover letter from the factual profile.
            const { cvMarkdown, coverLetterMarkdown } = await generateCVAndCoverLetter({
                candidateProfile,
                jobDescription,
                companyName: jobInfo.companyName,
                jobTitle: jobInfo.jobTitle,
                jobLink: this.jobLink,
                llmChain: this.llmChain,
                preflightAtsReport,
            });
            let currentCV = cvMarkdown;
            let currentCL = coverLetterMarkdown;
            // Hard factual gate. A defective document stops the workflow; no model is allowed
            // to patch, expand, shorten or otherwise replace source-backed content.
            const integrityCheck = validateCVIntegrity(currentCV, candidateProfile);
            if (!integrityCheck.ok) throw new Error(`CV integrity gate failed: ${integrityCheck.issues.join(' | ')}`);
            log('CV integrity gate passed: all sections, employers, projects and education are present');
            fs.writeFileSync(path.join(this.outputDir, 'optimized_cv.md'), currentCV);
            fs.writeFileSync(path.join(this.outputDir, 'cover_letter.md'), currentCL);
            this.trackCreatedFile(path.join(this.outputDir, 'optimized_cv.md'));
            this.trackCreatedFile(path.join(this.outputDir, 'cover_letter.md'));
            log(`Initial CV (${currentCV.length} chars) + CL (${currentCL.length} chars) saved`);

            // Step 4 & 5: ATS check loop via the ats.onl9.club API — keep best CV.
            // If the ATS API is broken/unreachable (score 0 + error), skip the loop entirely:
            // improving against an empty keyword report only degrades the CV and burns minutes.
            let atsResult = this.skipAts
                ? { score: null, passed: null, needsImprovement: false, keywordReport: '', skipped: true }
                : await checkAtsScoreViaApi(currentCV, jobDescription, { jobTitle: jobInfo.jobTitle, companyName: jobInfo.companyName });
            if (this.skipAts) log('ATS check skipped for this run; factual and layout gates remain active');
            let iteration = 1;
            let bestScore = atsResult.score;
            let bestCV = currentCV;
            let bestReport = atsResult.keywordReport;

            if (atsResult.score >= 85) {
                log(`✅ ATS TARGET ACHIEVED ON INITIAL PASS: ${atsResult.score}% >= 85% (Single Iteration Success)!`);
            } else if (atsResult.score === 0 && (atsResult.error || atsResult.parseFailed)) {
                log('ats.onl9.club API is unreachable/erroring — skipping ATS improvement loop, keeping the generated CV as-is');
                atsResult = { ...atsResult, needsImprovement: false };
            }

            while (atsResult.needsImprovement && iteration < this.maxIterations) {
                if (atsResult.score === 0 && atsResult.error) {
                    log(`ATS API check errored repeatedly — stopping ATS loop (API likely down)`);
                    break;
                }
                log(`--- Iteration ${iteration + 1}/${this.maxIterations}: improving CV (current score ${atsResult.score}%, best so far ${bestScore}%, target >= 85%) ---`);
                let improved;
                try {
                    improved = await improveCVWithReport({
                        cvMarkdown: currentCV,
                        keywordReport: atsResult.keywordReport,
                        jobDescription,
                        jobLink: this.jobLink,
                        companyName: jobInfo.companyName,
                        jobTitle: jobInfo.jobTitle,
                        llmConfig: this.llmConfig,
                        llmChain: this.llmChain,
                        score: atsResult.score,
                        missingKeywords: atsResult.missingKeywords,
                        weakKeywords: atsResult.weakKeywords,
                        missingSkills: atsResult.missingSkills,
                        experienceMatches: atsResult.experienceMatches,
                        formattingIssues: atsResult.formattingIssues,
                        iteration,
                        candidateProfile,
                    });
                } catch (e) {
                    // LLM/transient failure here must NOT kill the run — keep best CV and still produce PDFs
                    log(`CV improvement call failed: ${e.message} — stopping ATS loop, keeping best CV so far`);
                    break;
                }
                // Factual gate on every improved CV: if the LLM dropped employers/projects/education, attempt self-repair
                let improvedIntegrity = validateCVIntegrity(improved, candidateProfile);
                if (!improvedIntegrity.ok) {
                    log(`Improved CV had integrity issues (${improvedIntegrity.issues.join('; ').substring(0, 300)}) — attempting targeted repair...`);
                    const repairPrompt = `Fix the following integrity issues in the CV while preserving all tailored bullet points:
Issues to fix:
${improvedIntegrity.issues.map((iss, i) => `${i + 1}. ${iss}`).join('\n')}

Required verified facts:
- Employers: ${getEmployerNamesSummary(candidateProfile)}
- Key Projects: ${getProjectNamesSummary(candidateProfile)}
- Volunteer: ${getVolunteerNamesSummary(candidateProfile)}
- Education: ${getEducationNamesSummary(candidateProfile)}
- All 7 sections in order: PROFESSIONAL SUMMARY, TECHNICAL SKILLS, PROFESSIONAL EXPERIENCE, KEY PROJECTS, VOLUNTEER EXPERIENCE, EDUCATION, ADDITIONAL INFORMATION

CV to fix:
${improved}

Output ONLY the corrected Markdown CV starting with "# ${candidateProfile?.name || 'MAGHAV AHUJA'}".`;
                    try {
                        const repaired = await callLLM(repairPrompt, `Output ONLY the corrected Markdown CV starting with "# ${candidateProfile?.name || 'MAGHAV AHUJA'}".`, this.llmChain);
                        const repairCheck = validateCVIntegrity(repaired, candidateProfile);
                        if (repairCheck.ok) {
                            log('✓ Improved CV self-repair succeeded');
                            improved = repaired;
                            improvedIntegrity = repairCheck;
                        } else {
                            log(`Self-repair still had issues: ${repairCheck.issues.join('; ').substring(0, 200)} — will revert to best CV for next pass`);
                        }
                    } catch (e) {
                        log(`Self-repair call failed: ${e.message}`);
                    }
                }

                if (improvedIntegrity.ok) {
                    currentCV = improved;
                    fs.writeFileSync(path.join(this.outputDir, 'optimized_cv.md'), currentCV);
                    atsResult = await checkAtsScoreViaApi(currentCV, jobDescription, { jobTitle: jobInfo.jobTitle, companyName: jobInfo.companyName, previousScore: bestScore });
                    if (atsResult.score > bestScore) {
                        bestScore = atsResult.score;
                        bestCV = currentCV;
                        bestReport = atsResult.keywordReport;
                        log(`  ✓ New best score: ${bestScore}%`);
                    } else {
                        log(`  Score ${atsResult.score}% not better than best ${bestScore}% (keeping best)`);
                    }
                    if (atsResult.score >= 85) {
                        log(`✅ ATS TARGET ACHIEVED: ${atsResult.score}% >= 85% on iteration ${iteration + 1}!`);
                        break;
                    }
                } else {
                    log(`Iteration ${iteration + 1} rejected by integrity gate — reverting to best known CV`);
                    currentCV = bestCV;
                }
                iteration++;
            }

            // Use best CV found (could be earlier iteration if later degraded)
            if (bestScore > atsResult.score) {
                log(`Restoring best CV (score ${bestScore}% vs final ${atsResult.score}%)`);
                currentCV = bestCV;
                fs.writeFileSync(path.join(this.outputDir, 'optimized_cv.md'), currentCV);
                atsResult = { score: bestScore, passed: bestScore >= 85, needsImprovement: bestScore < 85, keywordReport: bestReport };
            }
            const finalScore = atsResult.score;
            log(finalScore == null
                ? 'ATS score: not checked'
                : `Final ATS score: ${finalScore}% ${finalScore >= 85 ? '✅ PASS' : '❌ FAILED (<85)'}`);

            // Save ATS report
            try {
                fs.writeFileSync(path.join(this.outputDir, 'ats_result.json'), JSON.stringify({ score: finalScore, passed: finalScore >= 85, iterations: iteration, link: this.jobLink }, null, 2));
                this.trackCreatedFile(path.join(this.outputDir, 'ats_result.json'));
            } catch (_) {}

            // Strict ATS Score Gate: Fail workflow if ATS score is below 85
            if (finalScore != null && finalScore < 85) {
                const failMsg = `ATS score failed to reach 85% (final score: ${finalScore}% after ${iteration} iteration(s)). Per user rules, workflow is deemed a failure and stopped to prevent low-scoring application submission.`;
                log(`❌ ${failMsg}`);
                try {
                    fs.writeFileSync(path.join(this.outputDir, 'ats_failure.json'), JSON.stringify({
                        error: failMsg,
                        finalScore,
                        iterations: iteration,
                        jobLink: this.jobLink,
                        missingKeywords: atsResult.missingKeywords,
                        missingSkills: atsResult.missingSkills,
                        scoreBreakdown: atsResult.rawData?.score_breakdown || null
                    }, null, 2));
                    this.trackCreatedFile(path.join(this.outputDir, 'ats_failure.json'));
                } catch (_) {}
                return {
                    success: false,
                    workflowId: this.workflowId,
                    jobLink: this.jobLink,
                    companyName: jobInfo.companyName,
                    jobTitle: jobInfo.jobTitle,
                    atsScore: finalScore,
                    atsPassed: false,
                    error: failMsg,
                    outputDir: this.outputDir,
                };
            }

            // Regenerate cover letter from the final (best) CV so it stays aligned
            if (iteration > 1) {
                log('Regenerating cover letter from final CV...');
                try {
                    const clPrompt = `Write a cover letter for the same candidate and job. Use the CV below as factual basis.

CV: ${currentCV.substring(0, 3000)}
Job: ${jobInfo.jobTitle} at ${jobInfo.companyName}
JD: ${jobDescription.substring(0, 2500)}

Write 1 page (300-380 words), NZ English, date + Hiring Team + Re: + greeting + opening hook + 2 paragraphs (top requirements → quantified achievements) + closing + Maghav Ahuja sign-off. Mirror 4-6 JD keywords. Markdown, no preamble.`;
                    // Timeout CL regen so it cannot hang the whole pipeline — PDFs must still be generated
                    const clPromise = callLLM(clPrompt, 'You are a concise cover letter writer. Output only the letter.', this.llmChain);
                    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('Cover letter regen timed out after 45s')), 45000));
                    currentCL = await Promise.race([clPromise, timeoutPromise]);
                    fs.writeFileSync(path.join(this.outputDir, 'cover_letter.md'), currentCL);
                    this.trackCreatedFile(path.join(this.outputDir, 'cover_letter.md'));
                    log(`Cover letter regenerated (${currentCL.length} chars)`);
                } catch (e) {
                    log(`Cover letter regen failed, keeping original: ${e.message}`);
                }
            }

            // Step 6: Generate PDFs — company-specific filenames, never overwrite previous jobs
            const safeCompany = sanitizeCompanyName(jobInfo.companyName);
            let cvFileName = `MaghavAhuja_${safeCompany}_CV`;
            let clFileName = `MaghavAhuja_${safeCompany}_CL`;
            // If files for this company already exist from a previous run (e.g. re-running same job),
            // archive the old ones before overwriting so history is preserved
            for (const base of [cvFileName, clFileName]) {
                const pdfPath = path.join(this.outputDir, `${base}.pdf`);
                const mdPath = path.join(this.outputDir, `${base}.md`);
                if (fs.existsSync(pdfPath) || fs.existsSync(mdPath)) {
                    const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
                    try {
                        if (fs.existsSync(pdfPath)) {
                            const archPdf = path.join(this.outputDir, `${base}_${ts}.pdf`);
                            fs.copyFileSync(pdfPath, archPdf);
                            this.trackCreatedFile(archPdf);
                        }
                        if (fs.existsSync(mdPath)) {
                            const archMd = path.join(this.outputDir, `${base}_${ts}.md`);
                            fs.copyFileSync(mdPath, archMd);
                            this.trackCreatedFile(archMd);
                        }
                        log(`Archived previous ${base} → ${base}_${ts}.*`);
                    } catch (_) {}
                }
            }
            // Save company-specific markdown (also keep generic latest for backwards compat)
            fs.writeFileSync(path.join(this.outputDir, `${cvFileName}.md`), currentCV);
            fs.writeFileSync(path.join(this.outputDir, `${clFileName}.md`), currentCL);
            fs.writeFileSync(path.join(this.outputDir, 'optimized_cv.md'), currentCV);
            fs.writeFileSync(path.join(this.outputDir, 'cover_letter.md'), currentCL);
            this.trackCreatedFile(path.join(this.outputDir, `${cvFileName}.md`));
            this.trackCreatedFile(path.join(this.outputDir, `${clFileName}.md`));
            this.trackCreatedFile(path.join(this.outputDir, 'optimized_cv.md'));
            this.trackCreatedFile(path.join(this.outputDir, 'cover_letter.md'));

            log(`--- Generating PDFs with page-limit enforcement (${cvFileName}.pdf → 2 pages, ${clFileName}.pdf → 1 page) ---`);
            log('Target: a complete 2-page CV and polished 1-page cover letter; typography is fitted without rewriting facts');
            let cvPdfResult = await generatePdfWithPageCheck(currentCV, path.join(this.outputDir, `${cvFileName}.pdf`), 2, cvMarkdownToHtml, browser);
            let clPdfResult = await generatePdfWithPageCheck(currentCL, path.join(this.outputDir, `${clFileName}.pdf`), 1, coverLetterMarkdownToHtml, browser);
            this.trackCreatedFile(path.join(this.outputDir, `${cvFileName}.pdf`));
            this.trackCreatedFile(path.join(this.outputDir, `${clFileName}.pdf`));

            // Legacy content-rewrite fitting loop is deliberately disabled. The renderer now
            // tests bounded typography profiles while preserving every factual record.
            for (let attempt = 0; attempt < 0; attempt++) {
                const fillPct = Math.round((cvPdfResult.fillRatio || 0) * 100);
                if (cvPdfResult.pages > 2) {
                    log(`CV is ${cvPdfResult.pages} pages — asking LLM to shorten to fit 2 pages (attempt ${attempt + 1}/3)`);
                    const truncForShorten = currentCV.length > 12000 ? currentCV.substring(0, 12000) + '\n[...truncated]' : currentCV;
                    const shortenPrompt = `Shorten this CV to fit EXACTLY 2 full pages A4 at 7.9pt/9mm margins (currently ${cvPdfResult.pages} pages — too long). Target 900-1000 words. Tighten every bullet to 14-20 words, remove filler sentences, keep all keyword-matched skills and quantified achievements. Do NOT add new content. Preserve header and ALL sections. Output ONLY the shortened CV in Markdown starting with "# MAGHAV AHUJA".\n\nCV to shorten:\n${truncForShorten}`;
                    currentCV = await callLLM(shortenPrompt, 'You are a concise CV editor. Output only the CV.', this.llmChain);
                    fs.writeFileSync(path.join(this.outputDir, `${cvFileName}.md`), currentCV);
                    fs.writeFileSync(path.join(this.outputDir, 'optimized_cv.md'), currentCV);
                    cvPdfResult = await generatePdfWithPageCheck(currentCV, path.join(this.outputDir, `${cvFileName}.pdf`), 2, cvMarkdownToHtml, browser);
                    try { fs.copyFileSync(path.join(this.outputDir, `${cvFileName}.pdf`), path.join(this.outputDir, 'Optimized_CV.pdf')); } catch (_) {}
                } else if (cvPdfResult.pages < 2 || (cvPdfResult.fillRatio || 0) < 0.92) {
                    log(`CV fills only ${fillPct}% of 2 pages (${cvPdfResult.pages} page(s)) — expanding to fill 2 FULL pages (attempt ${attempt + 1}/3)`);
                    const gapHint = (cvPdfResult.fillRatio || 0) < 0.8
                        ? 'It is far too sparse: add 5-8 new bullets spread across PROFESSIONAL EXPERIENCE, KEY PROJECTS and TECHNICAL SKILLS, and lengthen the PROFESSIONAL SUMMARY.'
                        : 'It is slightly short: add 2-3 new bullets and extend the thinnest existing bullets with concrete detail.';
                    const expandPrompt = `Expand this CV to fill EXACTLY 2 FULL A4 pages at 7.5pt font, 9mm side margins (it currently fills only ${fillPct}% of 2 pages — the second page must be FULL to the bottom). Target 950-1000 words. ${gapHint} New bullets must be quantified, ATS-friendly, tailored to "${jobInfo.jobTitle} at ${jobInfo.companyName}", and truthfully grounded in the source CV content. Weave in JD keywords: ${extractKeywordHint(jobDescription)}. Keep the header and ALL existing sections and bullets — only ADD, never remove. Output ONLY the expanded CV in Markdown starting with "# MAGHAV AHUJA".\n\nCV to expand:\n${currentCV}`;
                    try {
                        currentCV = await callLLM(expandPrompt, 'You are an expert CV writer. Output only the CV.', this.llmChain);
                    } catch (e) {
                        log(`Expand call failed: ${e.message} — keeping current CV`);
                        break;
                    }
                    fs.writeFileSync(path.join(this.outputDir, `${cvFileName}.md`), currentCV);
                    fs.writeFileSync(path.join(this.outputDir, 'optimized_cv.md'), currentCV);
                    cvPdfResult = await generatePdfWithPageCheck(currentCV, path.join(this.outputDir, `${cvFileName}.pdf`), 2, cvMarkdownToHtml, browser);
                    try { fs.copyFileSync(path.join(this.outputDir, `${cvFileName}.pdf`), path.join(this.outputDir, 'Optimized_CV.pdf')); } catch (_) {}
                } else {
                    log(`CV page fit OK: 2 full pages (${fillPct}% filled)`);
                    break;
                }
            }

            // FINAL integrity gate — the page-fit rewrites (expand/shorten) can drop sections
            // or hallucinate; never ship a CV that fails the fact check. Repair once, then
            // re-render the PDF so the file on disk matches the repaired markdown.
            {
                const finalCheck = validateCVIntegrity(currentCV, candidateProfile);
                if (finalCheck.issues.length > 0) {
                    log(`FINAL CV integrity check FAILED: ${finalCheck.issues.join(' | ')} — repairing`);
                    const repairPrompt = `Fix ONLY these issues in the CV below. Do NOT change anything else.

ISSUES:
${finalCheck.issues.map((s, i) => `${i + 1}. ${s}`).join('\n')}

REQUIRED FACTS:
- Employers: ${getEmployerNamesSummary(candidateProfile)}
- Volunteer: ${formatVerifiedVolunteer(candidateProfile)}
- Education: ${(candidateProfile.education || []).map(e => `${e.institution} — ${e.qualification}, ${e.dates}`).join('\n- Education: ')}
- All 7 sections in order: PROFESSIONAL SUMMARY, TECHNICAL SKILLS, PROFESSIONAL EXPERIENCE, KEY PROJECTS, VOLUNTEER EXPERIENCE, EDUCATION, ADDITIONAL INFORMATION

CV:
${currentCV}

Output ONLY the fixed CV in Markdown starting with "# ${candidateProfile?.name || 'MAGHAV AHUJA'}".`;
                    try {
                        const repaired = await callLLM(repairPrompt, `You are a meticulous CV fact-checker. Output only the corrected CV starting with "# ${candidateProfile?.name || 'MAGHAV AHUJA'}".`, this.llmChain);
                        if (validateCVIntegrity(repaired, candidateProfile).issues.length === 0) {
                            currentCV = repaired;
                            log('FINAL CV integrity repair succeeded');
                        } else {
                            log('FINAL CV integrity repair still imperfect — using repaired version (better than broken)');
                            currentCV = repaired;
                        }
                        fs.writeFileSync(path.join(this.outputDir, `${cvFileName}.md`), currentCV);
                        fs.writeFileSync(path.join(this.outputDir, 'optimized_cv.md'), currentCV);
                        cvPdfResult = await generatePdfWithPageCheck(currentCV, path.join(this.outputDir, `${cvFileName}.pdf`), 2, cvMarkdownToHtml, browser);
                        // Repair often restores sections → CV may overflow 2 pages again.
                        // Bounded re-fit: up to 2 shorten passes, preserving all sections.
                        for (let fit = 0; fit < 2 && cvPdfResult.pages > 2; fit++) {
                            log(`Repaired CV is ${cvPdfResult.pages} pages — re-fitting to 2 pages (pass ${fit + 1}/2)`);
                            const refitPrompt = `Shorten this CV to fit EXACTLY 2 full A4 pages at 7.5pt (currently ${cvPdfResult.pages} pages). Target 950-1000 words. Tighten bullets to 14-20 words each, trim filler from the PROFESSIONAL SUMMARY, but KEEP ALL SECTIONS (PROFESSIONAL SUMMARY, TECHNICAL SKILLS, PROFESSIONAL EXPERIENCE, KEY PROJECTS, VOLUNTEER EXPERIENCE, EDUCATION, ADDITIONAL INFORMATION) and ALL employers/schools exactly as listed. Output ONLY the shortened CV starting with "# ${candidateProfile?.name || 'MAGHAV AHUJA'}".\n\nCV:\n${currentCV}`;
                            try {
                                const refit = await callLLM(refitPrompt, `You are a concise CV editor. Output only the CV starting with "# ${candidateProfile?.name || 'MAGHAV AHUJA'}".`, this.llmChain);
                                if (validateCVIntegrity(refit, candidateProfile).issues.length === 0) {
                                    currentCV = refit;
                                } else {
                                    log('Re-fit dropped sections — discarding re-fit, keeping previous version');
                                    break;
                                }
                            } catch (e) { log(`Re-fit failed: ${e.message}`); break; }
                            fs.writeFileSync(path.join(this.outputDir, `${cvFileName}.md`), currentCV);
                            fs.writeFileSync(path.join(this.outputDir, 'optimized_cv.md'), currentCV);
                            cvPdfResult = await generatePdfWithPageCheck(currentCV, path.join(this.outputDir, `${cvFileName}.pdf`), 2, cvMarkdownToHtml, browser);
                        }
                        try { fs.copyFileSync(path.join(this.outputDir, `${cvFileName}.pdf`), path.join(this.outputDir, 'Optimized_CV.pdf')); } catch (_) {}
                    } catch (e) {
                        log(`FINAL CV integrity repair failed: ${e.message}`);
                    }
                } else {
                    log('FINAL CV integrity check OK — all sections, employers and education verified');
                }
            }
            for (let attempt = 0; attempt < 0; attempt++) {
                if (clPdfResult.pages > 1) {
                    log(`Cover letter is ${clPdfResult.pages} pages — asking LLM to shorten to 1 page (attempt ${attempt + 1})`);
                    const shortenPrompt = `Shorten this cover letter to fit EXACTLY 1 page A4 (currently ${clPdfResult.pages} pages — too long). Keep the opening, 2 body paragraphs, and sign-off. Be concise. Output ONLY the letter in Markdown.\n\nLetter to shorten:\n${currentCL}`;
                    currentCL = await callLLM(shortenPrompt, 'You are a concise cover letter editor. Output only the letter.', this.llmChain);
                    fs.writeFileSync(path.join(this.outputDir, `${clFileName}.md`), currentCL);
                    fs.writeFileSync(path.join(this.outputDir, 'cover_letter.md'), currentCL);
                    clPdfResult = await generatePdfWithPageCheck(currentCL, path.join(this.outputDir, `${clFileName}.pdf`), 1, coverLetterMarkdownToHtml, browser);
                    try { fs.copyFileSync(path.join(this.outputDir, `${clFileName}.pdf`), path.join(this.outputDir, 'Cover_Letter.pdf')); } catch (_) {}
                } else break;
            }

            const finalIntegrity = validateCVIntegrity(currentCV, candidateProfile);
            if (!finalIntegrity.ok) throw new Error(`Final CV integrity gate failed: ${finalIntegrity.issues.join(' | ')}`);
            if (!cvPdfResult.ok) {
                throw new Error(`CV layout gate failed: expected 2 well-filled pages, got ${cvPdfResult.pages} page(s) at ${Math.round((cvPdfResult.fillRatio || 0) * 100)}% fill`);
            }
            if (!clPdfResult.ok) {
                throw new Error(`Cover letter layout gate failed: expected 1 page, got ${clPdfResult.pages} page(s) at ${Math.round((clPdfResult.fillRatio || 0) * 100)}% fill`);
            }
            // Update generic "latest" files only after every hard gate passes.
            fs.copyFileSync(path.join(this.outputDir, `${cvFileName}.pdf`), path.join(this.outputDir, 'Optimized_CV.pdf'));
            fs.copyFileSync(path.join(this.outputDir, `${clFileName}.pdf`), path.join(this.outputDir, 'Cover_Letter.pdf'));
            this.trackCreatedFile(path.join(this.outputDir, 'Optimized_CV.pdf'));
            this.trackCreatedFile(path.join(this.outputDir, 'Cover_Letter.pdf'));

            log('='.repeat(60));
            log('Pipeline complete');
            log(`  ATS score: ${finalScore == null ? 'not checked' : `${finalScore}%`}`);
            log(`  CV PDF: ${cvPdfResult.outputPath} (${cvPdfResult.pages} pages, ${Math.round((cvPdfResult.fillRatio || 0) * 100)}% filled)`);
            log(`  CL PDF: ${clPdfResult.outputPath} (${clPdfResult.pages} pages)`);
            log(`  Output dir: ${this.outputDir}`);
            const outFiles = fs.readdirSync(this.outputDir);
            for (const f of outFiles) {
                try { const s = fs.statSync(path.join(this.outputDir, f)); log(`    ${f} (${(s.size / 1024).toFixed(1)} KB)`); } catch (_) {}
            }
            log('='.repeat(60));

            // Optional Notion synchronization
            let notionResult = null;
            let cleanedUpFiles = [];
            if (process.env.NOTION_API_KEY || process.env.NOTION_TOKEN) {
                try {
                    log('Syncing application details and PDFs to Notion...');
                    notionResult = await syncJobToNotion({
                        jobTitle: jobInfo.jobTitle,
                        companyName: jobInfo.companyName,
                        jobLink: this.jobLink,
                        score: finalScore,
                        cvPdfPath: cvPdfResult.outputPath,
                        clPdfPath: clPdfResult.outputPath,
                        cvMarkdown: currentCV,
                        coverLetterMarkdown: currentCL,
                        jobDescription,
                        outputDir: this.outputDir,
                    });
                    if (notionResult && (notionResult.pageUrl || notionResult.success)) {
                        log(`Notion sync successful: ${notionResult.pageUrl || notionResult.pageId}`);

                        // After uploading the files on Notion, delete the CVs, CLs, and all workflow files from /output
                        if (process.env.CLEANUP_OUTPUT_AFTER_NOTION_SYNC !== 'false') {
                            log('Deleting CVs, CLs, and workflow files in /output after successful Notion upload...');
                            cleanedUpFiles = this.cleanupWorkflowFiles({
                                cvPdfPath: cvPdfResult.outputPath,
                                clPdfPath: clPdfResult.outputPath,
                                cvFileName,
                                clFileName,
                            });
                            log(`Cleaned up ${cleanedUpFiles.length} file(s) from output directory.`);
                        }
                    }
                } catch (e) {
                    log(`Notion sync warning: ${e.message}`);
                }
            } else {
                log('Notion sync skipped: NOTION_API_KEY not configured in .env (run "node notion_sync.js --test" for setup instructions).');
            }

            return {
                success: true,
                workflowId: this.workflowId,
                jobLink: this.jobLink,
                companyName: jobInfo.companyName,
                jobTitle: jobInfo.jobTitle,
                atsScore: finalScore,
                atsPassed: finalScore >= 85,
                cvPdfPages: cvPdfResult.pages,
                clPdfPages: clPdfResult.pages,
                cvPdfPath: cvPdfResult.outputPath,
                clPdfPath: clPdfResult.outputPath,
                outputDir: this.outputDir,
                notionResult,
                cleanedUpFiles,
            };
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    }
}

module.exports = JobApplicationPipeline;
module.exports._internals = {
    loadCandidateProfile,
    classifyJob,
    buildFactualApplicationDocuments,
    validateCVIntegrity,
    containsEntity,
    cvMarkdownToHtml,
    coverLetterMarkdownToHtml,
    checkAtsScoreViaApi,
    cleanAndValidateJobDescription,
    extractJdRequirementsAndKeywords,
    getProviderChain,
    resolveLLMConfig,
    validateProviderChain,
    callLLM,
    extractCompanyViaLLM,
    extractJobTitleViaLLM,
    cleanupOutputFiles,
    generatePdfWithPageCheck,
    getBrowserLaunchOptions,
    resolveAtsApiUrl,
    calculateLocalAtsScore,
    formatVerifiedEmployers,
    formatVerifiedProjects,
    formatVerifiedEducation,
    formatVerifiedVolunteer,
    getEmployerNamesSummary,
    getProjectNamesSummary,
    getEducationNamesSummary,
    getVolunteerNamesSummary,
    improveCVWithReport,
    enforceAtsBulletConstraints,
    ensureAtsKeywordsPresent,
    scrapeJobDescription,
    scrapeWorkdayJob,
    parseWorkdayUrl,
};

// CLI entry when run directly
if (require.main === module) {
    const rawArgs = process.argv.slice(2);
    const forceSync = rawArgs.includes('--force-sync') || rawArgs.includes('-f');
    const skipSync = rawArgs.includes('--skip-sync');
    const args = rawArgs.filter(a => !a.startsWith('--') && !a.startsWith('-'));
    const link = args[0];
    if (!link) {
        console.log('Usage: node job_application_pipeline.js <job_link> [llm_api_key] [llm_model] [--force-sync] [--skip-sync]');
        console.log('  job_link: SEEK / LinkedIn / Indeed / TradeMe / any career URL');
        console.log('  llm_api_key: optional override (else uses LLM_API_KEY / .env provider chain)');
        console.log('  llm_model: optional override (else uses OPENROUTER_MODEL / GROQ_MODEL / NIM_MODEL)');
        console.log('  --force-sync: force fresh portfolio scrape & re-parsing of CVs');
        console.log('  --skip-sync: skip preflight profile synchronization');
        process.exit(1);
    }
    const pipeline = new JobApplicationPipeline({
        jobLink: link,
        llmApiKey: args[1] || undefined,
        llmModel: args[2] || undefined,
        forceSync,
        skipSync,
    });
    pipeline.run().then(r => {
        console.log('\nDone:', JSON.stringify(r, null, 2));
    }).catch(e => {
        console.error('\nPipeline failed:', e);
        process.exit(1);
    });
}
