# Job Application Pipeline

Paste a job link → get an ATS-optimised 2-page CV + 1-page cover letter, automatically uploaded to Notion.

> **Note on OpenClaw:** OpenClaw is **not** present or required. This pipeline is completely standalone, running directly on Node.js with standard API keys.

**Workflow:**
1. Accept job link from any site (SEEK, LinkedIn, Indeed, TradeMe, or generic) via web form or Telegram bot
2. Scrape job description via Puppeteer (handles JS-heavy pages)
3. Extract text from **all** PDFs in `my_cvs/` and **merge into ONE new CV** (uses candidate profile for factual integrity)
4. LLM generates a new ATS-friendly CV + cover letter tailored to the JD (multi-provider fallback: OpenRouter, Groq, NVIDIA NIM, OpenAI)
5. Check ATS score via the **ats.onl9.club API** (POSTs CV text + JD to `/api/v1/analyze`, reads score + keyword gaps)
6. If score < 85 → LLM improves CV using the keyword report → re-check (up to 3 iterations, keeps best)
7. Generate PDFs with enforced page limits: **CV = 2 FULL pages** (content fill measured, ≥92% of both pages), **Cover letter = 1 page** (verified via `pdf-parse`)
8. Save to `output/` + **automatic Notion sync** (uploads CV & Cover Letter PDFs to your Notion database) + optional Telegram notification

## Files

| File | Purpose |
|------|---------|
| `job_application_form.html` | Web form — paste link, optionally override LLM key/model |
| `job_application_pipeline.js` | Core pipeline orchestrator |
| `notion_sync.js` | Notion API integration — uploads PDFs and logs applications |
| `server.js` | HTTP server + Telegram webhook |
| `run_pipeline.js` | CLI entry point |
| `candidate_profile.json` | Curated source-of-truth career history & skills |
| `my_cvs/*.pdf` | Source CVs |
| `output/` | Generated CV/CL (md + pdf), JD, ATS report |
| `tests/` | Smoke tests and Notion sync unit tests |

## Prerequisites

- Node.js 18+ (Node.js 22 recommended)
- Puppeteer + Chrome (auto-downloaded)
- Your CVs as PDFs in `my_cvs/`
- LLM API: uses the provider chain in `.env` (OpenRouter, Groq, NVIDIA NIM, OpenAI); or provide your own via form/CLI
- Optional: Notion integration token to auto-sync applications and upload PDFs

## Setup

```bash
cd Workflow
npm install   # puppeteer, openai, pdf-parse, express, cors
```

Place your base CVs in `my_cvs/`:
```
my_cvs/cv_linux_devops.pdf
my_cvs/cv_support_infrastructure.pdf
```

Configure your environment:
```bash
cp .env.example .env
```
Edit `.env` to supply your LLM keys and optional Notion token.

No ATS API key needed — `POST /api/v1/analyze` on `https://ats-api.onl9.club` accepts anonymous calls today (configurable via `ATS_API_BASE_URL` in `.env`).

## Notion Integration (Job Tracking & PDF Uploads)

