/**
 * Notion API Synchronization Module
 *
 * Automatically uploads generated CV & Cover Letter PDFs to Notion via the
 * File Upload API (v1/file_uploads) and creates an entry in the user's job
 * tracking database with metadata (title, company, URL, ATS score, date, etc.).
 *
 * Supports standalone testing:
 *   node notion_sync.js --test
 *   node notion_sync.js --sync-latest
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DATABASE_ID = '26d086ddaa064aa0b51318c8d3e6a84f';
const DEFAULT_NOTION_VERSION = '2026-03-11';
const NOTION_API_BASE = 'https://api.notion.com/v1';

/**
 * Normalizes a Notion 32-character ID into standard UUID format (8-4-4-4-12)
 * or returns it stripped of hyphens depending on needed format.
 */
function normalizeId(id) {
    if (!id) return '';
    const clean = id.replace(/-/g, '').trim();
    if (clean.length === 32) {
        return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
    }
    return id.trim();
}

/**
 * Extracts a Notion ID from a URL or raw ID string.
 * Supports URLs like:
 *   https://app.notion.com/p/26d086ddaa064aa0b51318c8d3e6a84f?v=b1532aba5c004f3ab6622b06e070f8e5
 *   https://www.notion.so/workspace/26d086ddaa064aa0b51318c8d3e6a84f?v=...
 */
function extractNotionId(input) {
    if (!input) return DEFAULT_DATABASE_ID;
    const str = String(input).trim();
    const urlMatch = str.match(/(?:notion\.(?:so|com)\/(?:p\/|[^\/]+\/)?)([a-f0-9]{32})/i);
    if (urlMatch && urlMatch[1]) {
        return urlMatch[1];
    }
    const rawClean = str.split('?')[0].replace(/[^a-f0-9-]/gi, '');
    const stripped = rawClean.replace(/-/g, '');
    if (stripped.length === 32) return stripped;
    return str;
}

/**
 * Helper to build standard Notion API request headers.
 */
function getNotionHeaders(token, extraHeaders = {}) {
    const version = process.env.NOTION_VERSION || DEFAULT_NOTION_VERSION;
    return {
        'Authorization': `Bearer ${token.trim()}`,
        'Notion-Version': version,
        ...extraHeaders,
    };
}

/**
 * Uploads a local file to Notion via the Direct Upload API:
 * 1. POST /v1/file_uploads -> gets upload_url and id
 * 2. POST upload_url (multipart/form-data) -> sends binary stream/blob
 * Returns the file object suitable for database properties:
 * { name: "...", type: "file_upload", file_upload: { id: "..." } }
 */
async function uploadFileToNotion(filePath, token) {
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`File does not exist at path: ${filePath}`);
    }

    const filename = path.basename(filePath);
    const contentType = filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';

    // Step 1: Create the file upload object in Notion
    const createRes = await fetch(`${NOTION_API_BASE}/file_uploads`, {
        method: 'POST',
        headers: getNotionHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            filename,
            content_type: contentType,
        }),
    });

    if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`Notion file_uploads create failed (${createRes.status}): ${errText}`);
    }

    const uploadMeta = await createRes.json();
    const uploadId = uploadMeta.id;
    const uploadUrl = uploadMeta.upload_url || `${NOTION_API_BASE}/file_uploads/${uploadId}/send`;

    // Step 2: Send the binary file data
    const fileBuffer = fs.readFileSync(filePath);
    const fileBlob = new Blob([fileBuffer], { type: contentType });
    const formData = new FormData();
    formData.append('file', fileBlob, filename);

    const sendRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: getNotionHeaders(token), // Note: let fetch set multipart/form-data boundary
        body: formData,
    });

    if (!sendRes.ok) {
        const sendErr = await sendRes.text();
        throw new Error(`Notion send file upload failed (${sendRes.status}): ${sendErr}`);
    }

    return {
        name: filename,
        type: 'file_upload',
        file_upload: {
            id: uploadId,
        },
    };
}

/**
 * Resolves whether the target ID is a Database directly, or a Page containing
 * a child database. Returns { databaseId, title, properties }.
 */
