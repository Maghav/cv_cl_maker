#!/usr/bin/env node

/**
 * profile_aggregator.js
 * Automated Dynamic CV Pipeline - Phase 3: Unified Profile Aggregator
 *
 * Consolidates career data across 3 sources:
 * 1. Base candidate profile (candidate_profile.json)
 * 2. Live portfolio site (portfolio.onl9.club via portfolio_scraper.js)
 * 3. Multi-CV PDFs (my_cvs/*.pdf via cv_parser.js)
 *
 * Core Capabilities:
 * - Step 3.1: Intelligent Merge & Conflict Resolution
 *   - Entity & Company alias mapping (Datacom -> Datacom NZ, Neurix -> Neurix Limited, etc.)
 *   - Metric-driven bullet deduplication using Jaccard/token similarity, prioritizing high-impact quantitative achievements.
 *   - Skills standardization & unioning into 10 canonical categories.
 * - Step 3.2: Dynamic Keyword & Tag Indexing for ATS scoring (classifyJob & scoreForJob).
 * - Step 3.3: Safe Profile Persistence & Automated Backup (candidate_profile.backup.json).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { scrapePortfolio, loadPortfolioCache } = require('./portfolio_scraper');
const { parseAllCvs, cleanText } = require('./cv_parser');

const DEFAULT_PROFILE_PATH = path.resolve(__dirname, 'candidate_profile.json');
const DEFAULT_BACKUP_PATH = path.resolve(__dirname, 'candidate_profile.backup.json');
const DEFAULT_MY_CVS_DIR = path.resolve(__dirname, 'my_cvs');

// ---------------------------------------------------------------------------
// 1. Entity & Company Alias Mapping
// ---------------------------------------------------------------------------

function normalizeEntityKey(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .toLowerCase()
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const RAW_EMPLOYER_ALIASES = {
    'neurix': 'Neurix Limited',
    'neurix limited': 'Neurix Limited',
    'datacom': 'Datacom NZ',
    'datacom nz': 'Datacom NZ',
    'datacom new zealand': 'Datacom NZ',
    'department of education': 'Department of Education, Government of Delhi',
    'department of education government of delhi': 'Department of Education, Government of Delhi',
    'department of education, government of delhi': 'Department of Education, Government of Delhi',
    'dept of education': 'Department of Education, Government of Delhi',
    'education department': 'Department of Education, Government of Delhi',
    'mitre10': 'Mitre10 MEGA',
    'mitre 10': 'Mitre10 MEGA',
    'mitre10 mega': 'Mitre10 MEGA',
    'mitre 10 mega': 'Mitre10 MEGA',
    'woolworths': 'Woolworths New Zealand',
    'woolworths nz': 'Woolworths New Zealand',
    'woolworths new zealand': 'Woolworths New Zealand'
};

const RAW_PROJECT_ALIASES = {
    // Group 1: Cloud Application Deployment
    'cloud application deployment': 'Cloud Application Deployment',
    'cloud deployment infrastructure automation': 'Cloud Application Deployment',
    'cloud deployment & infrastructure automation': 'Cloud Application Deployment',
    'cloud deployment and infrastructure automation': 'Cloud Application Deployment',
    'deployment projects': 'Cloud Application Deployment',
    'portfolio interactive showcase': 'Cloud Application Deployment',
    'personal portfolio': 'Cloud Application Deployment',
    'onl9 toolkit 9 under progress': 'Cloud Application Deployment',
    'onl9 cloud systems engineering toolkit': 'Cloud Application Deployment',
    'job apply pipeline': 'Cloud Application Deployment',
    'job application workflow engine': 'Cloud Application Deployment',

    // Group 2: VPS, Hosting & Recovery Lab
    'vps hosting recovery lab': 'VPS, Hosting & Recovery Lab',
    'vps hosting & recovery lab': 'VPS, Hosting & Recovery Lab',
    'vps hosting and recovery lab': 'VPS, Hosting & Recovery Lab',
    'vps server testing deployment self led technical practice': 'VPS, Hosting & Recovery Lab',
    'vps server testing & deployment – self-led technical practice': 'VPS, Hosting & Recovery Lab',
    'vps server testing deployment': 'VPS, Hosting & Recovery Lab',
    'infrastructure package building disaster recovery': 'VPS, Hosting & Recovery Lab',
    'infrastructure package building & disaster recovery': 'VPS, Hosting & Recovery Lab',
    'infrastructure package building and disaster recovery': 'VPS, Hosting & Recovery Lab',

    // Group 3: Nextcloud & Systems Learning Lab
    'nextcloud systems learning lab': 'Nextcloud & Systems Learning Lab',
    'nextcloud & systems learning lab': 'Nextcloud & Systems Learning Lab',
    'nextcloud and systems learning lab': 'Nextcloud & Systems Learning Lab',
    'nextcloud microsoft 365 alternative on premises': 'Nextcloud & Systems Learning Lab',
    'nextcloud - microsoft 365 alternative on premises': 'Nextcloud & Systems Learning Lab',
    'nextcloud': 'Nextcloud & Systems Learning Lab',
    'continuous linux devops programming practice': 'Nextcloud & Systems Learning Lab',
    'continuous linux & devops programming practice': 'Nextcloud & Systems Learning Lab',
    'self learning platforms': 'Nextcloud & Systems Learning Lab',
    'learning physics through code': 'Nextcloud & Systems Learning Lab',
    'learning physics': 'Nextcloud & Systems Learning Lab',
    'sadservers scenario practice': 'Nextcloud & Systems Learning Lab',
    'kodekloud hands on labs': 'Nextcloud & Systems Learning Lab',
    'iximiuz devops playground': 'Nextcloud & Systems Learning Lab',
    'interactive devops playground': 'Nextcloud & Systems Learning Lab',
    'onl9 club': 'Nextcloud & Systems Learning Lab'
};

const RAW_INSTITUTION_ALIASES = {
    'unitec': 'Unitec Institute of Technology',
    'unitec institute of technology': 'Unitec Institute of Technology',
    'maharaja surajmal': 'Maharaja Surajmal Institute',
    'maharaja surajmal institute': 'Maharaja Surajmal Institute',
    'msi': 'Maharaja Surajmal Institute'
};

const RAW_VOLUNTEER_ALIASES = {
    'freecodecamp': 'FreeCodeCamp.org',
    'freecodecamp.org': 'FreeCodeCamp.org',
    'free code camp': 'FreeCodeCamp.org',
    'shoutcoder': 'Shoutcoder.com',
    'shoutcoder.com': 'Shoutcoder.com',
    'shout coder': 'Shoutcoder.com'
};

// Build normalized lookup tables
const EMPLOYER_ALIASES = Object.fromEntries(
    Object.entries(RAW_EMPLOYER_ALIASES).map(([k, v]) => [normalizeEntityKey(k), v])
);
const PROJECT_ALIASES = Object.fromEntries(
    Object.entries(RAW_PROJECT_ALIASES).map(([k, v]) => [normalizeEntityKey(k), v])
);
const INSTITUTION_ALIASES = Object.fromEntries(
    Object.entries(RAW_INSTITUTION_ALIASES).map(([k, v]) => [normalizeEntityKey(k), v])
);
const VOLUNTEER_ALIASES = Object.fromEntries(
    Object.entries(RAW_VOLUNTEER_ALIASES).map(([k, v]) => [normalizeEntityKey(k), v])
);

/**
 * Resolve an employer name to its canonical form.
 */
