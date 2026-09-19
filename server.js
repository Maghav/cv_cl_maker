/**
 * Job Application Pipeline — HTTP server
 *
 * Serves the job_application_form.html UI and exposes:
 *  POST /api/start-pipeline  — start pipeline from form / API
 *  GET  /api/pipeline-status/:id — poll status
 *  GET  /api/output-files, /api/cvs, /api/download/:file
 *
 * Paths are resolved relative to this file, NOT a nested workspace/.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load .env if present
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
            process.env[k] = v;
        }
    }
} catch (_) {}

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// FIXED: workspace is this directory itself, not a nested folder
const WORKSPACE_ROOT = __dirname;
const MY_CVS_DIR = path.join(WORKSPACE_ROOT, 'my_cvs');
const OUTPUT_DIR = path.join(WORKSPACE_ROOT, 'output');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// In-memory job store (survives until server restart)
const jobs = new Map(); // workflowId -> { status, jobLink, startedAt, log, result, error, outputFiles }

// Serve static files (form, outputs if needed)
app.use(express.static(WORKSPACE_ROOT));

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Serve form at /
app.get('/', (req, res) => {
    const formPath = path.join(WORKSPACE_ROOT, 'job_application_form.html');
    if (fs.existsSync(formPath)) return res.sendFile(formPath);
    return res.status(404).send('job_application_form.html not found');
});

// ---------------------------------------------------------------------------
// Pipeline starter (shared by form + direct API)
// ---------------------------------------------------------------------------
function startPipeline(jobLink, llmOverrides = {}, extraEnv = {}) {
    const workflowId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const env = {
        ...process.env,
        ...extraEnv,
        // Allow per-request LLM overrides
        ...(llmOverrides.llmApiKey ? { LLM_API_KEY: llmOverrides.llmApiKey } : {}),
        ...(llmOverrides.llmModel ? { LLM_MODEL: llmOverrides.llmModel } : {}),
        ...(llmOverrides.llmBaseUrl ? { LLM_BASE_URL: llmOverrides.llmBaseUrl } : {}),
    };

    // Validate CVs exist
    const cvFiles = fs.existsSync(MY_CVS_DIR) ? fs.readdirSync(MY_CVS_DIR).filter(f => f.toLowerCase().endsWith('.pdf')) : [];
    if (cvFiles.length === 0) {
        return { error: 'No CV PDFs found in my_cvs/. Add 2-3 PDFs there first.', workflowId: null };
    }

    const job = { status: 'running', jobLink, startedAt: new Date().toISOString(), log: '', error: null, result: null, outputFiles: [] };
    jobs.set(workflowId, job);

    // Spawn pipeline as child process (so server stays responsive)
    // run_pipeline.js lives in same directory
    const args = [path.join(WORKSPACE_ROOT, 'run_pipeline.js'), jobLink];
    if (llmOverrides.llmApiKey) args.push(llmOverrides.llmApiKey);
    if (llmOverrides.llmModel) args.push(llmOverrides.llmModel);
    if (llmOverrides.llmBaseUrl) args.push(llmOverrides.llmBaseUrl);

    const child = spawn('node', args, { cwd: WORKSPACE_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); job.log += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); job.log += d.toString(); });

    child.on('close', code => {
        if (code === 0) {
            job.status = 'completed';
            // Try to parse pipeline result JSON from stdout
            try {
                const match = stdout.match(/\{[\s\S]*"success":\s*true[\s\S]*\}/);
                if (match) {
                    const parsed = JSON.parse(match[0]);
                    job.result = parsed;
                    if (parsed.atsScore != null) job.atsScore = parsed.atsScore;
                    if (parsed.notionResult) job.notionResult = parsed.notionResult;
                    if (parsed.cleanedUpFiles) job.cleanedUpFiles = parsed.cleanedUpFiles;
                }
            } catch (_) {}
            // Fallback: Try to read ats_result.json for score if not in stdout
            if (!job.result || (job.result.atsScore == null && job.result.score == null)) {
                try {
                    const atsPath = path.join(OUTPUT_DIR, 'ats_result.json');
                    if (fs.existsSync(atsPath)) job.result = JSON.parse(fs.readFileSync(atsPath, 'utf8'));
                } catch (_) {}
            }
            try {
                job.outputFiles = fs.existsSync(OUTPUT_DIR) ? fs.readdirSync(OUTPUT_DIR) : [];
            } catch (_) {}
            console.log(`[server] Pipeline ${workflowId} completed`);
        } else {
            job.status = 'failed';
            job.error = stderr.slice(-2000) || `Pipeline exited with code ${code}`;
            console.error(`[server] Pipeline ${workflowId} failed code=${code}`, stderr.slice(-1000));
        }
    });

    child.on('error', err => {
        job.status = 'failed';
        job.error = err.message;
        console.error(`[server] Pipeline ${workflowId} spawn error`, err);
    });

    return { workflowId, error: null };
}

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------
app.post('/api/start-pipeline', (req, res) => {
    const { jobLink, llmApiKey, llmModel, llmBaseUrl } = req.body || {};
    if (!jobLink || typeof jobLink !== 'string' || !jobLink.trim()) {
        return res.status(400).json({ success: false, error: 'jobLink is required' });
    }
    try { new URL(jobLink); } catch { return res.status(400).json({ success: false, error: 'Invalid URL' }); }

    const { workflowId, error } = startPipeline(jobLink.trim(), { llmApiKey, llmModel, llmBaseUrl });
    if (error) return res.status(400).json({ success: false, error });

    res.json({ success: true, workflowId, jobLink: jobLink.trim(), estimatedTime: '2-5 minutes', message: 'Pipeline started' });
});

app.get('/api/pipeline-status/:workflowId', (req, res) => {
    const job = jobs.get(req.params.workflowId);
    if (!job) {
        // Fallback: check output dir for completed files (server may have restarted)
        const files = fs.existsSync(OUTPUT_DIR) ? fs.readdirSync(OUTPUT_DIR).filter(f => !f.startsWith('.')) : [];
        let atsScore = null;
        try { const j = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'ats_result.json'), 'utf8')); atsScore = j.score; } catch (_) {}
        return res.json({ workflowId: req.params.workflowId, status: files.length ? 'completed' : 'not_found', outputFiles: files, atsScore });
    }
    let atsScore = (job.result && (job.result.atsScore != null ? job.result.atsScore : job.result.score)) ?? job.atsScore;
    if (atsScore == null) { try { atsScore = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'ats_result.json'), 'utf8')).score; } catch (_) {} }
    const notionResult = job.notionResult || (job.result && job.result.notionResult) || null;
    const cleanedUpFiles = job.cleanedUpFiles || (job.result && job.result.cleanedUpFiles) || [];
    res.json({
        workflowId: req.params.workflowId,
        status: job.status,
        jobLink: job.jobLink,
        startedAt: job.startedAt,
        error: job.error,
        atsScore,
        notionResult,
        cleanedUpFiles,
        outputFiles: job.outputFiles.length ? job.outputFiles : (fs.existsSync(OUTPUT_DIR) ? fs.readdirSync(OUTPUT_DIR).filter(f => !f.startsWith('.')) : []),
        logTail: (job.log || '').slice(-3000),
    });
});

app.get('/api/output-files', (req, res) => {
    try {
        if (!fs.existsSync(OUTPUT_DIR)) return res.json({ files: [] });
        const files = fs.readdirSync(OUTPUT_DIR).map(name => {
            const st = fs.statSync(path.join(OUTPUT_DIR, name));
            return { name, size: st.size, modified: st.mtime, type: name.endsWith('.pdf') ? 'pdf' : name.endsWith('.md') ? 'markdown' : name.endsWith('.txt') ? 'text' : 'other' };
        });
        res.json({ files });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cvs', (req, res) => {
    try {
        if (!fs.existsSync(MY_CVS_DIR)) return res.json({ cvs: [] });
        const cvs = fs.readdirSync(MY_CVS_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).map(name => {
            const st = fs.statSync(path.join(MY_CVS_DIR, name));
            return { name, size: st.size, modified: st.mtime };
        });
        res.json({ cvs });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/download/:filename', (req, res) => {
    // Prevent path traversal
    const filename = path.basename(req.params.filename);
    const fp = path.join(OUTPUT_DIR, filename);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
    // Ensure it's inside OUTPUT_DIR
    if (!fp.startsWith(OUTPUT_DIR)) return res.status(403).json({ error: 'Forbidden' });
    res.download(fp, filename);
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Job Application Pipeline server on http://localhost:${PORT}`);
    console.log(`  Form:     http://localhost:${PORT}/`);
    console.log(`  Health:   http://localhost:${PORT}/health`);
    console.log(`  Workspace: ${WORKSPACE_ROOT}`);
    console.log(`  CVs:       ${MY_CVS_DIR}`);
    console.log(`  Output:    ${OUTPUT_DIR}`);
    try {
        const cvs = fs.existsSync(MY_CVS_DIR) ? fs.readdirSync(MY_CVS_DIR).filter(f => f.toLowerCase().endsWith('.pdf')) : [];
        console.log(`  CVs found: ${cvs.length} — ${cvs.join(', ') || '(none — add PDFs to my_cvs/)'}`);
    } catch (_) {}
});
module.exports = app;