async function resolveDatabase(targetInput, token) {
    const rawId = extractNotionId(targetInput);
    const formattedId = normalizeId(rawId);

    // Attempt 1: Fetch as Database
    const dbRes = await fetch(`${NOTION_API_BASE}/databases/${formattedId}`, {
        method: 'GET',
        headers: getNotionHeaders(token),
    });

    if (dbRes.ok) {
        const dbData = await dbRes.json();
        const title = Array.isArray(dbData.title) ? dbData.title.map(t => t.plain_text).join('') : 'Job Applications';
        let properties = dbData.properties || {};

        // In Notion API 2026-03-11+, database properties live in data_sources or can be fetched via 2022-06-28
        if (Object.keys(properties).length === 0) {
            if (dbData.data_sources && dbData.data_sources[0] && dbData.data_sources[0].id) {
                try {
                    const dsRes = await fetch(`${NOTION_API_BASE}/data_sources/${dbData.data_sources[0].id}`, {
                        headers: getNotionHeaders(token),
                    });
                    if (dsRes.ok) {
                        const dsData = await dsRes.json();
                        properties = dsData.properties || {};
                    }
                } catch (_) {}
            }
            if (Object.keys(properties).length === 0) {
                try {
                    const legacyRes = await fetch(`${NOTION_API_BASE}/databases/${formattedId}`, {
                        headers: getNotionHeaders(token, { 'Notion-Version': '2022-06-28' }),
                    });
                    if (legacyRes.ok) {
                        const legacyData = await legacyRes.json();
                        properties = legacyData.properties || {};
                    }
                } catch (_) {}
            }
        }

        return {
            databaseId: dbData.id,
            title,
            properties,
            isPageChild: false,
        };
    }

    const dbErrText = await dbRes.text();

    // If 404 or validation error, check if this ID is a Page that contains a database
    const pageRes = await fetch(`${NOTION_API_BASE}/pages/${formattedId}`, {
        method: 'GET',
        headers: getNotionHeaders(token),
    });

    if (pageRes.ok) {
        const pageData = await pageRes.json();
        // Check blocks inside this page to find an inline child database
        const blocksRes = await fetch(`${NOTION_API_BASE}/blocks/${formattedId}/children?page_size=50`, {
            method: 'GET',
            headers: getNotionHeaders(token),
        });

        if (blocksRes.ok) {
            const blocksData = await blocksRes.json();
            const childDb = (blocksData.results || []).find(b => b.type === 'child_database');
            if (childDb) {
                // Found child database! Fetch its schema
                return resolveDatabase(childDb.id, token);
            }
        }

        // Fallback: it's a regular page, we can create child pages under it
        return {
            databaseId: null,
            parentPageId: pageData.id,
            title: 'Notion Page Parent',
            properties: {},
            isPageChild: true,
        };
    }

    // If both failed, provide a helpful diagnostic
    if (dbRes.status === 404) {
        throw new Error(
            `Notion target ${formattedId} was not found (HTTP 404).\n` +
            `Make sure you have shared your database/page with your Notion Integration!\n` +
            `In Notion: Open the database page -> click '...' (top right) -> 'Connect to' -> select your integration.`
        );
    }

    throw new Error(`Failed to resolve Notion database (${dbRes.status}): ${dbErrText}`);
}

/**
 * Helper to split text into chunks suitable for Notion blocks (≤ 2000 chars each).
 */
function chunkText(text, maxLen = 1900) {
    if (!text) return [];
    const str = String(text).trim();
    if (str.length <= maxLen) return [str];

    const chunks = [];
    let remaining = str;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }
        let splitIdx = remaining.lastIndexOf('\n', maxLen);
        if (splitIdx < 200) splitIdx = remaining.lastIndexOf(' ', maxLen);
        if (splitIdx < 200) splitIdx = maxLen;
        chunks.push(remaining.slice(0, splitIdx).trim());
        remaining = remaining.slice(splitIdx).trim();
    }
    return chunks;
}

/**
 * Builds dynamic Notion page properties matching whatever columns exist
 * in the user's database schema.
 */
