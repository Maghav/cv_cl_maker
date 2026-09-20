#!/usr/bin/env node

/**
 * cv_parser.js
 * Automated Dynamic CV Pipeline - Phase 2: Multi-CV PDF Text & Section Parser
 *
 * Features:
 * - Dynamic PDF discovery in my_cvs/*.pdf
 * - SHA-256 change detection via persistent manifest (my_cvs/.manifest.json)
 * - Sectional & semantic extraction: Summary, Skills, Experience, Projects, Volunteer, Education, Additional
 * - Source traceability: Granular tagging of every bullet and entity with sourceFile and sourceHash
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pdfParse;
try {
    pdfParse = require('pdf-parse');
} catch (e) {
    try {
        pdfParse = require(path.resolve(__dirname, 'node_modules/pdf-parse'));
    } catch (_) {}
}

const DEFAULT_MY_CVS_DIR = path.resolve(__dirname, 'my_cvs');
const DEFAULT_MANIFEST_NAME = '.manifest.json';

/**
 * Compute SHA-256 hex digest for a file buffer or path.
 *
 * @param {string|Buffer} input - File path or Buffer
 * @returns {string} - SHA-256 hex string
 */
function computeFileHash(input) {
    const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Clean text strings of line breaks, excess whitespace, and bullet markers.
 *
 * @param {string} text
 * @returns {string}
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
 * Normalize date ranges into structured schema: { raw, start, end, isCurrent, formatted }
 *
 * @param {string} rawDate
 * @returns {object}
 */
function normalizeDateRange(rawDate) {
    if (!rawDate || typeof rawDate !== 'string') {
        return { raw: '', start: '', end: '', isCurrent: false, formatted: '' };
    }
    const cleaned = cleanText(rawDate);
    const dashPattern = /\s*(?:[–—]| - | to )\s*/i;
    const parts = cleaned.split(dashPattern);
    let start = (parts[0] || '').trim();
    let end = (parts[1] || '').trim();

    const isCurrent = /present|current|ongoing|now/i.test(end || start);
    if (!end && isCurrent) end = 'Present';

    const formatted = end ? `${start} – ${end}` : start;
    return { raw: cleaned, start, end: end || (isCurrent ? 'Present' : start), isCurrent, formatted };
}

/**
 * Regex patterns for standard section header detection.
 */
const SECTION_PATTERNS = [
    { key: 'summary', regex: /^(?:PROFESSIONAL\s+SUMMARY|SUMMARY|PROFILE|ABOUT\s+ME)\s*$/i },
    { key: 'skills', regex: /^(?:TECHNICAL\s+SKILLS|SKILLSET|SKILLS(?:\s+&\s+TECHNOLOGIES)?)\s*$/i },
    { key: 'experience', regex: /^(?:PROFESSIONAL\s+EXPERIENCE|WORK\s+EXPERIENCE|EXPERIENCE|EMPLOYMENT(?:\s+HISTORY)?)\s*$/i },
    { key: 'projects', regex: /^(?:KEY\s+PROJECTS|PRACTICAL\s+EXPERIENCE\s*\(PROJECTS\)|PROJECTS)\s*$/i },
    { key: 'volunteer', regex: /^(?:VOLUNTEER(?:\s+EXPERIENCE)?|COMMUNITY(?:\s+WORK)?)\s*$/i },
    { key: 'education', regex: /^(?:EDUCATION|ACADEMIC(?:\s+BACKGROUND)?|QUALIFICATIONS)\s*$/i },
    { key: 'additional', regex: /^(?:ADDITIONAL\s+INFORMATION|ADDITIONAL|CERTIFICATIONS|MISCELLANEOUS)\s*$/i }
];

/**
 * Check if a line is a section heading.
 */
function matchSectionHeading(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 50) return null;
    for (const p of SECTION_PATTERNS) {
        if (p.regex.test(trimmed)) return p.key;
    }
    return null;
}

/**
 * Check if a line is a bullet item.
 */
function isBulletLine(line) {
    const trimmed = line.trim();
    return /^[\u2022\u25CF\u25AA\u2023\u2219\*\-]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed);
}