function canonicalizeEmployer(name) {
    const key = normalizeEntityKey(name);
    if (!key) return name || '';
    if (EMPLOYER_ALIASES[key]) return EMPLOYER_ALIASES[key];

    for (const [alias, canonical] of Object.entries(EMPLOYER_ALIASES)) {
        if (key === alias || key.includes(alias) || alias.includes(key)) {
            return canonical;
        }
    }
    return name.trim();
}

/**
 * Resolve a project name to its canonical form.
 */
function canonicalizeProject(name) {
    const key = normalizeEntityKey(name);
    if (!key) return name || '';
    if (PROJECT_ALIASES[key]) return PROJECT_ALIASES[key];

    for (const [alias, canonical] of Object.entries(PROJECT_ALIASES)) {
        if (key === alias || key.includes(alias) || alias.includes(key)) {
            return canonical;
        }
    }
    return name.trim();
}

/**
 * Resolve an educational institution name to its canonical form.
 */
function canonicalizeInstitution(name) {
    const key = normalizeEntityKey(name);
    if (!key) return name || '';
    if (INSTITUTION_ALIASES[key]) return INSTITUTION_ALIASES[key];

    for (const [alias, canonical] of Object.entries(INSTITUTION_ALIASES)) {
        if (key === alias || key.includes(alias) || alias.includes(key)) {
            return canonical;
        }
    }
    return name.trim();
}

/**
 * Resolve a volunteer organization to its canonical form.
 */
function canonicalizeVolunteer(name) {
    const key = normalizeEntityKey(name);
    if (!key) return name || '';
    if (VOLUNTEER_ALIASES[key]) return VOLUNTEER_ALIASES[key];

    for (const [alias, canonical] of Object.entries(VOLUNTEER_ALIASES)) {
        if (key === alias || key.includes(alias) || alias.includes(key)) {
            return canonical;
        }
    }
    return name.trim();
}

// ---------------------------------------------------------------------------
// 2. Dynamic Keyword & Tag Indexing (Step 3.2)
// ---------------------------------------------------------------------------