Target Database: [Notion Job Applications Database](https://app.notion.com/p/26d086ddaa064aa0b51318c8d3e6a84f?v=b1532aba5c004f3ab6622b06e070f8e5)  
Database ID: `26d086ddaa064aa0b51318c8d3e6a84f`

### How It Works:
1. **Direct File Uploads**: Both the newly generated CV PDF and Cover Letter PDF are uploaded directly to Notion via the Notion File Upload API (`POST /v1/file_uploads` & `POST /v1/file_uploads/:id/send`).
2. **Dynamic Property Mapping**: The module queries your Notion database schema and automatically fills:
   - **Title / Name**: `Job Title — Company`
   - **Company**: Extracted company name
   - **Job URL / Link**: Link to original job posting
   - **ATS Score**: Match score percentage
   - **Date Applied**: Current date
   - **Status**: Sets to `Applied`
   - **CV / Resume**: Attached CV PDF
   - **Cover Letter**: Attached Cover Letter PDF
3. **Rich Page Body Content**: Automatically creates child blocks on the Notion page:
   - Summary callout with ATS match score and role details
   - Formatted Cover Letter text
   - ATS Keyword & Gap Analysis (missing keywords & recommendations)
   - Scraped Job Description
   - Full tailored CV markdown

### Setting Up Your Notion API Key:
1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and click **New integration**.
2. Name it (e.g. `Job Application Pipeline`) and select your workspace.
3. Copy the **Internal Integration Secret** (`ntn_...`).
4. In `.env`, add:
   ```ini
   NOTION_API_KEY=ntn_your_secret_token_here
   NOTION_DATABASE_ID=26d086ddaa064aa0b51318c8d3e6a84f
   ```
5. **Connect the integration to your Notion database**:
   - Open your database at `https://app.notion.com/p/26d086ddaa064aa0b51318c8d3e6a84f` in your browser.
   - Click the `...` button in the upper-right corner.
   - Select **Connect to** (or Connections), and choose the integration you created.
6. **Test the connection**:
   ```bash
   node notion_sync.js --test
   ```
   To sync your most recently generated output files:
   ```bash
   node notion_sync.js --sync-latest
   ```
   To clean up all files in `/output`:
   ```bash
   node notion_sync.js --clean-output
   ```

### Automatic Output Cleanup:
When Notion synchronization completes successfully, all generated CVs, Cover Letters (PDF & Markdown), ATS reports, and temporary workflow files in `/output` are automatically deleted to keep your workspace clean. The PDFs and complete application details remain safely stored in your Notion database.

To preserve local files instead, set `CLEANUP_OUTPUT_AFTER_NOTION_SYNC=false` in `.env`.

If `NOTION_API_KEY` is not set or Notion sync fails, the files are kept in `/output` so you never lose any generated documents.

## LLM Config

The pipeline runs with a resilient multi-provider fallback chain prioritized in this order:

1. Per-request override from form/CLI (`llmApiKey`, `llmModel`, `llmBaseUrl`)
2. **OpenRouter**: `OPENROUTER_API_KEY` (`nvidia/nemotron-3-super-120b-a12b:free` or custom `OPENROUTER_MODEL`)
3. **Groq**: `GROQ_API_KEY` (`openai/gpt-oss-120b` or custom `GROQ_MODEL`)
4. **NVIDIA NIM**: `NIM_API_KEY` (`nvidia/nemotron-3-super-120b-a12b` or custom `NIM_MODEL`)
5. Optional fallbacks: `LLM_API_KEY`, `GEMINI_API_KEY`

At startup the pipeline runs preflight health checks to verify connectivity, dropping any invalid/unauthorized keys up-front with a clear log line before starting document processing.

## Running

### Form (recommended)

```bash
node server.js
# Open http://localhost:3000/
# Paste job link → Start Pipeline → poll /api/pipeline-status/:id
```

### CLI

```bash
node run_pipeline.js "https://www.seek.co.nz/job/94121243"
# With explicit key/model override:
node run_pipeline.js "https://www.seek.co.nz/job/94121243" "gsk_..." "openai/gpt-oss-120b"
```

### Telegram (Optional)

The server exposes `POST /api/telegram-webhook` for Telegram's `setWebhook`:

```bash
curl -X POST https://api.telegram.org/bot<TOKEN>/setWebhook \
  -d url=https://your-host/api/telegram-webhook
```

- `TELEGRAM_BOT_TOKEN` must be set
- If `TELEGRAM_CHAT_ID` is set, notifications go there; otherwise the chat that sent the URL is used
- Optional allowlist: `TELEGRAM_ALLOWED_CHAT_IDS=123,456`

Manual trigger (testing): `GET /api/telegram-trigger?url=https://...`

## Output

```
output/
  Optimized_CV.pdf        # 2 pages, ATS-checked
  Cover_Letter.pdf        # 1 page
  optimized_cv.md         # markdown source
  cover_letter.md
  job_description.txt     # scraped JD
  job_meta.json           # title, company, platform
  merged_cvs_source.txt   # combined source CVs
  ats_analysis.json       # full ATS API response (score, keywords, recommendations)
  ats_result.json         # { score, passed, iterations }
```

Pipelines keep the **best** CV across iterations (if a later iteration scores lower, the earlier best is restored).

## How It Works (details)

- **Scraping:** Puppeteer with site-aware selectors for SEEK/LinkedIn/Indeed/TradeMe, fallback to body text; 30s timeout.
- **Source CV extraction:** `pdf-parse` reads all PDFs in `my_cvs/` and stores `merged_cvs_source.txt`.
- **Factual generation:** Curated factual profile from `candidate_profile.json` ensures zero hallucinated employers or degrees.
- **ATS check:** POSTs the CV + JD to `POST /api/v1/analyze` on `ats-api.onl9.club` and reads `overall_score`, `missing_keywords`, and recommendations.
- **Deterministic PDF page fit:** Puppeteer `page.pdf` A4 + content-height measurement. CV must be exactly 2 pages AND fill ≥92% of both pages. CL must fit 1 page.
- **Notion Sync:** Automatically uploads the PDFs to Notion and creates a new database row with properties and full page body notes.

## Security

- API keys are only in memory / env, never written to output.
- `output/` and `my_cvs/` are not committed; never commit `.env`.
- Browser runs headless by default.