/**
 * Strip leading bullet marker.
 */
function stripBulletMarker(line) {
    return line.trim().replace(/^[\u2022\u25CF\u25AA\u2023\u2219\*\-]\s+/, '').replace(/^\d+\.\s+/, '').trim();
}

/**
 * Regex for date ranges (e.g. "August 2025 – Present", "Sep 2022 – Jan 2023", "2019 – 2022").
 */
const DATE_RANGE_REGEX = /(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4})\s*(?:[–—\-]|to)\s*(?:Present|Current|Now|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4})/i;

/**
 * Extract contact and personal details from raw text / header lines.
 */
function extractContactFromText(rawText) {
    const emailMatch = rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const phoneMatch = rawText.match(/(?:\+?\d{1,3}[\s-]?)?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/);
    const linkedinMatch = rawText.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
    const githubMatch = rawText.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[a-zA-Z0-9_-]+/i);
    const locationMatch = rawText.match(/(?:Auckland|Wellington|Christchurch|New Zealand|New Delhi|India)[^|\n]*/i);
    const visaMatch = rawText.match(/(?:NZ\s+Post-Study\s+Work\s+Visa|Post-Study\s+Work\s+Visa|working\s+rights)[^\n|]*/i);

    // Name is typically in the first few non-empty lines
    const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let name = '';
    for (let i = 0; i < Math.min(5, lines.length); i++) {
        const line = lines[i];
        if (!emailMatch || !line.includes(emailMatch[0])) {
            if (/^[A-Z\s]{4,35}$/.test(line) || /^[A-Z][a-z]+\s+[A-Z][a-z]+/.test(line)) {
                name = line;
                break;
            }
        }
    }

    return {
        name: name || 'MAGHAV AHUJA',
        email: emailMatch ? emailMatch[0].trim() : '',
        phone: phoneMatch ? phoneMatch[0].trim() : '',
        location: locationMatch ? cleanText(locationMatch[0].replace(/\|.*$/, '')) : 'Auckland, New Zealand',
        linkedin: linkedinMatch ? (linkedinMatch[0].startsWith('http') ? linkedinMatch[0] : `https://${linkedinMatch[0]}`) : '',
        github: githubMatch ? (githubMatch[0].startsWith('http') ? githubMatch[0] : `https://${githubMatch[0]}`) : '',
        workingRights: visaMatch ? cleanText(visaMatch[0]) : ''
    };
}

/**
 * Parse lines into sections map: { header: [], summary: [], skills: [], experience: [], ... }
 */
function partitionSections(rawText) {
    const lines = rawText.split(/\r?\n/);
    const sections = {
        header: [],
        summary: [],
        skills: [],
        experience: [],
        projects: [],
        volunteer: [],
        education: [],
        additional: []
    };

    let currentSection = 'header';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const headingKey = matchSectionHeading(trimmed);

        if (headingKey) {
            currentSection = headingKey;
            continue;
        }

        sections[currentSection].push(line);
    }

    return sections;
}

/**
 * Heuristic parser for Skills section lines.
 * Handles both:
 * • Category: item1, item2...
 * Category: item1, item2...
 */
function parseSkillsSection(lines, sourceFileName, sourceHash) {
    const categories = {};
    const allSkills = new Set();
    let currentCategory = 'General';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const cleanLine = stripBulletMarker(trimmed);
        const colonIdx = cleanLine.indexOf(':');

        if (colonIdx > 0 && colonIdx < 50) {
            const cat = cleanText(cleanLine.substring(0, colonIdx));
            const content = cleanText(cleanLine.substring(colonIdx + 1));
            currentCategory = cat;
            if (!categories[currentCategory]) categories[currentCategory] = [];

            // Split items by comma or semicolon
            const rawItems = content.split(/[,;]/).map(cleanText).filter(s => s.length > 1 && s.length < 150);
            for (const item of rawItems) {
                categories[currentCategory].push(item);
                // Also add primary keyword if item contains a dash separator (e.g. "Terraform — cloud ...")
                const dashSplit = item.split(/\s*(?:—| - | – )\s*/);
                if (dashSplit.length > 1 && dashSplit[0].length > 1 && dashSplit[0].length < 40) {
                    allSkills.add(cleanText(dashSplit[0]));
                }
                allSkills.add(item);
            }
        } else if (cleanLine) {
            if (!categories[currentCategory]) categories[currentCategory] = [];
            const rawItems = cleanLine.split(/[,;]/).map(cleanText).filter(s => s.length > 1 && s.length < 150);
            for (const item of rawItems) {
                categories[currentCategory].push(item);
                const dashSplit = item.split(/\s*(?:—| - | – )\s*/);
                if (dashSplit.length > 1 && dashSplit[0].length > 1 && dashSplit[0].length < 40) {
                    allSkills.add(cleanText(dashSplit[0]));
                }
                allSkills.add(item);
            }
        }
    }

    return {
        categories,
        allSkills: Array.from(allSkills),
        sourceFile: sourceFileName,
        sourceHash
    };
}