const ATS_KEYWORD_DICTIONARY = [
    // Service Desk & Support
    'service desk', 'help desk', 'technical support', 'l1/l2', 'l1', 'l2', 'ticket', 'incident',
    'escalation', 'customer service', 'customer support', 'customer', 'itil', 'jira', 'whmcs', 'sla',
    'root cause', 'troubleshooting', 'user setup', 'access control', 'on-call', 'remote support',
    'multi-client', 'service delivery', 'it operations', 'user', 'enterprise', 'pressure', 'reliability',

    // Microsoft & Identity
    'microsoft 365', 'office 365', 'exchange', 'teams', 'sharepoint', 'active directory',
    'entra id', 'azure ad', 'group policy', 'user access', 'identity', 'intune', 'access',

    // Windows & End-User Systems
    'windows', 'windows server', 'windows 10', 'windows 11', 'hardware', 'software',
    'printer', 'peripherals', 'asset', 'device', 'endpoint', 'fault diagnosis', 'assembly', 'fault',

    // Networking & Infrastructure
    'networking', 'network', 'lan', 'wan', 'vpn', 'wifi', 'dhcp', 'dns', 'tcp/ip',
    'firewall', 'virtualisation', 'infrastructure', 'cisco',

    // Linux & Web Hosting
    'linux', 'ubuntu', 'centos', 'rhel', 'almalinux', 'debian', 'nginx', 'apache',
    'cpanel', 'whm', 'web hosting', 'hosting', 'package management', 'deb', 'rpm', 'package', 'server',

    // Cloud & Virtual Machines
    'azure', 'aws', 'cloud', 'virtual machine', 'vm', 'vms', 'ec2', 'vps', 'arm',
    'amplify', 'paas', 'iaas', 'systems administration', 'contabo',

    // Automation & Scripting
    'automation', 'python', 'bash', 'powershell', 'scripting', 'workflow',
    'power automate', 'n8n', 'yaml', 'continuous improvement',

    // DevOps & Configuration
    'devops', 'ci/cd', 'azure devops', 'buildbot', 'jenkins', 'git', 'github',
    'terraform', 'ansible', 'docker', 'containers', 'container', 'kubernetes',
    'configuration management', 'configuration', 'deployment',

    // Monitoring & Observability
    'monitoring', 'observability', 'zabbix', 'prometheus', 'grafana', 'alerting',
    'metrics', 'logging', 'uptime',

    // Databases & Storage
    'database', 'databases', 'postgresql', 'mysql', 'sql', 'backup', 'recovery',
    'disaster recovery', 'nextcloud',

    // Documentation & Process
    'documentation', 'knowledge base', 'procedure', 'process', 'communication', 'learning',

    // Development & Web
    'react', 'next.js', 'node.js', '.net', 'java', 'javascript', 'html', 'css', 'wordpress', 'education'
];

/**
 * Dynamically extract relevant ATS search tags from any arbitrary text block.
 *
 * @param {string} text
 * @param {string[]} existingTags
 * @returns {string[]} Normalized, unique lowercase tags
 */
function generateTags(text, existingTags = []) {
    const raw = String(text || '').toLowerCase();
    const tagSet = new Set();

    // Preserve existing tags
    if (Array.isArray(existingTags)) {
        for (const t of existingTags) {
            const cleanT = String(t || '').toLowerCase().trim();
            if (cleanT) tagSet.add(cleanT);
        }
    }

    // Match terms from the ATS keyword dictionary
    for (const kw of ATS_KEYWORD_DICTIONARY) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|[^a-z0-9+#./-])${escaped}([^a-z0-9+#./-]|$)`, 'i');
        if (pattern.test(raw)) {
            tagSet.add(kw);
        }
    }

    return Array.from(tagSet);
}

// ---------------------------------------------------------------------------
// 3. Metric-Driven Bullet Scoring & Deduplication (Step 3.1)
// ---------------------------------------------------------------------------

/**
 * Score the impact, technical depth, and quantitative metrics of a bullet point.
 * Higher score = higher priority when deduplicating.
 *
 * @param {string} text
 * @returns {number}
 */
function scoreBulletMetrics(text) {
    if (!text || typeof text !== 'string') return 0;
    let score = 0;
    const clean = text.trim();

    // 1. Quantitative metrics (highest value for ATS and recruiters)
    if (/\b\d+(?:\.\d+)?%/i.test(clean)) score += 8;            // e.g. 40%, 99.9%, 25%, 95%
    if (/\b\d+\+\s*(?:vms|servers|users|tickets|requests|learners)?/i.test(clean)) score += 6; // e.g. 15+, 20+, 200+, 300+
    if (/\b(?:reduced|improved|decreased|increased)\b/i.test(clean)) score += 4;
    if (/\b\d+\s*(?:minutes|hours|days|weeks|months)\b/i.test(clean)) score += 4; // e.g. 15 minutes
    if (/\b\d{2,}\b/.test(clean)) score += 2;                     // Any 2+ digit number

    // 2. Action verb specificity (strong technical verbs)
    const strongActionVerbs = /^(?:deliver|administer|manage|create|implement|troubleshoot|architect|deploy|automate|configure|coordinate|maintain|support|lead|curate|build)\b/i;
    if (strongActionVerbs.test(clean)) score += 3;

    // 3. Technical tool specificity
    const toolKeywords = [
        'ansible', 'terraform', 'zabbix', 'prometheus', 'grafana', 'python', 'bash', 'powershell',
        'azure', 'aws', 'ubuntu', 'centos', 'rhel', 'docker', 'kubernetes', 'ec2', 'arm', 'active directory',
        'microsoft 365', 'cpanel', 'whm', 'nginx', 'postgresql'
    ];
    for (const tool of toolKeywords) {
        if (clean.toLowerCase().includes(tool)) score += 2;
    }

    // 4. Content length / detail bonus (penalize overly brief or absurdly long)
    const words = clean.split(/\s+/).length;
    if (words >= 15 && words <= 40) score += 3;
    else if (words < 8) score -= 4;

    return score;
}

/**
 * Extract tokens for Jaccard and word-overlap similarity calculations.
 */
function getBulletTokens(text) {
    const stopwords = new Set([
        'the', 'and', 'to', 'of', 'in', 'for', 'with', 'a', 'an', 'on', 'at', 'by', 'as', 'from',
        'is', 'are', 'was', 'were', 'or', 'that', 'this', 'our', 'all', 'any', 'while', 'using',
        'across', 'through', 'into'
    ]);
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9+#./-]+/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !stopwords.has(w));
}

