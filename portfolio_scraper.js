#!/usr/bin/env node

/**
 * portfolio_scraper.js
 * Automated Dynamic CV Pipeline - Phase 1: Live Portfolio Ingestion Engine
 *
 * Discovers, extracts, and normalizes candidate career data from https://portfolio.onl9.club
 * Features:
 * - Robust Puppeteer DOM selector extraction for all sections:
 *   Header & Contact, Work Experience, Education, 8 Skills Categories, Learning Labs, and Projects.
 * - Cloudflare email obfuscation decoding (XOR bitwise decoder).
 * - Date range normalization & sanitization.
 * - Resilient 24-hour local caching (portfolio_cache.json).
 * - Transparent offline fallback (returns cache without disrupting pipeline on network/DNS errors).
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DEFAULT_PORTFOLIO_URL = process.env.PORTFOLIO_URL || 'https://portfolio.onl9.club';
const DEFAULT_CACHE_PATH = path.resolve(__dirname, 'portfolio_cache.json');
const DEFAULT_CACHE_HOURS = parseInt(process.env.PORTFOLIO_CACHE_HOURS, 10) || 24;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Decode Cloudflare email obfuscation token using the standard XOR algorithm.
 * Handles hex tokens directly, data-cfemail attributes, or /cdn-cgi/l/email-protection#<hex> URLs.
 *
 * @param {string} encodedString - The hex string or URL containing the obfuscated email
 * @returns {string|null} - The decoded email address, or null if invalid
 */