/**
 * Heuristic parser for Work Experience section.
 * Identifies employers, role titles, dates, locations, and bullet points.
 */
function parseExperienceSection(lines, sourceFileName, sourceHash) {
    const experience = [];
    let currentExp = null;
    let currentBullet = '';

    function pushCurrentBullet() {
        if (currentExp && currentBullet.trim()) {
            currentExp.bullets.push({
                text: cleanText(currentBullet),
                sourceFile: sourceFileName,
                sourceHash
            });
            currentBullet = '';
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check if line is a bullet item
        if (isBulletLine(line)) {
            pushCurrentBullet();
            currentBullet = stripBulletMarker(line);
            continue;
        }

        // If inside a bullet and line doesn't look like a new employer/role header, append to bullet
        const dateMatch = trimmed.match(DATE_RANGE_REGEX);
        const hasDate = !!dateMatch;

        if (currentBullet && !hasDate && trimmed.length > 2) {
            // Check if next line has date (which would mean current line is an employer!)
            const nextLine = (lines[i + 1] || '').trim();
            const nextHasDate = nextLine.match(DATE_RANGE_REGEX);
            if (!nextHasDate) {
                currentBullet += ' ' + trimmed;
                continue;
            }
        }

        // Potential new employer or role line
        pushCurrentBullet();

        if (hasDate) {
            // This line contains date range (e.g. "Systems/DevOps Engineer (Casual Contract) August 2025 – Present")
            const dateStr = dateMatch[0];
            const roleStr = cleanText(trimmed.replace(dateStr, ''));
            const dateDetails = normalizeDateRange(dateStr);

            if (currentExp && (!currentExp.role || currentExp.role === 'Professional')) {
                currentExp.role = roleStr || currentExp.role;
                currentExp.dates = dateDetails.formatted;
                currentExp.dateDetails = dateDetails;
            } else {
                // If no current employer or role already populated, create new entry
                const prevLine = cleanText(lines[i - 1] || '');
                let employer = 'Previous Experience';
                let location = '';

                if (prevLine && !isBulletLine(prevLine) && prevLine.length < 80) {
                    // Extract location if in prevLine (e.g. "Neurix Limited Auckland, New Zealand")
                    const locMatch = prevLine.match(/(?:Auckland|Wellington|Christchurch|New Zealand|New Delhi|India)[^|\n]*/i);
                    if (locMatch) {
                        location = cleanText(locMatch[0]);
                        employer = cleanText(prevLine.replace(locMatch[0], ''));
                    } else {
                        employer = prevLine;
                    }
                }

                currentExp = {
                    employer: employer || 'Professional Role',
                    role: roleStr || 'Engineer',
                    dates: dateDetails.formatted,
                    dateDetails,
                    location: location || 'Auckland, New Zealand',
                    bullets: [],
                    sourceFile: sourceFileName,
                    sourceHash
                };
                experience.push(currentExp);
            }
        } else {
            // Line without date: might be an employer name (e.g. "Neurix Limited Auckland, New Zealand")
            const nextLine = (lines[i + 1] || '').trim();
            const nextHasDate = nextLine.match(DATE_RANGE_REGEX);

            if (nextHasDate) {
                // Definitely an employer header line!
                let employer = trimmed;
                let location = '';
                const locMatch = trimmed.match(/(?:Auckland|Wellington|Christchurch|New Zealand|New Delhi|India)[^|\n]*/i);
                if (locMatch) {
                    location = cleanText(locMatch[0]);
                    employer = cleanText(trimmed.replace(locMatch[0], ''));
                }

                currentExp = {
                    employer: cleanText(employer) || trimmed,
                    role: '',
                    dates: '',
                    dateDetails: null,
                    location: location || 'Auckland, New Zealand',
                    bullets: [],
                    sourceFile: sourceFileName,
                    sourceHash
                };
                experience.push(currentExp);
            }
        }
    }

    pushCurrentBullet();

    // Clean up empty employers or format fields
    return experience.map(exp => ({
        ...exp,
        employer: cleanText(exp.employer),
        role: cleanText(exp.role) || 'Specialist',
        location: cleanText(exp.location) || 'Auckland, New Zealand',
        dates: exp.dates || (exp.dateDetails ? exp.dateDetails.formatted : '')
    }));
}

/**
 * Heuristic parser for Projects section.
 */
function parseProjectsSection(lines, sourceFileName, sourceHash) {
    const projects = [];
    let currentProj = null;
    let currentBullet = '';

    function pushCurrentBullet() {
        if (currentProj && currentBullet.trim()) {
            currentProj.bullets.push({
                text: cleanText(currentBullet),
                sourceFile: sourceFileName,
                sourceHash
            });
            currentBullet = '';
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (isBulletLine(line)) {
            pushCurrentBullet();
            currentBullet = stripBulletMarker(line);
            continue;
        }

        if (currentBullet) {
            // Check if this line is a continuation or a new project title
            // Titles are usually shorter than 65 chars and don't end in period
            if (trimmed.length < 65 && !trimmed.endsWith('.') && isBulletLine(lines[i + 1] || '')) {
                pushCurrentBullet();
                currentProj = {
                    name: cleanText(trimmed),
                    bullets: [],
                    sourceFile: sourceFileName,
                    sourceHash
                };
                projects.push(currentProj);
            } else {
                currentBullet += ' ' + trimmed;
            }
        } else {
            // New project title
            currentProj = {
                name: cleanText(trimmed),
                bullets: [],
                sourceFile: sourceFileName,
                sourceHash
            };
            projects.push(currentProj);
        }
    }

    pushCurrentBullet();
    return projects.filter(p => p.name && (p.bullets.length > 0 || p.name.length > 3));
}

/**
 * Heuristic parser for Education section.
 */
function parseEducationSection(lines, sourceFileName, sourceHash) {
    const education = [];
    let currentEdu = null;
    let currentBullet = '';

    function pushCurrentBullet() {
        if (currentEdu && currentBullet.trim()) {
            currentEdu.bullets.push({
                text: cleanText(currentBullet),
                sourceFile: sourceFileName,
                sourceHash
            });
            currentBullet = '';
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (isBulletLine(line)) {
            pushCurrentBullet();
            currentBullet = stripBulletMarker(line);
            continue;
        }

        const dateMatch = trimmed.match(DATE_RANGE_REGEX);
        const hasDate = !!dateMatch;

        if (currentBullet && !hasDate && trimmed.length > 2) {
            const nextLine = (lines[i + 1] || '').trim();
            const nextHasDate = nextLine.match(DATE_RANGE_REGEX);
            if (!nextHasDate) {
                currentBullet += ' ' + trimmed;
                continue;
            }
        }

        pushCurrentBullet();

        if (hasDate) {
            const dateStr = dateMatch[0];
            const qualStr = cleanText(trimmed.replace(dateStr, ''));
            const dateDetails = normalizeDateRange(dateStr);

            if (currentEdu) {
                currentEdu.degree = qualStr || currentEdu.degree;
                currentEdu.dates = dateDetails.formatted;
                currentEdu.dateDetails = dateDetails;
            } else {
                currentEdu = {
                    institution: 'Higher Education',
                    location: '',
                    degree: qualStr || 'Degree',
                    dates: dateDetails.formatted,
                    dateDetails,
                    bullets: [],
                    sourceFile: sourceFileName,
                    sourceHash
                };
                education.push(currentEdu);
            }
        } else {
            const nextLine = (lines[i + 1] || '').trim();
            const nextHasDate = nextLine.match(DATE_RANGE_REGEX);
            const looksLikeInst = /Institute|University|College|School|Technology|Polytechnic|Academy/i.test(trimmed);

            if (nextHasDate || looksLikeInst) {
                let inst = trimmed;
                let location = '';
                const locMatch = trimmed.match(/(?:Auckland|Wellington|Christchurch|New Zealand|New Delhi|India)[^|\n]*/i);
                if (locMatch) {
                    location = cleanText(locMatch[0]);
                    inst = cleanText(trimmed.replace(locMatch[0], ''));
                }

                currentEdu = {
                    institution: cleanText(inst),
                    location: location || '',
                    degree: '',
                    dates: '',
                    dateDetails: null,
                    bullets: [],
                    sourceFile: sourceFileName,
                    sourceHash
                };
                education.push(currentEdu);
            } else if (currentEdu) {
                if (!currentEdu.degree) {
                    currentEdu.degree = cleanText(trimmed);
                } else {
                    currentEdu.bullets.push({
                        text: cleanText(trimmed),
                        sourceFile: sourceFileName,
                        sourceHash
                    });
                }
            }
        }
    }

    pushCurrentBullet();
    return education.filter(e => e.institution && (e.degree || e.bullets.length > 0));
}

/**
 * Heuristic parser for Volunteer section.
 */
function parseVolunteerSection(lines, sourceFileName, sourceHash) {
    const volunteer = [];
    let currentVol = null;
    let currentBullet = '';

    function pushCurrentBullet() {
        if (currentVol && currentBullet.trim()) {
            currentVol.bullets.push({
                text: cleanText(currentBullet),
                sourceFile: sourceFileName,
                sourceHash
            });
            currentBullet = '';
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (isBulletLine(line)) {
            pushCurrentBullet();
            currentBullet = stripBulletMarker(line);
            continue;
        }

        // Organisation / Role line: e.g. FreeCodeCamp.org — Staff Member
        const isOrgHeader = (trimmed.includes('—') || trimmed.includes(' - ') || trimmed.includes(' – ')) &&
            /FreeCodeCamp|Shoutcoder|Volunteer|Organization|Charity|Community/i.test(trimmed);

        if (isOrgHeader) {
            pushCurrentBullet();
            const dashMatch = trimmed.split(/\s*(?:—| - | – )\s*/);
            const org = cleanText(dashMatch[0]);
            const role = cleanText(dashMatch[1] || 'Volunteer');

            currentVol = {
                organisation: org,
                role,
                bullets: [],
                sourceFile: sourceFileName,
                sourceHash
            };
            volunteer.push(currentVol);
            continue;
        }

        if (currentVol) {
            if (currentBullet) {
                currentBullet += ' ' + trimmed;
            } else {
                currentBullet = trimmed;
            }
        }
    }

    pushCurrentBullet();
    return volunteer;
}

/**
 * Extract structured semantic sections from raw text of a CV.
 *
 * @param {string} rawText - Clean plain text from pdf-parse
 * @param {string} sourceFileName - Originating filename (e.g. "cv_linux_devops.pdf")
 * @param {string} sourceHash - SHA-256 hash of the PDF
 * @returns {object} Extracted structured CV entities
 */
function extractSectionsFromText(rawText, sourceFileName = 'unknown.pdf', sourceHash = '') {
    const contact = extractContactFromText(rawText);
    const sections = partitionSections(rawText);

    // Summary
    let summary = cleanText(sections.summary.join(' '));
    if (!summary && sections.header && sections.header.length > 0) {
        const potentialSummaryLines = sections.header.filter(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.length < 20) return false;
            if (trimmed.includes('@') || trimmed.includes('+64') || trimmed.includes('linkedin') || trimmed.includes('github')) return false;
            if (trimmed === contact.name) return false;
            return true;
        });
        if (potentialSummaryLines.length > 0) {
            summary = cleanText(potentialSummaryLines.join(' '));
        }
    }

    // Skills
    const skills = parseSkillsSection(sections.skills, sourceFileName, sourceHash);

    // Experience
    const experience = parseExperienceSection(sections.experience, sourceFileName, sourceHash);

    // Projects
    const projects = parseProjectsSection(sections.projects, sourceFileName, sourceHash);

    // Volunteer
    const volunteer = parseVolunteerSection(sections.volunteer, sourceFileName, sourceHash);

    // Education
    const education = parseEducationSection(sections.education, sourceFileName, sourceHash);

    // Additional info
    const additional = sections.additional
        .map(stripBulletMarker)
        .map(cleanText)
        .filter(Boolean)
        .map(text => ({ text, sourceFile: sourceFileName, sourceHash }));

    return {
        sourceFile: sourceFileName,
        sourceHash,
        contact,
        summary,
        skills,
        experience,
        projects,
        volunteer,
        education,
        additional
    };
}

/**
 * Parse an individual PDF file into structured CV entities.
 *
 * @param {string} filePath - Absolute path to PDF file
 * @returns {Promise<object>} Structured CV data
 */
async function parseCvPdf(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }
    if (!pdfParse) {
        throw new Error('pdf-parse module is not available');
    }

    const buffer = fs.readFileSync(filePath);
    const sha256 = computeFileHash(buffer);
    const fileName = path.basename(filePath);

    const pdfData = await pdfParse(buffer);
    const rawText = pdfData.text || '';
    const numPages = pdfData.numpages || 0;

    const parsed = extractSectionsFromText(rawText, fileName, sha256);
    return {
        ...parsed,
        numPages,
        rawLength: rawText.length
    };
}

/**
 * Load persistent manifest file (my_cvs/.manifest.json).
 *
 * @param {string} manifestPath
 * @returns {object}
 */
function loadManifest(manifestPath) {
    try {
        if (!fs.existsSync(manifestPath)) {
            return { version: 1, lastUpdated: null, files: {} };
        }
        const raw = fs.readFileSync(manifestPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return { version: 1, lastUpdated: null, files: {} };
    }
}

/**
 * Save persistent manifest file atomically.
 *
 * @param {string} manifestPath
 * @param {object} manifest
 */
function saveManifest(manifestPath, manifest) {
    try {
        const dir = path.dirname(manifestPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        manifest.lastUpdated = new Date().toISOString();
        const tmpPath = `${manifestPath}.tmp.${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
        fs.renameSync(tmpPath, manifestPath);
        return true;
    } catch (err) {
        console.warn(`[cv_parser] Failed to save manifest: ${err.message}`);
        return false;
    }
}

/**
 * Discover, hash, and incrementally parse all PDF files in my_cvs/.
 * Step 2.1: Dynamic PDF Discovery & SHA-256 Hashing
 * Step 2.2: Sectional & Semantic Entity Extractor
 * Step 2.3: Source Traceability & Granular Tagging
 *
 * @param {string} [myCvsDir] - Path to directory containing source CV PDFs
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Force re-parse all PDFs bypassing manifest cache
 * @param {string} [options.manifestPath] - Optional custom path to manifest file
 * @returns {Promise<object>} Summary of parsed CVs and combined entities
 */
async function parseAllCvs(myCvsDir = DEFAULT_MY_CVS_DIR, options = {}) {
    const {
        force = false,
        manifestPath = path.join(myCvsDir, DEFAULT_MANIFEST_NAME)
    } = options;

    if (!fs.existsSync(myCvsDir)) {
        console.warn(`[cv_parser] Directory not found: ${myCvsDir}`);
        return { filesParsed: 0, fromManifest: 0, cvs: [], manifest: {} };
    }

    const pdfFiles = fs.readdirSync(myCvsDir)
        .filter(f => f.toLowerCase().endsWith('.pdf') && !f.startsWith('.'))
        .sort();

    console.log(`[cv_parser] Discovered ${pdfFiles.length} source PDF(s) in ${myCvsDir}: ${pdfFiles.join(', ')}`);

    const manifest = loadManifest(manifestPath);
    if (!manifest.files) manifest.files = {};

    let filesParsed = 0;
    let fromManifest = 0;
    const cvs = [];

    // Track active filenames to detect deletions
    const activeFilesSet = new Set(pdfFiles);

    // Prune deleted files from manifest
    for (const cachedFile of Object.keys(manifest.files)) {
        if (!activeFilesSet.has(cachedFile)) {
            console.log(`[cv_parser] Source CV removed: ${cachedFile} (pruning from manifest)`);
            delete manifest.files[cachedFile];
        }
    }

    for (const file of pdfFiles) {
        const fullPath = path.join(myCvsDir, file);
        const stat = fs.statSync(fullPath);
        const currentHash = computeFileHash(fullPath);
        const cachedEntry = manifest.files[file];

        const isUnchanged = !force && cachedEntry && cachedEntry.sha256 === currentHash && cachedEntry.data;

        if (isUnchanged) {
            fromManifest++;
            cvs.push(cachedEntry.data);
            console.log(`[cv_parser] Loaded ${file} from manifest cache (SHA-256 match: ${currentHash.substring(0, 10)}...)`);
        } else {
            console.log(`[cv_parser] Parsing ${file} (SHA-256: ${currentHash.substring(0, 10)}...)${force ? ' [FORCE]' : ''}...`);
            try {
                const parsed = await parseCvPdf(fullPath);
                manifest.files[file] = {
                    sha256: currentHash,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    parsedAt: new Date().toISOString(),
                    data: parsed
                };
                filesParsed++;
                cvs.push(parsed);
            } catch (err) {
                console.error(`[cv_parser] Failed to parse ${file}: ${err.message}`);
            }
        }
    }

    saveManifest(manifestPath, manifest);

    return {
        totalFiles: pdfFiles.length,
        filesParsed,
        fromManifest,
        cvs,
        manifest
    };
}

// Standalone CLI runner
if (require.main === module) {
    const args = process.argv.slice(2);
    const force = args.includes('--force') || args.includes('-f');
    const dump = args.includes('--dump');

    (async () => {
        try {
            console.log('=== Automated Dynamic CV Pipeline: Multi-CV Parser ===\n');
            const result = await parseAllCvs(DEFAULT_MY_CVS_DIR, { force });

            console.log(`\nParsed: ${result.filesParsed} new/updated | Cached: ${result.fromManifest} from manifest`);
            console.log(`Total CVs active: ${result.cvs.length}\n`);

            for (const cv of result.cvs) {
                console.log(`--- [${cv.sourceFile}] (Pages: ${cv.numPages}, Hash: ${cv.sourceHash.substring(0, 12)}...) ---`);
                console.log(`Candidate: ${cv.contact.name} | ${cv.contact.email} | ${cv.contact.phone}`);
                console.log(`Summary: ${cv.summary.substring(0, 120)}...`);
                console.log(`Employers (${cv.experience.length}):`);
                cv.experience.forEach(e => {
                    console.log(`  - ${e.employer}: ${e.role} (${e.dates}) [${e.bullets.length} bullets]`);
                });
                console.log(`Education (${cv.education.length}):`);
                cv.education.forEach(ed => console.log(`  - ${ed.institution}: ${ed.degree} (${ed.dates})`));
                console.log(`Projects (${cv.projects.length}):`);
                cv.projects.forEach(p => console.log(`  - ${p.name} [${p.bullets.length} bullets]`));
                console.log(`Skills: ${cv.skills.allSkills.length} unique skills across ${Object.keys(cv.skills.categories).length} categories`);
                console.log('');
            }

            if (dump) {
                console.log('--- FULL DUMP ---');
                console.log(JSON.stringify(result.cvs, null, 2));
            }

            console.log('✓ Multi-CV parsing completed successfully.');
        } catch (err) {
            console.error('\n✖ Error running cv_parser:', err);
            process.exit(1);
        }
    })();
}

module.exports = {
    parseCvPdf,
    parseAllCvs,
    extractSectionsFromText,
    computeFileHash,
    loadManifest,
    saveManifest,
    normalizeDateRange,
    cleanText,
    DEFAULT_MY_CVS_DIR,
    DEFAULT_MANIFEST_NAME
};