function buildDatabaseProperties(schemaProperties, jobData, uploadedFiles = {}) {
    const props = {};
    const { jobTitle, companyName, jobLink, score, dateApplied } = jobData;
    const { cvFile, clFile } = uploadedFiles;

    const propEntries = Object.entries(schemaProperties || {});

    // 1. Title property (Required by Notion databases: exactly one property has type 'title')
    const titleEntry = propEntries.find(([_, p]) => p.type === 'title');
    if (titleEntry) {
        const [titleKey] = titleEntry;
        let displayTitle = '';
        if (/company|employer/i.test(titleKey)) {
            displayTitle = companyName || jobTitle || 'Job Application';
        } else if (/role|position|job/i.test(titleKey)) {
            displayTitle = jobTitle || companyName || 'Job Application';
        } else {
            displayTitle = jobTitle && companyName
                ? `${jobTitle} — ${companyName}`
                : (jobTitle || companyName || 'Job Application');
        }
        props[titleKey] = {
            title: [{ type: 'text', text: { content: displayTitle.slice(0, 200) } }],
        };
    }

    // Helper: find property by name regex
    function findProp(pattern, typeFilter = null) {
        return propEntries.find(([name, p]) => {
            const matchesName = pattern.test(name.trim());
            const matchesType = typeFilter ? p.type === typeFilter : true;
            return matchesName && matchesType;
        });
    }

    // 2. Company property (if separate from title)
    const companyEntry = findProp(/company|employer|organization|organisation/i);
    if (companyEntry && companyEntry !== titleEntry && companyName) {
        const [key, meta] = companyEntry;
        if (meta.type === 'rich_text') {
            props[key] = { rich_text: [{ type: 'text', text: { content: companyName.slice(0, 200) } }] };
        } else if (meta.type === 'select') {
            props[key] = { select: { name: companyName.slice(0, 100).replace(/,/g, '') } };
        }
    }

    // 3. Job Title / Position (if separate from title)
    const roleEntry = findProp(/position|role|job title|designation/i);
    if (roleEntry && roleEntry !== titleEntry && jobTitle) {
        const [key, meta] = roleEntry;
        if (meta.type === 'rich_text') {
            props[key] = { rich_text: [{ type: 'text', text: { content: jobTitle.slice(0, 200) } }] };
        } else if (meta.type === 'select') {
            props[key] = { select: { name: jobTitle.slice(0, 100).replace(/,/g, '') } };
        }
    }

    // 4. Job Link / URL
    const urlEntry = findProp(/link|url|job link|job url|posting|career|source/i) || propEntries.find(([_, p]) => p.type === 'url');
    if (urlEntry && jobLink) {
        const [key, meta] = urlEntry;
        if (meta.type === 'url') {
            props[key] = { url: jobLink };
        } else if (meta.type === 'rich_text') {
            props[key] = { rich_text: [{ type: 'text', text: { content: jobLink, link: { url: jobLink } } }] };
        }
    }

    // 5. ATS Score
    const scoreEntry = findProp(/ats|score|match|ats score|fit/i);
    if (scoreEntry && score != null) {
        const [key, meta] = scoreEntry;
        const numScore = typeof score === 'number' ? Math.round(score) : parseInt(score, 10);
        if (meta.type === 'number') {
            props[key] = { number: isNaN(numScore) ? null : numScore };
        } else if (meta.type === 'rich_text') {
            props[key] = { rich_text: [{ type: 'text', text: { content: `${score}%` } }] };
        }
    }

    // 6. Date Applied
    const dateEntry = findProp(/date applied|applied date/i, 'date') || findProp(/^date$/i, 'date') || findProp(/\bdate\b/i, 'date') || propEntries.find(([_, p]) => p.type === 'date');
    if (dateEntry) {
        const [key] = dateEntry;
        const todayStr = (dateApplied || new Date().toISOString()).split('T')[0];
        props[key] = { date: { start: todayStr } };
    }

    // 6b. Follow-up Date (default: 7 days after application)
    const followUpEntry = findProp(/follow-up|follow up/i, 'date');
    if (followUpEntry && followUpEntry !== dateEntry) {
        const [key] = followUpEntry;
        const followUpDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        props[key] = { date: { start: followUpDate } };
    }

    // 7. Status (strictly match 'Status' to avoid 'Interview Stage')
    const statusEntry = findProp(/^status$/i) || findProp(/\bapplication status\b/i) || findProp(/\bstatus\b/i);
    if (statusEntry) {
        const [key, meta] = statusEntry;
        if (meta.type === 'status') {
            const options = meta.status?.options || [];
            const appliedOpt = options.find(o => /applied|submitted|done/i.test(o.name)) || options[0];
            if (appliedOpt) props[key] = { status: { name: appliedOpt.name } };
        } else if (meta.type === 'select') {
            props[key] = { select: { name: 'Applied' } };
        }
    }

    // 7b. Contact (recruiter / contact email from JD)
    const contactEntry = findProp(/contact|email|recruiter|hr/i, 'rich_text');
    if (contactEntry) {
        const emailMatch = (jobData.jobDescription || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
            props[contactEntry[0]] = { rich_text: [{ type: 'text', text: { content: emailMatch[0] } }] };
        }
    }

    // 7c. Salary Range (if mentioned in JD)
    const salaryEntry = findProp(/salary|remuneration|compensation|rate/i, 'rich_text');
    if (salaryEntry) {
        const salMatch = (jobData.jobDescription || '').match(/(?:NZD?|[\$£€])\s?[0-9]{2,3}(?:,[0-9]{3})*(?:\s?[-–—to]\s?(?:NZD?|[\$£€])?\s?[0-9]{2,3}(?:,[0-9]{3})*)?(?:\s?(?:per\s+(?:annum|year|hour|hr)|p\.a\.|k\b))/i);
        if (salMatch) {
            props[salaryEntry[0]] = { rich_text: [{ type: 'text', text: { content: salMatch[0].trim() } }] };
        }
    }

    // 8. Files (CV and Cover Letter)
    const fileEntries = propEntries.filter(([_, p]) => p.type === 'files');
    const cvProp = fileEntries.find(([name]) => /cv|resume/i.test(name));
    const clProp = fileEntries.find(([name]) => /cover|letter|^cl$/i.test(name));

    if (cvProp && clProp) {
        if (cvFile) props[cvProp[0]] = { files: [cvFile] };
        if (clFile) props[clProp[0]] = { files: [clFile] };
    } else if (cvProp && !clProp) {
        // If CV is the only files property, attach BOTH CV and CL into it so CL is never lost
        const attached = [cvFile, clFile].filter(Boolean);
        if (attached.length > 0) {
            props[cvProp[0]] = { files: attached };
        }
    } else if (fileEntries.length === 1) {
        const attached = [cvFile, clFile].filter(Boolean);
        if (attached.length > 0) {
            props[fileEntries[0][0]] = { files: attached };
        }
    } else if (fileEntries.length > 1) {
        if (cvFile && fileEntries[0]) props[fileEntries[0][0]] = { files: [cvFile] };
        if (clFile && fileEntries[1]) props[fileEntries[1][0]] = { files: [clFile] };
    }

    // If CL property exists as type url (instead of files), provide jobLink or URL
    const clUrlEntry = propEntries.find(([name, p]) => /cover|letter|^cl$/i.test(name) && p.type === 'url');
    if (clUrlEntry && jobLink) {
        props[clUrlEntry[0]] = { url: jobLink };
    }

    return props;
}