function decodeCloudflareEmail(encodedString) {
    if (!encodedString || typeof encodedString !== 'string') return null;
    try {
        const hex = encodedString
            .replace(/^.*(?:#|data-cfemail=["']?)/, '')
            .replace(/["'].*$/, '')
            .trim();
        if (!hex || hex.length < 4 || hex.length % 2 !== 0) return null;

        const key = parseInt(hex.substr(0, 2), 16);
        let email = '';
        for (let i = 2; i < hex.length; i += 2) {
            const charCode = parseInt(hex.substr(i, 2), 16) ^ key;
            email += String.fromCharCode(charCode);
        }
        return email.includes('@') ? email : null;
    } catch {
        return null;
    }
}

/**
 * Normalize date ranges into standard schema:
 * { raw, start, end, isCurrent, formatted }
 *
 * @param {string} rawDate - Date string e.g. "August 2025 – Present", "Feb 2023 – July 2024", "2019 – 2022"
 * @returns {object}
 */
function normalizeDateRange(rawDate) {
    if (!rawDate || typeof rawDate !== 'string') {
        return { raw: '', start: '', end: '', isCurrent: false, formatted: '' };
    }

    // Strip HTML comments, tags, and collapse whitespace
    let cleaned = rawDate
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    // Standardize various dash forms: en-dash, em-dash, hyphen, or word 'to'
    const dashPattern = /\s*(?:[–—]| - | to )\s*/i;
    const parts = cleaned.split(dashPattern);

    let start = (parts[0] || '').trim();
    let end = (parts[1] || '').trim();

    const isCurrent = /present|current|ongoing|now/i.test(end || start);
    if (!end && isCurrent) {
        end = 'Present';
    }

    const formatted = end ? `${start} – ${end}` : start;

    return {
        raw: cleaned,
        start,
        end: end || (isCurrent ? 'Present' : start),
        isCurrent,
        formatted
    };
}

/**
 * Clean text strings of HTML comments, line breaks, and excess whitespace.
 */
function cleanText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\r\n|\r|\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Standard Puppeteer launch options with headless flags.
 */
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

/**
 * Check if the cached portfolio file is present and within the TTL.
 *
 * @param {string} cachePath - Path to portfolio_cache.json
 * @param {number} ttlHours - TTL in hours
 * @returns {boolean}
 */
function isCacheValid(cachePath = DEFAULT_CACHE_PATH, ttlHours = DEFAULT_CACHE_HOURS) {
    try {
        if (!fs.existsSync(cachePath)) return false;
        const stat = fs.statSync(cachePath);
        if (stat.size < 50) return false;

        const raw = fs.readFileSync(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.timestamp || !parsed.data) return false;

        const ageMs = Date.now() - parsed.timestamp;
        const maxAgeMs = ttlHours * 3600 * 1000;
        return ageMs < maxAgeMs;
    } catch {
        return false;
    }
}

/**
 * Load cached portfolio data from disk.
 *
 * @param {string} cachePath - Path to portfolio_cache.json
 * @returns {object|null}
 */
function loadPortfolioCache(cachePath = DEFAULT_CACHE_PATH) {
    try {
        if (!fs.existsSync(cachePath)) return null;
        const raw = fs.readFileSync(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed;
    } catch (err) {
        console.warn(`[portfolio_scraper] Failed to read cache from ${cachePath}: ${err.message}`);
        return null;
    }
}

/**
 * Save portfolio data to cache file atomically.
 *
 * @param {string} cachePath - Path to portfolio_cache.json
 * @param {object} data - Normalized portfolio data
 * @param {string} url - Source URL
 */
function savePortfolioCache(cachePath = DEFAULT_CACHE_PATH, data, url = DEFAULT_PORTFOLIO_URL) {
    try {
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const payload = {
            timestamp: Date.now(),
            fetchedAt: new Date().toISOString(),
            url,
            data
        };

        const tempPath = `${cachePath}.tmp.${Date.now()}`;
        fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tempPath, cachePath);
        return true;
    } catch (err) {
        console.warn(`[portfolio_scraper] Failed to write cache to ${cachePath}: ${err.message}`);
        return false;
    }
}

/**
 * Extract portfolio entities from an active Puppeteer page via DOM selectors.
 *
 * @param {import('puppeteer').Page} page - Active Puppeteer page
 * @returns {Promise<object>} Extracted and structured portfolio data
 */
async function extractFromPage(page) {
    const rawData = await page.evaluate(() => {
        const clean = (t) => (t || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();

        // 1. Header & Contact Details
        const headerSection = document.querySelector('main > section > div.flex, main .flex.items-center.justify-between');
        const name = clean(headerSection?.querySelector('h1')?.innerText || document.querySelector('h1')?.innerText);
        const title = clean(headerSection?.querySelector('h1 ~ p')?.innerText || document.querySelector('h1 ~ p')?.innerText);
        const location = clean(headerSection?.querySelector('a[href*="maps/place"]')?.innerText);

        let email = '';
        const mailtoEl = document.querySelector('a[href^="mailto:"]');
        if (mailtoEl) {
            email = mailtoEl.getAttribute('href').replace('mailto:', '').split('?')[0].trim();
        }

        const cfEmailEl = document.querySelector('[data-cfemail]');
        const cfData = cfEmailEl ? cfEmailEl.getAttribute('data-cfemail') : null;
        const cfHrefEl = document.querySelector('a[href*="email-protection"]');
        const cfHref = cfHrefEl ? cfHrefEl.getAttribute('href') : null;

        const phoneEl = document.querySelector('a[href^="tel:"]');
        const phone = phoneEl ? clean(phoneEl.getAttribute('href').replace('tel:', '')) : '';

        let linkedin = '';
        let github = '';
        const socials = [];

        (headerSection || document).querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href') || '';
            const titleAttr = a.querySelector('title')?.innerText || a.getAttribute('title') || a.innerText || '';
            if (href.includes('linkedin.com') && !linkedin) linkedin = href;
            if (href.includes('github.com') && !github && !href.includes('/automated-job-apply-pipeline')) github = href;
            if (href.startsWith('http') && !href.includes('google.com/maps') && !href.includes('onl9.club')) {
                socials.push({ href, name: clean(titleAttr) || href });
            }
        });

        // 2. Sections identification
        const sections = Array.from(document.querySelectorAll('main section section, main > section > section'));

        // About
        let about = '';
        for (const s of sections) {
            const h2 = s.querySelector('h2');
            if (h2 && clean(h2.innerText).toUpperCase() === 'ABOUT') {
                const p = s.querySelector('p');
                if (p) about = clean(p.innerText);
            }
        }

        // 3. Work Experience
        const experience = [];
        for (const s of sections) {
            const h2 = s.querySelector('h2');
            if (h2 && clean(h2.innerText).toUpperCase() === 'WORK EXPERIENCE') {
                const cards = s.querySelectorAll('.bg-card');
                cards.forEach(card => {
                    const linkEl = card.querySelector('h3 a') || card.querySelector('a');
                    const compEl = card.querySelector('h3') || linkEl;
                    const employer = clean(compEl?.innerText);
                    const companyUrl = linkEl ? (linkEl.getAttribute('href') || '') : '';
                    const dateEl = card.querySelector('.font-mono.whitespace-nowrap, div.font-mono');
                    const dates = clean(dateEl?.innerText);
                    const locEl = card.querySelector('.bg-neo-yellow, [class*="bg-neo-yellow"]');
                    const cardLocation = clean(locEl?.innerText);
                    const roleEl = card.querySelector('p.font-mono.font-extrabold, p.font-extrabold');
                    const role = clean(roleEl?.innerText);
                    const descEl = card.querySelector('p.text-muted-foreground.leading-relaxed, p.leading-relaxed');
                    const responsibilities = clean(descEl?.innerText);

                    if (employer) {
                        experience.push({
                            employer,
                            companyUrl,
                            role,
                            dates,
                            location: cardLocation,
                            responsibilities
                        });
                    }
                });
            }
        }

        // 4. Education
        const education = [];
        for (const s of sections) {
            const h2 = s.querySelector('h2');
            if (h2 && clean(h2.innerText).toUpperCase() === 'EDUCATION') {
                const cards = s.querySelectorAll('.bg-card');
                cards.forEach(card => {
                    const instEl = card.querySelector('h3');
                    const instText = clean(instEl?.innerText);
                    const dateEl = card.querySelector('.font-mono.whitespace-nowrap, div.font-mono');
                    const dates = clean(dateEl?.innerText);
                    const degEl = card.querySelector('p.font-mono, p.font-bold');
                    const degree = clean(degEl?.innerText);

                    if (instText) {
                        education.push({
                            rawInstitution: instText,
                            dates,
                            degree
                        });
                    }
                });
            }
        }

        // 5. Skills & Technologies (All 8 categories)
        const skills = {};
        for (const s of sections) {
            const h2 = s.querySelector('h2');
            if (h2 && clean(h2.innerText).toUpperCase() === 'SKILLS & TECHNOLOGIES') {
                const groups = s.querySelectorAll('.space-y-2');
                groups.forEach(group => {
                    const catH3 = group.querySelector('h3');
                    if (catH3) {
                        const catName = clean(catH3.innerText);
                        const badgeEls = group.querySelectorAll('.flex.flex-wrap > div');
                        const badges = Array.from(badgeEls)
                            .map(b => clean(b.innerText).replace(/,\s*$/, ''))
                            .filter(Boolean);
                        skills[catName] = badges;
                    }
                });
            }
        }

        // 6. Learning/Troubleshooting Experience
        const learningLabs = [];
        for (const s of sections) {
            const h2 = s.querySelector('h2');
            if (h2 && clean(h2.innerText).toUpperCase().includes('LEARNING')) {
                const cards = s.querySelectorAll('.bg-card');
                cards.forEach(card => {
                    const linkEl = card.querySelector('h3 a') || card.querySelector('a');
                    const titleEl = card.querySelector('h3') || linkEl;
                    const labName = clean(titleEl?.innerText);
                    const url = linkEl ? (linkEl.getAttribute('href') || '') : '';
                    const descEl = card.querySelector('p.text-muted-foreground');
                    const desc = clean(descEl?.innerText);
                    const badgeEls = card.querySelectorAll('.bg-neo-blue, [class*="bg-neo-blue"]');
                    const technologies = Array.from(badgeEls).map(b => clean(b.innerText)).filter(Boolean);

                    if (labName) {
                        learningLabs.push({
                            name: labName,
                            url,
                            description: desc,
                            technologies
                        });
                    }
                });
            }
        }

        // 7. Projects
        const projects = [];
        for (const s of sections) {
            const h2 = s.querySelector('h2');
            if (h2 && clean(h2.innerText).toUpperCase() === 'PROJECTS') {
                const cards = s.querySelectorAll('.bg-card');
                cards.forEach(card => {
                    const linkEl = card.querySelector('h3 a') || card.querySelector('a');
                    const titleEl = card.querySelector('h3') || linkEl;
                    const projName = clean(titleEl?.innerText);
                    const url = linkEl ? (linkEl.getAttribute('href') || '') : '';
                    const descEl = card.querySelector('p.text-muted-foreground');
                    const desc = clean(descEl?.innerText);
                    const badgeEls = card.querySelectorAll('.bg-neo-blue, [class*="bg-neo-blue"]');
                    const technologies = Array.from(badgeEls).map(b => clean(b.innerText)).filter(Boolean);

                    if (projName) {
                        projects.push({
                            name: projName,
                            url,
                            description: desc,
                            technologies
                        });
                    }
                });
            }
        }

        // 8. Attachments
        const attachments = [];
        for (const s of sections) {
            const h2 = s.querySelector('h2');
            if (h2 && clean(h2.innerText).toUpperCase() === 'ATTACHMENTS') {
                const cards = s.querySelectorAll('.bg-card');
                cards.forEach(card => {
                    const linkEl = card.querySelector('h3 a') || card.querySelector('a');
                    const titleEl = card.querySelector('h3') || linkEl;
                    const title = clean(titleEl?.innerText);
                    const url = linkEl ? (linkEl.getAttribute('href') || '') : '';
                    if (title) {
                        attachments.push({ title, url });
                    }
                });
            }
        }

        return {
            header: {
                name,
                title,
                location,
                phone,
                email,
                cfData,
                cfHref,
                linkedin,
                github,
                socials,
                about
            },
            experience,
            education,
            skills,
            learningLabs,
            projects,
            attachments
        };
    });

    // Step 1.3: Data Normalization & Sanitization
    const email = rawData.header.email ||
        decodeCloudflareEmail(rawData.header.cfData) ||
        decodeCloudflareEmail(rawData.header.cfHref) ||
        '';

    const normalizedExperience = (rawData.experience || []).map(exp => ({
        employer: cleanText(exp.employer),
        companyUrl: exp.companyUrl || '',
        role: cleanText(exp.role),
        dates: normalizeDateRange(exp.dates).formatted,
        dateDetails: normalizeDateRange(exp.dates),
        location: cleanText(exp.location),
        responsibilities: cleanText(exp.responsibilities)
    }));

    const normalizedEducation = (rawData.education || []).map(edu => {
        const rawInst = cleanText(edu.rawInstitution);
        let institution = rawInst;
        let eduLocation = '';

        // Extract location if present in institution string (e.g. "Unitec..., Auckland, New Zealand")
        const commaIdx = rawInst.indexOf(',');
        if (commaIdx > -1) {
            institution = rawInst.substring(0, commaIdx).trim();
            eduLocation = rawInst.substring(commaIdx + 1).trim();
        }

        return {
            institution,
            location: eduLocation,
            degree: cleanText(edu.degree),
            dates: normalizeDateRange(edu.dates).formatted,
            dateDetails: normalizeDateRange(edu.dates)
        };
    });

    // Flatten and deduplicate all skills
    const allSkillsSet = new Set();
    const normalizedSkillsCategories = {};
    for (const [category, items] of Object.entries(rawData.skills || {})) {
        const cleanCat = cleanText(category);
        const cleanItems = (items || []).map(cleanText).filter(Boolean);
        normalizedSkillsCategories[cleanCat] = cleanItems;
        cleanItems.forEach(skill => allSkillsSet.add(skill));
    }

    return {
        header: {
            name: cleanText(rawData.header.name),
            title: cleanText(rawData.header.title),
            location: cleanText(rawData.header.location),
            email: cleanText(email),
            phone: cleanText(rawData.header.phone),
            linkedin: rawData.header.linkedin || '',
            github: rawData.header.github || '',
            socials: rawData.header.socials || [],
            about: cleanText(rawData.header.about)
        },
        experience: normalizedExperience,
        education: normalizedEducation,
        skills: {
            categories: normalizedSkillsCategories,
            allSkills: Array.from(allSkillsSet)
        },
        learningLabs: (rawData.learningLabs || []).map(lab => ({
            name: cleanText(lab.name),
            url: lab.url || '',
            description: cleanText(lab.description),
            technologies: (lab.technologies || []).map(cleanText).filter(Boolean)
        })),
        projects: (rawData.projects || []).map(proj => ({
            name: cleanText(proj.name),
            url: proj.url || '',
            description: cleanText(proj.description),
            technologies: (proj.technologies || []).map(cleanText).filter(Boolean)
        })),
        attachments: rawData.attachments || []
    };
}

/**
 * Fallback candidate data structure derived from base candidate_profile.json
 * in case the website is offline AND no cache exists yet.
 */
function getEmergencyFallbackProfile(workspaceRoot = __dirname) {
    const candidatePaths = [
        path.resolve(workspaceRoot, 'candidate_profile.json'),
        path.resolve(workspaceRoot, '..', 'candidate_profile.json'),
        path.resolve(__dirname, 'candidate_profile.json'),
        path.resolve(process.cwd(), 'candidate_profile.json')
    ];
    const profilePath = candidatePaths.find(p => fs.existsSync(p));
    if (profilePath) {
        try {
            const raw = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            return {
                header: {
                    name: raw.name || '',
                    title: 'DevOps, Systems, and Technical Support Engineer',
                    location: raw.contact?.location || '',
                    email: raw.contact?.email || '',
                    phone: raw.contact?.phone || '',
                    linkedin: raw.contact?.linkedin ? `https://${raw.contact.linkedin}` : '',
                    github: raw.contact?.github ? `https://${raw.contact.github}` : '',
                    socials: [],
                    about: raw.summaryVariants?.systems || ''
                },
                experience: (raw.experience || []).map(e => ({
                    employer: e.employer,
                    companyUrl: '',
                    role: e.role,
                    dates: e.dates,
                    dateDetails: normalizeDateRange(e.dates),
                    location: e.location,
                    responsibilities: (e.bullets || []).map(b => b.text).join(' ')
                })),
                education: (raw.education || []).map(e => ({
                    institution: e.institution,
                    location: e.location,
                    degree: e.qualification,
                    dates: e.dates,
                    dateDetails: normalizeDateRange(e.dates)
                })),
                skills: {
                    categories: {},
                    allSkills: (raw.skills || []).flatMap(s => s.tags || [])
                },
                learningLabs: [],
                projects: (raw.projects || []).map(p => ({
                    name: p.name,
                    url: '',
                    description: (p.bullets || []).join(' '),
                    technologies: p.tags || []
                })),
                attachments: []
            };
        } catch {
            // ignore
        }
    }
    return null;
}

/**
 * Main entry point: Scrapes https://portfolio.onl9.club with resilient caching and offline fallback.
 *
 * @param {object} options
 * @param {string} [options.url] - Portfolio URL (default: process.env.PORTFOLIO_URL || 'https://portfolio.onl9.club')
 * @param {string} [options.cachePath] - Path to portfolio_cache.json
 * @param {number} [options.cacheTtlHours] - Cache TTL in hours (default: 24)
 * @param {boolean} [options.forceRefresh] - If true, bypass cache and fetch live
 * @param {boolean} [options.offlineOnly] - If true, only read from cache or fallback
 * @param {object} [options.browserInstance] - Optional existing Puppeteer browser instance
 * @param {number} [options.timeoutMs] - Navigation timeout (default: 30000ms)
 * @returns {Promise<object>} Normalized candidate profile from portfolio
 */
async function scrapePortfolio(options = {}) {
    const {
        url = DEFAULT_PORTFOLIO_URL,
        cachePath = DEFAULT_CACHE_PATH,
        cacheTtlHours = DEFAULT_CACHE_HOURS,
        forceRefresh = false,
        offlineOnly = false,
        browserInstance = null,
        timeoutMs = DEFAULT_TIMEOUT_MS
    } = options;

    // Step 1.2: Check cache validity
    const cacheValid = isCacheValid(cachePath, cacheTtlHours);
    if (!forceRefresh && (cacheValid || offlineOnly)) {
        const cached = loadPortfolioCache(cachePath);
        if (cached && cached.data) {
            console.log(`[portfolio_scraper] Loaded portfolio from cache (${cached.fetchedAt || 'timestamp: ' + cached.timestamp}).`);
            return {
                ...cached.data,
                fromCache: true,
                isFallback: false,
                fetchedAt: cached.fetchedAt,
                cacheAgeHours: ((Date.now() - cached.timestamp) / (3600 * 1000)).toFixed(1)
            };
        }
    }

    if (offlineOnly) {
        console.warn(`[portfolio_scraper] Offline mode requested and cache missing; loading emergency base profile.`);
        const fallback = getEmergencyFallbackProfile(path.dirname(cachePath));
        return {
            ...fallback,
            fromCache: false,
            isFallback: true,
            warning: 'Loaded emergency base profile (offline mode with no cache).'
        };
    }

    // Step 1.1: Live extraction via Puppeteer
    let browser = browserInstance;
    let ownBrowser = false;
    try {
        console.log(`[portfolio_scraper] Fetching live portfolio from ${url}...`);
        if (!browser) {
            browser = await puppeteer.launch(getBrowserLaunchOptions());
            ownBrowser = true;
        }

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 900 });

        // Navigate to portfolio site
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: timeoutMs
        });

        const extractedData = await extractFromPage(page);
        await page.close();

        // Step 1.2: Save successful result to cache
        savePortfolioCache(cachePath, extractedData, url);
        console.log(`[portfolio_scraper] Successfully scraped live portfolio and saved to cache (${cachePath}).`);

        return {
            ...extractedData,
            fromCache: false,
            isFallback: false,
            fetchedAt: new Date().toISOString()
        };

    } catch (err) {
        // Step 1.2: Transparent offline fallback
        console.warn(`[portfolio_scraper] Warning: Unable to scrape live portfolio (${err.message}). Attempting offline cache fallback...`);
        const cached = loadPortfolioCache(cachePath);
        if (cached && cached.data) {
            console.log(`[portfolio_scraper] Successfully fell back to cached portfolio (${cached.fetchedAt || cached.timestamp}).`);
            return {
                ...cached.data,
                fromCache: true,
                isFallback: false,
                warning: `Fell back to cache due to live scrape error: ${err.message}`
            };
        }

        // Emergency fallback to candidate_profile.json
        console.warn(`[portfolio_scraper] No valid cache found. Falling back to local candidate_profile.json...`);
        const fallback = getEmergencyFallbackProfile(path.dirname(cachePath));
        if (fallback) {
            return {
                ...fallback,
                fromCache: false,
                isFallback: true,
                warning: `Fell back to local profile due to: ${err.message}`
            };
        }

        throw new Error(`Failed to scrape live portfolio and no offline fallback available: ${err.message}`);
    } finally {
        if (ownBrowser && browser) {
            await browser.close();
        }
    }
}