/**
 * Compute Jaccard similarity and token overlap between two bullet strings.
 */
function calculateBulletSimilarity(textA, textB) {
    const tokensA = new Set(getBulletTokens(textA));
    const tokensB = new Set(getBulletTokens(textB));

    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const t of tokensA) {
        if (tokensB.has(t)) intersection++;
    }

    const union = new Set([...tokensA, ...tokensB]).size;
    const jaccard = union === 0 ? 0 : intersection / union;

    const minSize = Math.min(tokensA.size, tokensB.size);
    const overlapRatio = minSize === 0 ? 0 : intersection / minSize;

    return Math.max(jaccard, overlapRatio * 0.8);
}

/**
 * Deduplicate a list of bullets while maintaining source provenance and unioning tags.
 * Prioritizes the variant with the highest metric/impact score.
 *
 * @param {Array<{ text: string, tags?: string[], sourceFile?: string, sourceHash?: string }>} rawBullets
 * @param {object} options
 * @returns {Array<{ text: string, tags: string[], sources: Array<{ file: string, hash: string }> }>}
 */
function deduplicateBullets(rawBullets, options = {}) {
    const similarityThreshold = options.threshold || 0.45;
    const deduplicated = [];

    for (const candidate of rawBullets) {
        const text = cleanText(candidate.text || (typeof candidate === 'string' ? candidate : ''));
        if (!text || text.length < 10) continue;

        const candidateTags = generateTags(text, candidate.tags || []);
        const candidateMetricScore = scoreBulletMetrics(text);
        const sourceFile = candidate.sourceFile || 'candidate_profile.json';
        const sourceHash = candidate.sourceHash || '';

        let matched = false;
        for (const existing of deduplicated) {
            const sim = calculateBulletSimilarity(existing.text, text);
            if (sim >= similarityThreshold) {
                // Duplicate detected!
                matched = true;
                // Merge tags
                existing.tags = Array.from(new Set([...existing.tags, ...candidateTags]));

                // Merge provenance
                if (!existing.sources.some(s => s.file === sourceFile)) {
                    existing.sources.push({ file: sourceFile, hash: sourceHash });
                }

                // Pick the higher-impact, metric-driven variant
                const existingMetricScore = scoreBulletMetrics(existing.text);
                if (candidateMetricScore > existingMetricScore) {
                    existing.text = text;
                }
                break;
            }
        }

        if (!matched) {
            deduplicated.push({
                text,
                tags: candidateTags,
                sources: [{ file: sourceFile, hash: sourceHash }]
            });
        }
    }

    return deduplicated;
}

// ---------------------------------------------------------------------------
// 4. Skills Standardization & Unioning (Step 3.1)
// ---------------------------------------------------------------------------

const CANONICAL_SKILL_CATEGORIES = [
    {
        name: 'Service Desk & Service Delivery',
        matchRegex: /\b(?:service\s*desk|help\s*desk|support|service\s*delivery)\b/i
    },
    {
        name: 'Microsoft & Identity',
        matchRegex: /\b(?:microsoft|identity|active\s*directory|entra)\b/i
    },
    {
        name: 'Windows & End-User Systems',
        matchRegex: /\b(?:windows|end-user|hardware|desktop|endpoint)\b/i
    },
    {
        name: 'Networking & Infrastructure',
        matchRegex: /\b(?:network(?:ing)?|infrastructure|lan|wan|vpn)\b/i
    },
    {
        name: 'Linux & Web Hosting',
        matchRegex: /\b(?:linux|hosting|cpanel|web\s*server|operating\s*systems)\b/i
    },
    {
        name: 'Cloud & Virtual Machines',
        matchRegex: /\b(?:cloud|virtual(?:isation)?|aws|azure|vm|vms)\b/i
    },
    {
        name: 'Automation & Scripting',
        matchRegex: /\b(?:automation|scripting|python|bash|powershell|ai)\b/i
    },
    {
        name: 'DevOps & Configuration',
        matchRegex: /\b(?:devops|ci\/cd|iac|configuration|containers?|docker|kubernetes)\b/i
    },
    {
        name: 'Monitoring & Data',
        matchRegex: /\b(?:monitoring|data|observability|zabbix|database|databases)\b/i
    },
    {
        name: 'Hardware & Operations',
        matchRegex: /\b(?:hardware|operations|repair|fault|on-call)\b/i
    }
];

/**
 * Merge and categorize skills across base profile, portfolio, and CVs.
 */