/**
 * Builds rich block children for the page body:
 * - Summary callout
 * - Cover Letter section
 * - ATS Analysis section
 * - Scraped Job Description
 * - Tailored CV Markdown
 */
function buildPageBlocks(jobData, atsData, uploadedFiles = {}) {
    const blocks = [];
    const { jobTitle, companyName, jobLink, score, coverLetterMarkdown, jobDescription, cvMarkdown } = jobData;

    // Summary Callout
    blocks.push({
        object: 'block',
        type: 'callout',
        callout: {
            rich_text: [
                {
                    type: 'text',
                    text: {
                        content: `🎯 ATS Match: ${score != null ? `${score}%` : 'N/A'}\n` +
                            `🏢 Company: ${companyName || 'N/A'}\n` +
                            `💼 Role: ${jobTitle || 'N/A'}\n` +
                            `📅 Processed: ${new Date().toLocaleString()}`,
                    },
                },
            ],
            icon: { type: 'emoji', emoji: score && score >= 85 ? '✅' : '📄' },
            color: 'blue_background',
        },
    });

    if (jobLink) {
        blocks.push({
            object: 'block',
            type: 'paragraph',
            paragraph: {
                rich_text: [
                    { type: 'text', text: { content: '🔗 Original Posting: ' } },
                    { type: 'text', text: { content: jobLink, link: { url: jobLink } } },
                ],
            },
        });
    }

    blocks.push({ object: 'block', type: 'divider', divider: {} });

    // Cover Letter Section
    if (coverLetterMarkdown || uploadedFiles.clFile) {
        blocks.push({
            object: 'block',
            type: 'heading_2',
            heading_2: {
                rich_text: [{ type: 'text', text: { content: '✉️ Generated Cover Letter' } }],
            },
        });

        if (uploadedFiles.clFile && uploadedFiles.clFile.file_upload) {
            blocks.push({
                object: 'block',
                type: 'file',
                file: {
                    type: 'file_upload',
                    file_upload: { id: uploadedFiles.clFile.file_upload.id },
                },
            });
        }

        const clParagraphs = coverLetterMarkdown
            .split(/\n\s*\n/)
            .map(p => p.trim())
            .filter(Boolean);

        for (const p of clParagraphs.slice(0, 10)) {
            const chunks = chunkText(p, 1900);
            for (const chunk of chunks) {
                blocks.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: chunk } }],
                    },
                });
            }
        }

        blocks.push({ object: 'block', type: 'divider', divider: {} });
    }

    // ATS Analysis Section
    if (atsData && (atsData.overall_score || atsData.score != null || atsData.missing_keywords || atsData.keywords)) {
        blocks.push({
            object: 'block',
            type: 'heading_2',
            heading_2: {
                rich_text: [{ type: 'text', text: { content: '📊 ATS Keyword & Gap Analysis' } }],
            },
        });

        let missingList = [];
        if (Array.isArray(atsData.missing_keywords)) {
            missingList = atsData.missing_keywords.map(k => typeof k === 'object' ? (k.keyword || k.name || JSON.stringify(k)) : k);
        } else if (Array.isArray(atsData.keywords)) {
            missingList = atsData.keywords.filter(k => k.status === 'Missing').map(k => k.keyword);
        } else if (typeof atsData.missing_keywords === 'string') {
            missingList = [atsData.missing_keywords];
        }
        const missingStr = missingList.slice(0, 25).filter(Boolean).join(', ') || 'None detected';

        blocks.push({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: {
                rich_text: [
                    { type: 'text', text: { content: 'Missing / Target Keywords: ' }, annotations: { bold: true } },
                    { type: 'text', text: { content: missingStr.slice(0, 1500) } },
                ],
            },
        });

        if (atsData.recommendations && Array.isArray(atsData.recommendations)) {
            for (const rec of atsData.recommendations.slice(0, 4)) {
                const recText = typeof rec === 'object'
                    ? (rec.title ? `${rec.title}: ${rec.description || ''}` : (rec.description || rec.action_suggestion || JSON.stringify(rec)))
                    : String(rec);
                blocks.push({
                    object: 'block',
                    type: 'bulleted_list_item',
                    bulleted_list_item: {
                        rich_text: [{ type: 'text', text: { content: recText.slice(0, 1800) } }],
                    },
                });
            }
        }

        blocks.push({ object: 'block', type: 'divider', divider: {} });
    }

    // Job Description Section
    if (jobDescription) {
        blocks.push({
            object: 'block',
            type: 'heading_2',
            heading_2: {
                rich_text: [{ type: 'text', text: { content: '📋 Scraped Job Description' } }],
            },
        });

        const jdParagraphs = jobDescription
            .split(/\n\s*\n/)
            .map(p => p.trim())
            .filter(Boolean);

        for (const p of jdParagraphs.slice(0, 8)) {
            const chunks = chunkText(p, 1900);
            for (const chunk of chunks) {
                blocks.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: chunk } }],
                    },
                });
            }
        }

        blocks.push({ object: 'block', type: 'divider', divider: {} });
    }

    // Tailored CV Section
    if (cvMarkdown || uploadedFiles.cvFile) {
        blocks.push({
            object: 'block',
            type: 'heading_2',
            heading_2: {
                rich_text: [{ type: 'text', text: { content: '📝 Tailored CV' } }],
            },
        });

        if (uploadedFiles.cvFile && uploadedFiles.cvFile.file_upload) {
            blocks.push({
                object: 'block',
                type: 'file',
                file: {
                    type: 'file_upload',
                    file_upload: { id: uploadedFiles.cvFile.file_upload.id },
                },
            });
        }

        if (cvMarkdown) {
            const cvChunks = chunkText(cvMarkdown, 1900);
            for (const chunk of cvChunks.slice(0, 8)) {
                blocks.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: chunk } }],
                    },
                });
            }
        }
    }

    return blocks.slice(0, 95);
}