// Standalone CLI runner
if (require.main === module) {
    const args = process.argv.slice(2);
    const forceRefresh = args.includes('--force') || args.includes('-f');
    const offlineOnly = args.includes('--offline');
    const dump = args.includes('--dump');

    (async () => {
        try {
            console.log(`=== Automated Dynamic CV Pipeline: Portfolio Scraper ===`);
            const profile = await scrapePortfolio({
                forceRefresh,
                offlineOnly
            });

            console.log(`\nCandidate: ${profile.header?.name || 'N/A'}`);
            console.log(`Title: ${profile.header?.title || 'N/A'}`);
            console.log(`Email: ${profile.header?.email || 'N/A'} | Phone: ${profile.header?.phone || 'N/A'}`);
            console.log(`Location: ${profile.header?.location || 'N/A'}`);
            console.log(`Roles Extracted (${profile.experience?.length || 0}):`);
            (profile.experience || []).forEach(e => {
                console.log(` - ${e.employer}: ${e.role} (${e.dates}) [${e.location}]`);
            });
            console.log(`Education Extracted (${profile.education?.length || 0}):`);
            (profile.education || []).forEach(e => {
                console.log(` - ${e.institution}: ${e.degree} (${e.dates})`);
            });
            console.log(`Skill Categories (${Object.keys(profile.skills?.categories || {}).length}):`);
            for (const [cat, skills] of Object.entries(profile.skills?.categories || {})) {
                console.log(` - ${cat} (${skills.length}): ${skills.slice(0, 5).join(', ')}${skills.length > 5 ? '...' : ''}`);
            }
            console.log(`Learning Labs (${profile.learningLabs?.length || 0}):`);
            (profile.learningLabs || []).forEach(l => console.log(` - ${l.name}: ${l.url}`));
            console.log(`Projects (${profile.projects?.length || 0}):`);
            (profile.projects || []).forEach(p => console.log(` - ${p.name}: ${p.url}`));

            if (dump) {
                console.log('\n--- FULL DUMP ---');
                console.log(JSON.stringify(profile, null, 2));
            }

            console.log('\n✓ Portfolio scraping completed successfully.');
        } catch (e) {
            console.error(`\n✖ Error in portfolio scraper: ${e.message}`);
            process.exit(1);
        }
    })();
}

module.exports = {
    scrapePortfolio,
    extractFromPage,
    decodeCloudflareEmail,
    normalizeDateRange,
    cleanText,
    isCacheValid,
    loadPortfolioCache,
    savePortfolioCache,
    getEmergencyFallbackProfile,
    getBrowserLaunchOptions,
    DEFAULT_PORTFOLIO_URL,
    DEFAULT_CACHE_PATH,
    DEFAULT_CACHE_HOURS
};