function mergeSkills(baseSkills = [], portfolioCategories = {}, cvSkillsList = []) {
    const categoryMap = new Map();
    for (const cat of CANONICAL_SKILL_CATEGORIES) {
        categoryMap.set(cat.name, {
            category: cat.name,
            items: new Set(),
            text: '',
            tags: new Set()
        });
    }

    // 1. Ingest base profile skills
    for (const s of baseSkills) {
        const canonical = CANONICAL_SKILL_CATEGORIES.find(c => c.name.toLowerCase() === (s.category || '').toLowerCase());
        const catName = canonical ? canonical.name : (s.category || 'DevOps & Configuration');
        if (!categoryMap.has(catName)) {
            categoryMap.set(catName, { category: catName, items: new Set(), text: '', tags: new Set() });
        }
        const entry = categoryMap.get(catName);
        entry.text = s.text || entry.text;
        for (const t of (s.tags || [])) entry.tags.add(t.toLowerCase());
        (s.text || '').split(/[,;]/).forEach(item => {
            const clean = item.trim().replace(/^and\s+/i, '');
            if (clean && clean.length > 1) entry.items.add(clean);
        });
    }

    function findBestCategory(catName) {
        for (const cat of CANONICAL_SKILL_CATEGORIES) {
            if (cat.matchRegex.test(catName)) return cat.name;
        }
        return 'DevOps & Configuration';
    }

    // 2. Ingest portfolio categories
    for (const [pCat, pSkills] of Object.entries(portfolioCategories)) {
        const targetCategory = findBestCategory(pCat);
        const entry = categoryMap.get(targetCategory);
        for (const skill of pSkills) {
            const clean = cleanText(skill);
            if (clean && clean.length > 1) {
                entry.items.add(clean);
                entry.tags.add(clean.toLowerCase());
            }
        }
    }

    // 3. Ingest CV skills
    for (const cvSkills of cvSkillsList) {
        if (!cvSkills) continue;
        const cats = cvSkills.categories || {};
        for (const [cCat, cSkills] of Object.entries(cats)) {
            const targetCategory = findBestCategory(cCat);
            const entry = categoryMap.get(targetCategory);
            for (const skill of cSkills) {
                const clean = cleanText(skill);
                if (clean && clean.length > 1) {
                    entry.items.add(clean);
                    entry.tags.add(clean.toLowerCase());
                }
            }
        }
    }

    // Format output
    const output = [];
    for (const [catName, data] of categoryMap.entries()) {
        const combinedTags = generateTags(data.text + ' ' + Array.from(data.items).join(' '), Array.from(data.tags));
        output.push({
            category: catName,
            text: data.text || Array.from(data.items).join(', '),
            tags: combinedTags
        });
    }

    return output;
}

// ---------------------------------------------------------------------------
// 5. Intelligent Merge & Aggregator Core (Step 3.1)
// ---------------------------------------------------------------------------

/**
 * Intelligently merge base candidate profile, scraped portfolio, and parsed CV data.
 *
 * @param {object} baseProfile - Existing candidate_profile.json
 * @param {object} portfolioData - Result from portfolio_scraper
 * @param {Array<object>} cvDataList - List of parsed CV objects from cv_parser
 * @param {object} options
 * @returns {object} - Unified aggregated candidate profile
 */