/**
 * Main function to sync a completed job application to Notion:
 * - Checks credentials
 * - Resolves database
 * - Uploads CV and Cover Letter PDFs
 * - Constructs mapped database properties
 * - Creates page with rich child blocks
 */
async function syncJobToNotion(jobData = {}, options = {}) {
    const token = options.token || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
    if (!token) {
        return {
            success: false,
            skipped: true,
            reason: 'NOTION_API_KEY (or NOTION_TOKEN) is not set in environment or .env.',
        };
    }

    const targetDatabase = options.databaseId || process.env.NOTION_DATABASE_ID || DEFAULT_DATABASE_ID;

    console.log(`[notion_sync] Resolving Notion database: ${targetDatabase}...`);
    const dbInfo = await resolveDatabase(targetDatabase, token);

    // Upload files if present
    const uploadedFiles = {};
    if (jobData.cvPdfPath && fs.existsSync(jobData.cvPdfPath)) {
        try {
            console.log(`[notion_sync] Uploading CV PDF to Notion: ${path.basename(jobData.cvPdfPath)}...`);
            uploadedFiles.cvFile = await uploadFileToNotion(jobData.cvPdfPath, token);
            console.log(`[notion_sync] CV PDF uploaded successfully (ID: ${uploadedFiles.cvFile.file_upload.id})`);
        } catch (err) {
            console.warn(`[notion_sync] Warning: Failed to upload CV PDF to Notion: ${err.message}`);
        }
    }

    if (jobData.clPdfPath && fs.existsSync(jobData.clPdfPath)) {
        try {
            console.log(`[notion_sync] Uploading Cover Letter PDF to Notion: ${path.basename(jobData.clPdfPath)}...`);
            uploadedFiles.clFile = await uploadFileToNotion(jobData.clPdfPath, token);
            console.log(`[notion_sync] Cover Letter PDF uploaded successfully (ID: ${uploadedFiles.clFile.file_upload.id})`);
        } catch (err) {
            console.warn(`[notion_sync] Warning: Failed to upload Cover Letter PDF to Notion: ${err.message}`);
        }
    }

    // Load ATS analysis JSON if available in output dir
    let atsData = null;
    if (jobData.outputDir) {
        try {
            const atsPath = path.join(jobData.outputDir, 'ats_analysis.json');
            if (fs.existsSync(atsPath)) {
                atsData = JSON.parse(fs.readFileSync(atsPath, 'utf8'));
            }
        } catch (_) {}
    }

    // Build payload
    let pagePayload;
    if (dbInfo.databaseId) {
        const properties = buildDatabaseProperties(dbInfo.properties, jobData, uploadedFiles);
        const children = buildPageBlocks(jobData, atsData, uploadedFiles);
        pagePayload = {
            parent: { database_id: dbInfo.databaseId },
            properties,
            children,
        };
    } else {
        // Parent is a page
        const children = buildPageBlocks(jobData, atsData, uploadedFiles);
        pagePayload = {
            parent: { page_id: dbInfo.parentPageId },
            properties: {
                title: [{ type: 'text', text: { content: `${jobData.jobTitle || 'Job Application'} — ${jobData.companyName || ''}`.trim() } }],
            },
            children,
        };
    }

    console.log(`[notion_sync] Creating page in Notion database...`);
    const createPageRes = await fetch(`${NOTION_API_BASE}/pages`, {
        method: 'POST',
        headers: getNotionHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(pagePayload),
    });

    if (!createPageRes.ok) {
        const errBody = await createPageRes.text();
        throw new Error(`Failed to create page in Notion (${createPageRes.status}): ${errBody}`);
    }

    const createdPage = await createPageRes.json();
    const pageUrl = createdPage.url || `https://notion.so/${(createdPage.id || '').replace(/-/g, '')}`;

    console.log(`[notion_sync] ✅ Successfully created Notion record: ${pageUrl}`);

    return {
        success: true,
        pageId: createdPage.id,
        pageUrl,
        uploadedCV: !!uploadedFiles.cvFile,
        uploadedCL: !!uploadedFiles.clFile,
    };
}

