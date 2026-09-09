# Job Application Pipeline — OpenClaw

Paste a job link → get an ATS-optimised 2-page CV + 1-page cover letter.

**Workflow:**
1. Accept job link from any site (SEEK, LinkedIn, Indeed, TradeMe, or generic) via web form or Telegram bot
2. Scrape job description via Puppeteer (handles JS-heavy pages)
3. Extract text from **all** PDFs in `my_cvs/` and **merge into ONE new CV** (uses both_sources → one output)
4. LLM generates a new ATS-friendly CV + cover letter tailored to the JD (uses OpenClaw's own LLM API, or a key you provide)
5. Check ATS score via the **ats.onl9.club API** (POSTs CV text + JD to `/api/v1/analyze`, reads score + keyword gaps)
6. If score < 85 → LLM improves CV using the keyword report → re-check (up to 3 iterations, keeps best)
7. Generate PDFs with enforced page limits: **CV = 2 FULL pages** (content fill measured, ≥92% of both pages), **Cover letter = 1 page** (verified via `pdf-parse`)
8. Save to `output/` + optional Telegram notification

## Files

| File | Purpose |
|------|---------|
| `job_application_form.html` | Web form — paste link, optionally override LLM key/model |
| `job_application_pipeline.js` | Core pipeline (valid JS, not markdown) |
| `server.js` | HTTP server + Telegram webhook |
| `run_pipeline.js` | CLI entry point |
| `my_cvs/*.pdf` | Your 2–3 source CVs (all merged into one output) |
| `output/` | Generated CV/CL (md + pdf), JD, ATS report |

## Prerequisites

- Node.js 18+
- Puppeteer + Chrome (auto-downloaded)
- Your CVs as PDFs in `my_cvs/`
- LLM API: uses the provider chain in `.env` (currently OpenRouter `openrouter/free`; Nvidia NIM ready once its key is renewed); or provide your own via form/env

## Setup

```bash
cd D:\OpenClaw\workspace
npm install   # puppeteer, openai, pdf-parse, express, cors already in package.json
```

Place CVs:
```
my_cvs/cv_linux_devops.pdf
my_cvs/cv_support_infrastructure.pdf
```

No ATS API key needed — `POST /api/v1/analyze` on `https://ats-api.onl9.club` accepts anonymous calls today (configurable via `ATS_API_BASE_URL` / `ATS_API_TOKEN` in `.env`).

## LLM Config

The pipeline runs with a resilient multi-provider fallback chain prioritized in this order:

1. Per-request override from form/CLI (`llmApiKey`, `llmModel`, `llmBaseUrl`)
2. **OpenRouter**: `OPENROUTER_API_KEY` (`nvidia/nemotron-3-super-120b-a12b:free` or custom `OPENROUTER_MODEL`)
3. **Groq**: `GROQ_API_KEY` (`openai/gpt-oss-120b` or custom `GROQ_MODEL`)
4. **NVIDIA NIM**: `NIM_API_KEY` (`nvidia/nemotron-3-super-120b-a12b` or custom `NIM_MODEL`)
5. Optional fallbacks: `LLM_API_KEY`, `BAI_API_KEY`, `GEMINI_API_KEY`, `ORCAROUTER_API_KEY`

At startup the pipeline runs preflight health checks to verify connectivity, dropping any invalid/unauthorized keys up-front with a clear log line before starting document processing.

Providers currently in `.env`:
- **OpenRouter**: `nvidia/nemotron-3-super-120b-a12b:free` (Active, priority #1)
- **Groq**: `openai/gpt-oss-120b` (Active, priority #2)
- **NVIDIA NIM**: `nvidia/nemotron-3-super-120b-a12b` (Active, priority #3)

## Running

### Form (recommended)

```bash
node server.js
# Open http://localhost:3000/
# Paste job link → Start Pipeline → poll /api/pipeline-status/:id
```

Or directly via CLI:

```bash
node run_pipeline.js "https://www.seek.co.nz/job/94121243"
# With explicit key/model:
node run_pipeline.js "https://www.seek.co.nz/job/94121243" "nvapi-..." "meta/llama-3.3-70b-instruct" "https://integrate.api.nvidia.com/v1"
```

### Telegram

The bot is connected to OpenClaw. Send any message containing a job URL to the bot:

```
https://www.seek.co.nz/job/94121243
```

The server also exposes `POST /api/telegram-webhook` for Telegram's `setWebhook`:

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
  ats_analysis.json     # full ATS API response (score, keywords, recommendations)
  ats_result.json         # { score, passed, iterations }
```

Pipelines keep the **best** CV across iterations (if a later iteration scores lower, the earlier best is restored).

## How It Works (details)

- **Scraping:** Puppeteer with site-aware selectors for SEEK/LinkedIn/Indeed/TradeMe, fallback to body text; 30s timeout.
- **PDF extraction:** `pdf-parse` reads all PDFs in `my_cvs/`.
- **Generation:** System prompt forbids hallucinating employers/degrees; CV target 600–680 words (fits 2 pages at 8.3pt/10mm).
- **ATS check:** POSTs the CV + JD to `POST /api/v1/analyze` on `ats-api.onl9.club` (ats.onl9.club's API) and reads `overall_score`, `missing_keywords`, formatting issues and recommendations. If the API is unreachable, the pipeline keeps the generated CV as-is instead of iterating against an empty report.
- **PDFs:** Puppeteer `page.pdf` A4 + content-height measurement. CV must be exactly 2 pages AND fill ≥92% of them — if sparse the LLM expands, if overflowing it shortens (3 attempts). CL must fit 1 page. Files are named `MaghavAhuja_<Company>_CV.pdf` / `_CL.pdf`; if the company can't be detected from the page, it's extracted from the JD via LLM.
- **LLM:** `openai` SDK against any OpenAI-compatible endpoint; provider chain with per-provider retries; pre-flight key validation drops dead keys at startup.

## Troubleshooting

- **Puppeteer can't launch:** Ensure Chrome is installed or `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` not set incorrectly.
- **ATS always low:** Check the ATS API is reachable (`curl https://ats-api.onl9.club/api/v1/health`); the pipeline saves `output/ats_analysis.json` on each check.
- **PDF pages wrong:** Margins/fonts are tuned for 600–680 word CVs; if you change content length drastically, adjust `@page`/`body` styles in `generatePdfWithPageCheck`.
- **LLM empty content:** gpt-oss-120b reasoning can exhaust token budget; the pipeline retries with `reasoning_effort: low` and a wait. If it persists, provide a non-reasoning model via `LLM_MODEL`.

## Security

- API keys are only in memory / env, never written to output.
- `output/` and `my_cvs/` are not committed; don't commit `.env`.
- Browser runs headless by default.