function mergeProfiles(baseProfile = {}, portfolioData = {}, cvDataList = [], options = {}) {
    const sourceFiles = new Set(baseProfile.sourceFiles || []);
    if (portfolioData && portfolioData.url) {
        sourceFiles.add(portfolioData.url);
    }
    for (const cv of cvDataList) {
        if (cv.sourceFile) sourceFiles.add(`my_cvs/${cv.sourceFile}`);
    }

    // 1. Contact & Header details
    const contact = {
        email: baseProfile.contact?.email || portfolioData.header?.email || 'maghavahuja01@gmail.com',
        phone: baseProfile.contact?.phone || portfolioData.header?.phone || '+64 (022) 807-9079',
        location: baseProfile.contact?.location || portfolioData.header?.location || 'Auckland, New Zealand',
        linkedin: baseProfile.contact?.linkedin || portfolioData.header?.socials?.linkedin || 'linkedin.com/in/maghavahuja',
        github: baseProfile.contact?.github || portfolioData.header?.socials?.github || 'github.com/maghavahuja'
    };

    // 2. Summary Variants (preserve curated variants)
    const summaryVariants = {
        serviceDesk: baseProfile.summaryVariants?.serviceDesk || '',
        systems: baseProfile.summaryVariants?.systems || '',
        technicalSupport: baseProfile.summaryVariants?.technicalSupport || '',
        devops: baseProfile.summaryVariants?.devops || ''
    };

    // 3. Work Experience Merging & Deduplication
    const employerMap = new Map();

    // Default max bullets per employer (aligning with page-budget constraints)
    const DEFAULT_MAX_BULLETS = {
        'Neurix Limited': 7,
        'Datacom NZ': 4,
        'Department of Education, Government of Delhi': 3,
        'Mitre10 MEGA': 2,
        'Woolworths New Zealand': 2
    };

    // Initialize canonical employers from base profile
    for (const exp of (baseProfile.experience || [])) {
        const canonical = canonicalizeEmployer(exp.employer);
        employerMap.set(canonical, {
            employer: canonical,
            location: exp.location || 'Auckland, New Zealand',
            role: exp.role || '',
            dates: exp.dates || '',
            dateNote: exp.dateNote || undefined,
            maxBullets: exp.maxBullets || DEFAULT_MAX_BULLETS[canonical] || 4,
            rawBullets: [...(exp.bullets || [])]
        });
    }

    // Ingest Experience from Parsed CVs
    for (const cv of cvDataList) {
        for (const exp of (cv.experience || [])) {
            const canonical = canonicalizeEmployer(exp.employer);
            if (!employerMap.has(canonical)) {
                employerMap.set(canonical, {
                    employer: canonical,
                    location: exp.location || 'Auckland, New Zealand',
                    role: exp.role || '',
                    dates: exp.dates || '',
                    maxBullets: DEFAULT_MAX_BULLETS[canonical] || 4,
                    rawBullets: []
                });
            }
            const record = employerMap.get(canonical);
            if (exp.role && (!record.role || exp.role.length > record.role.length)) {
                record.role = exp.role;
            }
            if (exp.location && !record.location) {
                record.location = exp.location;
            }
            if (exp.bullets && exp.bullets.length > 0) {
                for (const b of exp.bullets) {
                    record.rawBullets.push({
                        text: b.text,
                        tags: b.tags || [],
                        sourceFile: b.sourceFile || cv.sourceFile,
                        sourceHash: b.sourceHash || cv.sourceHash
                    });
                }
            }
        }
    }

    // Ingest Experience from Scraped Portfolio
    if (portfolioData.experience && Array.isArray(portfolioData.experience)) {
        for (const exp of portfolioData.experience) {
            const canonical = canonicalizeEmployer(exp.employer);
            if (!employerMap.has(canonical)) {
                employerMap.set(canonical, {
                    employer: canonical,
                    location: exp.location || 'Auckland, New Zealand',
                    role: exp.role || '',
                    dates: exp.dates || '',
                    maxBullets: DEFAULT_MAX_BULLETS[canonical] || 2,
                    rawBullets: []
                });
            }
            const record = employerMap.get(canonical);
            if (exp.role && (!record.role || exp.role.length > record.role.length)) {
                record.role = exp.role;
            }

            let respList = [];
            if (Array.isArray(exp.responsibilities)) {
                respList = exp.responsibilities;
            } else if (typeof exp.responsibilities === 'string') {
                const s = exp.responsibilities.trim();
                if (s) {
                    const sentences = s.split(/(?<=[.!?])\s+/).filter(part => part.trim().length > 10);
                    respList = sentences.length > 0 ? sentences : [s];
                }
            }

            for (const r of respList) {
                record.rawBullets.push({
                    text: r,
                    tags: [],
                    sourceFile: portfolioData.url || 'portfolio.onl9.club'
                });
            }
        }
    }

    // Deduplicate bullets for each employer
    const allMergedExperience = [];
    const canonicalOrder = [
        'Neurix Limited',
        'Datacom NZ',
        'Department of Education, Government of Delhi',
        'Mitre10 MEGA',
        'Woolworths New Zealand'
    ];

    const sortedEmployerKeys = Array.from(employerMap.keys()).sort((a, b) => {
        const idxA = canonicalOrder.indexOf(a);
        const idxB = canonicalOrder.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
    });

    for (const key of sortedEmployerKeys) {
        const record = employerMap.get(key);
        const deduped = deduplicateBullets(record.rawBullets);
        const expEntry = {
            employer: record.employer,
            location: record.location,
            role: record.role,
            dates: record.dates,
            maxBullets: record.maxBullets,
            bullets: deduped.map(d => ({
                text: d.text,
                tags: d.tags
            }))
        };
        if (record.dateNote) expEntry.dateNote = record.dateNote;
        allMergedExperience.push(expEntry);
    }

    // The 4 core IT/engineering employers to maintain 100% pipeline & page-budget consistency
    const CORE_EMPLOYERS = [
        'Neurix Limited',
        'Datacom NZ',
        'Department of Education, Government of Delhi',
        'Mitre10 MEGA'
    ];
    const primaryExperience = allMergedExperience.filter(e => CORE_EMPLOYERS.includes(e.employer));
    const additionalExperience = allMergedExperience.filter(e => !CORE_EMPLOYERS.includes(e.employer));

    // 4. Skills Merging
    const portfolioSkills = portfolioData.skills?.categories || {};
    const cvSkillsList = cvDataList.map(cv => cv.skills).filter(Boolean);
    const mergedSkills = mergeSkills(baseProfile.skills || [], portfolioSkills, cvSkillsList);

    // 5. Projects Merging & Canonicalization (3 canonical project groups)
    const CANONICAL_PROJECTS = [
        'Cloud Application Deployment',
        'VPS, Hosting & Recovery Lab',
        'Nextcloud & Systems Learning Lab'
    ];

    const projectMap = new Map();
    for (const name of CANONICAL_PROJECTS) {
        projectMap.set(name, {
            name,
            bullets: [],
            tags: new Set()
        });
    }

    // Ingest base projects
    for (const proj of (baseProfile.projects || [])) {
        const canonical = canonicalizeProject(proj.name);
        if (projectMap.has(canonical)) {
            const record = projectMap.get(canonical);
            for (const b of (proj.bullets || [])) record.bullets.push(b);
            for (const t of (proj.tags || [])) record.tags.add(t.toLowerCase());
        }
    }

    // Ingest CV projects
    for (const cv of cvDataList) {
        for (const proj of (cv.projects || [])) {
            const canonical = canonicalizeProject(proj.name);
            if (projectMap.has(canonical)) {
                const record = projectMap.get(canonical);
                for (const b of (proj.bullets || [])) {
                    record.bullets.push(b.text || b);
                }
            }
        }
    }

    // Ingest Portfolio projects & Learning Labs
    if (portfolioData.projects && Array.isArray(portfolioData.projects)) {
        for (const p of portfolioData.projects) {
            const canonical = canonicalizeProject(p.name);
            if (projectMap.has(canonical)) {
                const record = projectMap.get(canonical);
                if (p.description) record.bullets.push(p.description);
                for (const f of (p.features || [])) record.bullets.push(f);
                for (const t of (p.tech || [])) record.tags.add(t.toLowerCase());
            }
        }
    }

    // Deduplicate bullets and build the 3 canonical project groups
    const mergedProjects = [];
    for (const name of CANONICAL_PROJECTS) {
        const record = projectMap.get(name);
        const rawBullets = record.bullets.map(b => ({ text: b, tags: [] }));
        const deduped = deduplicateBullets(rawBullets);
        const combinedTags = generateTags(
            record.name + ' ' + deduped.map(d => d.text).join(' '),
            Array.from(record.tags)
        );
        mergedProjects.push({
            name: record.name,
            bullets: deduped.slice(0, 3).map(d => d.text), // keep top 2-3 metric-focused bullets per group
            tags: combinedTags
        });
    }

    // 6. Education Merging
    const educationMap = new Map();
    for (const edu of (baseProfile.education || [])) {
        const canonical = canonicalizeInstitution(edu.institution);
        educationMap.set(canonical, { ...edu, institution: canonical });
    }
    for (const cv of cvDataList) {
        for (const edu of (cv.education || [])) {
            const canonical = canonicalizeInstitution(edu.institution);
            if (!educationMap.has(canonical)) {
                educationMap.set(canonical, {
                    institution: canonical,
                    location: edu.location || 'Auckland, New Zealand',
                    qualification: edu.degree || '',
                    dates: edu.dates || '',
                    bullet: ''
                });
            }
            const record = educationMap.get(canonical);
            if (edu.degree && (!record.qualification || edu.degree.length > record.qualification.length)) {
                record.qualification = edu.degree;
            }
            if (edu.bullets && edu.bullets.length > 0 && !record.bullet) {
                record.bullet = edu.bullets[0].text;
            }
        }
    }

    // 7. Volunteer Merging
    const volunteerMap = new Map();
    for (const v of (baseProfile.volunteer || [])) {
        const canonical = canonicalizeVolunteer(v.organisation);
        volunteerMap.set(canonical, { ...v, organisation: canonical });
    }
    for (const cv of cvDataList) {
        for (const v of (cv.volunteer || [])) {
            const canonical = canonicalizeVolunteer(v.organisation);
            if (!volunteerMap.has(canonical)) {
                volunteerMap.set(canonical, {
                    organisation: canonical,
                    role: v.role || '',
                    bullet: v.bullets && v.bullets.length > 0 ? v.bullets[0].text : ''
                });
            }
        }
    }

    // Build the final aggregated candidate profile object
    const aggregatedProfile = {
        profileVersion: (baseProfile.profileVersion || 1) + 1,
        lastAggregated: new Date().toISOString(),
        sourceFiles: Array.from(sourceFiles),
        name: baseProfile.name || 'MAGHAV AHUJA',
        contact,
        workingRights: baseProfile.workingRights || 'New Zealand Post-Study Work Visa - valid to August 2027',
        summaryVariants,
        skills: mergedSkills,
        experience: options.includeAllExperience ? allMergedExperience : primaryExperience,
        additionalExperience,
        allExperience: allMergedExperience,
        projects: mergedProjects,
        volunteer: Array.from(volunteerMap.values()),
        education: Array.from(educationMap.values()),
        additional: baseProfile.additional || [
            'Languages: English (fluent) and Hindi (native)',
            'Working rights: New Zealand Post-Study Work Visa, valid to August 2027',
            'Availability: Willing to participate in on-call rotations and after-hours incident response',
            'Interests: Automation, cloud systems, service excellence, Linux, SRE and hardware troubleshooting'
        ]
    };

    return aggregatedProfile;
}