/**
 * CLI Test & Utility
 */
if (require.main === module) {
    (async () => {
        // Load .env
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
                process.env[k] = v;
            }
        }

        const args = process.argv.slice(2);
        const token = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
        const targetDb = process.env.NOTION_DATABASE_ID || DEFAULT_DATABASE_ID;

        console.log('='.repeat(60));
        console.log('Notion Synchronization Module Diagnostic');
        console.log('='.repeat(60));
        console.log(`Target Database ID / URL: ${targetDb}`);
        console.log(`Notion Token Configured:  ${token ? `Yes (${token.slice(0, 6)}...${token.slice(-4)})` : 'No (NOTION_API_KEY not set)'}`);
        console.log(`Notion Version:           ${process.env.NOTION_VERSION || DEFAULT_NOTION_VERSION}`);
        console.log('='.repeat(60));

        if (!token) {
            console.log('\n[INFO] NOTION_API_KEY is not configured.');
            console.log('To set up Notion integration:');
            console.log('1. Go to https://www.notion.so/profile/integrations and create a new integration.');
            console.log('2. Add NOTION_API_KEY=ntn_... in your .env file.');
            console.log('3. Open your database: https://app.notion.com/p/' + DEFAULT_DATABASE_ID);
            console.log('   Click "..." -> "Connect to" -> select your integration name.');
            console.log('4. Run "node notion_sync.js --test" to verify the connection.\n');
            process.exit(0);
        }

        try {
            console.log('\n[1/2] Connecting to Notion and inspecting database schema...');
            const dbInfo = await resolveDatabase(targetDb, token);
            console.log(`Database found: "${dbInfo.title}" (ID: ${dbInfo.databaseId || dbInfo.parentPageId})`);
            console.log('Available columns/properties:');
            for (const [name, p] of Object.entries(dbInfo.properties)) {
                console.log(`  - "${name}": ${p.type}`);
            }

            if (args.includes('--sync-latest')) {
                console.log('\n[2/2] Syncing latest output files to Notion...');
                const outputDir = path.join(__dirname, 'output');
                const metaPath = path.join(outputDir, 'job_meta.json');
                const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
                const atsResultPath = path.join(outputDir, 'ats_result.json');
                const atsResult = fs.existsSync(atsResultPath) ? JSON.parse(fs.readFileSync(atsResultPath, 'utf8')) : {};

                // Look for latest PDF files in output sorted by modification time (newest first)
                let cvPdf = null;
                let clPdf = null;
                if (fs.existsSync(outputDir)) {
                    const sortedPdfFiles = fs.readdirSync(outputDir)
                        .filter(f => f.toLowerCase().endsWith('.pdf') && !f.startsWith('_'))
                        .map(f => {
                            try {
                                const stat = fs.statSync(path.join(outputDir, f));
                                return { name: f, mtime: stat.mtimeMs };
                            } catch (_) {
                                return null;
                            }
                        })
                        .filter(Boolean)
                        .sort((a, b) => b.mtime - a.mtime);

                    // If meta has company name, try matching company first
                    const safeCompany = meta.companyName ? meta.companyName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
                    if (safeCompany && safeCompany !== 'company' && safeCompany !== 'testcompany') {
                        const matchedCv = sortedPdfFiles.find(f => f.name.toLowerCase().includes(safeCompany) && f.name.toLowerCase().includes('cv'));
                        if (matchedCv) cvPdf = matchedCv.name;
                        const matchedCl = sortedPdfFiles.find(f => f.name.toLowerCase().includes(safeCompany) && (f.name.toLowerCase().includes('cl') || f.name.toLowerCase().includes('cover')));
                        if (matchedCl) clPdf = matchedCl.name;
                    }

                    if (!cvPdf) {
                        const latestCv = sortedPdfFiles.find(f => f.name.endsWith('_CV.pdf'));
                        cvPdf = latestCv ? latestCv.name : (fs.existsSync(path.join(outputDir, 'Optimized_CV.pdf')) ? 'Optimized_CV.pdf' : null);
                    }
                    if (!clPdf) {
                        const latestCl = sortedPdfFiles.find(f => f.name.endsWith('_CL.pdf'));
                        clPdf = latestCl ? latestCl.name : (fs.existsSync(path.join(outputDir, 'Cover_Letter.pdf')) ? 'Cover_Letter.pdf' : null);
                    }
                }

                const cvMdPath = path.join(outputDir, 'optimized_cv.md');
                const clMdPath = path.join(outputDir, 'cover_letter.md');
                const jdPath = path.join(outputDir, 'job_description.txt');

                const jobData = {
                    jobTitle: meta.jobTitle || 'Test Role',
                    companyName: meta.companyName || 'Test Company',
                    jobLink: meta.link || 'https://example.com',
                    score: atsResult.score != null ? atsResult.score : 85,
                    cvPdfPath: cvPdf ? path.join(outputDir, cvPdf) : null,
                    clPdfPath: clPdf ? path.join(outputDir, clPdf) : null,
                    cvMarkdown: fs.existsSync(cvMdPath) ? fs.readFileSync(cvMdPath, 'utf8') : '',
                    coverLetterMarkdown: fs.existsSync(clMdPath) ? fs.readFileSync(clMdPath, 'utf8') : '',
                    jobDescription: fs.existsSync(jdPath) ? fs.readFileSync(jdPath, 'utf8') : '',
                    outputDir,
                };

                const res = await syncJobToNotion(jobData, { token, databaseId: targetDb });
                console.log('\nResult:', res);

                if (res && res.success && process.env.CLEANUP_OUTPUT_AFTER_NOTION_SYNC !== 'false') {
                    console.log('\n[3/3] Cleaning up uploaded workflow files from output directory...');
                    const prefixes = [];
                    if (cvPdf) prefixes.push(cvPdf.replace(/\.pdf$/i, ''));
                    if (clPdf) prefixes.push(clPdf.replace(/\.pdf$/i, ''));
                    const cleaned = cleanupOutputFiles(outputDir, [jobData.cvPdfPath, jobData.clPdfPath], prefixes);
                    console.log(`Successfully cleaned up ${cleaned.length} file(s) from output/:`);
                    for (const f of cleaned) {
                        console.log(`  - Deleted: ${path.basename(f)}`);
                    }
                }
            } else if (args.includes('--clean-output') || args.includes('--cleanup-output')) {
                const outputDir = path.join(__dirname, 'output');
                console.log(`\nCleaning all workflow files in ${outputDir}...`);
                if (fs.existsSync(outputDir)) {
                    const files = fs.readdirSync(outputDir);
                    let count = 0;
                    for (const file of files) {
                        const fp = path.join(outputDir, file);
                        try {
                            fs.unlinkSync(fp);
                            console.log(`  - Deleted: ${file}`);
                            count++;
                        } catch (e) {
                            console.warn(`  - Failed to delete ${file}: ${e.message}`);
                        }
                    }
                    console.log(`\nDeleted ${count} file(s) from output/`);
                }
                process.exit(0);
            } else {
                console.log('\n[SUCCESS] Connection verified! The database is ready.');
                console.log('To sync existing output to Notion, run: node notion_sync.js --sync-latest');
            }
        } catch (err) {
            console.error('\n[ERROR] Notion test failed:', err.message);
            process.exit(1);
        }
    })();
}

/**
 * Deletes generated workflow files from the output directory after successful Notion upload.
 * Only removes files that are safely verified to reside within the output directory.
 */
function cleanupOutputFiles(outputDir, targetFiles = [], prefixes = []) {
    if (!outputDir || !fs.existsSync(outputDir)) return [];

    const resolvedOutputDir = path.resolve(outputDir);
    const toDelete = new Set();

    for (const f of targetFiles) {
        if (f) toDelete.add(path.resolve(f));
    }

    const standardFiles = [
        'job_description.txt',
        'job_meta.json',
        'merged_cvs_source.txt',
        'optimized_cv.md',
        'cover_letter.md',
        'Optimized_CV.pdf',
        'Cover_Letter.pdf',
        'ats_result.json',
        'ats_analysis.json',
    ];
    for (const sf of standardFiles) {
        toDelete.add(path.resolve(path.join(resolvedOutputDir, sf)));
    }

    if (prefixes && prefixes.length > 0) {
        try {
            const existing = fs.readdirSync(resolvedOutputDir);
            for (const file of existing) {
                for (const pfx of prefixes) {
                    if (pfx && file.startsWith(pfx)) {
                        toDelete.add(path.resolve(path.join(resolvedOutputDir, file)));
                    }
                }
            }
        } catch (_) {}
    }

    const cleaned = [];
    for (const targetPath of toDelete) {
        try {
            if (fs.existsSync(targetPath)) {
                // Safety: ensure targetPath is strictly inside resolvedOutputDir
                const rel = path.relative(resolvedOutputDir, targetPath);
                if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                    fs.unlinkSync(targetPath);
                    cleaned.push(targetPath);
                }
            }
        } catch (_) {}
    }

    return cleaned;
}

module.exports = {
    syncJobToNotion,
    uploadFileToNotion,
    resolveDatabase,
    buildDatabaseProperties,
    buildPageBlocks,
    normalizeId,
    extractNotionId,
    cleanupOutputFiles,
    DEFAULT_DATABASE_ID,
};