// ---------------------------------------------------------------------------
// 6. Safe Persistence & Automated Backup (Step 3.3)
// ---------------------------------------------------------------------------

/**
 * Backup candidate_profile.json to candidate_profile.backup.json.
 */
function backupProfile(profilePath = DEFAULT_PROFILE_PATH, backupPath = DEFAULT_BACKUP_PATH) {
    if (fs.existsSync(profilePath)) {
        try {
            const content = fs.readFileSync(profilePath, 'utf8');
            fs.writeFileSync(backupPath, content, 'utf8');
            return true;
        } catch (e) {
            console.warn(`[profile_aggregator] Failed to create backup: ${e.message}`);
            return false;
        }
    }
    return false;
}

/**
 * Safely persist aggregated profile with integrity checks and automated backup.
 */
function saveAggregatedProfile(profile, profilePath = DEFAULT_PROFILE_PATH, backupPath = DEFAULT_BACKUP_PATH) {
    // 1. Schema check
    const requiredKeys = ['name', 'contact', 'workingRights', 'summaryVariants', 'skills', 'experience', 'projects', 'volunteer', 'education', 'additional'];
    const missing = requiredKeys.filter(k => profile[k] == null);
    if (missing.length > 0) {
        throw new Error(`Cannot save invalid profile: missing keys [${missing.join(', ')}]`);
    }

    if (!Array.isArray(profile.experience) || profile.experience.length < 4) {
        throw new Error('Cannot save profile: must contain at least 4 employers');
    }
    if (!Array.isArray(profile.projects) || profile.projects.length < 1) {
        throw new Error('Cannot save profile: must contain at least 1 project');
    }

    // 2. Perform automated backup
    backupProfile(profilePath, backupPath);

    // 3. Atomically write profile
    const jsonText = JSON.stringify(profile, null, 2) + '\n';
    const tempPath = `${profilePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, jsonText, 'utf8');
    fs.renameSync(tempPath, profilePath);

    return true;
}

// ---------------------------------------------------------------------------
// 7. Full Aggregation Pipeline Runner
// ---------------------------------------------------------------------------

/**
 * Aggregate all career data from base profile, live portfolio, and CV PDFs.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
async function aggregateProfiles(options = {}) {
    const profilePath = options.profilePath || DEFAULT_PROFILE_PATH;
    const backupPath = options.backupPath || DEFAULT_BACKUP_PATH;
    const cvsDir = options.cvsDir || DEFAULT_MY_CVS_DIR;
    const forceRefresh = Boolean(options.force);
    const offlineOnly = Boolean(options.offline);
    const save = Boolean(options.save);

    // 1. Load base profile
    let baseProfile = {};
    if (fs.existsSync(profilePath)) {
        try {
            baseProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        } catch (e) {
            console.warn(`[profile_aggregator] Warning: Failed to parse ${profilePath}, starting with empty base`);
        }
    }

    // 2. Scrape/Load Portfolio Data
    let portfolioData = {};
    try {
        portfolioData = await scrapePortfolio({
            forceRefresh,
            offlineOnly
        });
    } catch (e) {
        console.warn(`[profile_aggregator] Warning: Portfolio ingestion failed (${e.message}), continuing without portfolio.`);
    }

    // 3. Parse Multi-CV PDFs
    let cvDataList = [];
    try {
        const cvResult = await parseAllCvs(cvsDir, { force: forceRefresh });
        cvDataList = cvResult.cvs || [];
    } catch (e) {
        console.warn(`[profile_aggregator] Warning: CV parsing failed (${e.message}), continuing with available data.`);
    }

    // 4. Merge Profiles
    const aggregated = mergeProfiles(baseProfile, portfolioData, cvDataList, options);

    // 5. Persist if requested
    if (save) {
        saveAggregatedProfile(aggregated, profilePath, backupPath);
    }

    return {
        profile: aggregated,
        sources: {
            baseProfileLoaded: Boolean(baseProfile.name),
            portfolioExtracted: Boolean(portfolioData.header),
            cvCount: cvDataList.length
        },
        stats: {
            totalSkills: aggregated.skills.reduce((acc, s) => acc + (s.tags ? s.tags.length : 0), 0),
            totalEmployers: aggregated.experience.length,
            totalBullets: aggregated.experience.reduce((acc, e) => acc + (e.bullets ? e.bullets.length : 0), 0),
            totalProjects: aggregated.projects.length
        }
    };
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

if (require.main === module) {
    const args = process.argv.slice(2);
    const force = args.includes('--force') || args.includes('-f');
    const offline = args.includes('--offline');
    const save = args.includes('--save') || args.includes('-s');
    const dump = args.includes('--dump');

    (async () => {
        try {
            console.log('=== Automated Dynamic CV Pipeline: Unified Profile Aggregator ===\n');
            const result = await aggregateProfiles({ force, offline, save });
            const p = result.profile;

            console.log(`Aggregated Profile Version: ${p.profileVersion} (Last Updated: ${p.lastAggregated})`);
            console.log(`Candidate: ${p.name} | ${p.contact.email} | ${p.contact.phone}`);
            console.log(`Working Rights: ${p.workingRights}`);
            console.log(`Source Provenance (${p.sourceFiles.length}):`);
            p.sourceFiles.forEach(s => console.log(`  - ${s}`));

            console.log(`\nWork Experience (${p.experience.length} primary employers, ${p.additionalExperience.length} additional):`);
            p.experience.forEach(e => {
                console.log(`  - ${e.employer}: ${e.role} (${e.dates}) [${e.bullets.length} deduplicated bullets]`);
            });

            console.log(`\nProjects (${p.projects.length}):`);
            p.projects.forEach(proj => {
                console.log(`  - ${proj.name}: ${proj.bullets.length} bullets | ${proj.tags.length} tags`);
            });

            console.log(`\nSkills Categories (${p.skills.length}):`);
            p.skills.forEach(s => {
                console.log(`  - ${s.category}: ${s.tags.length} tags`);
            });

            console.log(`\nStats: ${result.stats.totalEmployers} employers | ${result.stats.totalBullets} bullets | ${result.stats.totalSkills} indexed tags`);

            if (save) {
                console.log(`\n✓ Aggregated profile saved to ${DEFAULT_PROFILE_PATH}`);
                console.log(`✓ Automated backup preserved at ${DEFAULT_BACKUP_PATH}`);
            } else {
                console.log(`\n(Dry-run mode: profile was not overwritten. Use --save to persist changes.)`);
            }

            if (dump) {
                console.log('\n--- FULL AGGREGATED PROFILE JSON ---');
                console.log(JSON.stringify(p, null, 2));
            }

            console.log('\n✓ Profile aggregation completed successfully.');
        } catch (err) {
            console.error('\n✖ Aggregation error:', err);
            process.exit(1);
        }
    })();
}

module.exports = {
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
    normalizeEntityKey,
    backupProfile,
    saveAggregatedProfile,
    DEFAULT_PROFILE_PATH,
    DEFAULT_BACKUP_PATH,
    CANONICAL_SKILL_CATEGORIES
};
