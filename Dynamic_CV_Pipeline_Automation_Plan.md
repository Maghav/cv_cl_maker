# Automated Dynamic CV Pipeline: Technical Blueprint & Implementation Roadmap

> **Target Workspace:** `d:\Project\Jobs Automation - Copy\Workflow`  
> **Target Document:** `Dynamic_CV_Pipeline_Automation_Plan.pdf`  
> **Generated Date:** 2026-09-20  
> **Status:** Ready for Step-by-Step Execution  

---

## 1. Executive Summary & Problem Diagnosis

### The Problem
The current pipeline in `Workflow` relies on a static profile (`candidate_profile.json`). Crucially:
1. **Source CVs in `my_cvs/*.pdf`:** While `extractAndMergeCVs()` extracts raw text to `output/merged_cvs_source.txt`, this extracted text is never passed into the LLM prompt. The generator only reads `candidate_profile.json`.
2. **Hardcoded Strings:** In `job_application_pipeline.js`, the candidate's exact 4 employers (*Neurix Limited, Datacom NZ, Department of Education, Mitre10 MEGA*), 3 projects, and 2 education credentials are hardcoded as static string literals in the LLM prompt and repair prompts.
3. **Portfolio Site (`portfolio.onl9.club`):** The workflow has zero connection or scraping logic for `portfolio.onl9.club`.
4. **Result:** Any update to your CV PDFs, adding a 3rd CV, or updating your portfolio website has **no effect** on the generated ATS CV.

### The Objective
Transform the pipeline into an **end-to-end dynamic career engine** that automatically extracts, deduplicates, and synchronizes information from:
1. **Live Portfolio Website (`portfolio.onl9.club`)**
2. **Any number of source CV PDFs in `my_cvs/`**
3. **The curated candidate profile (`candidate_profile.json`)**

It will feed this unified, verified profile dynamically into the prompt generation engine, without hardcoded string lists, while strictly maintaining:
* Exact **2 full A4 pages** for the CV (fill $\ge 92\%$)
* Exact **1 page** for the Cover Letter
* **90%+ ATS match score** on `ats.onl9.club`
* **Zero hallucinations** through dynamic factual integrity checking
* Multi-provider LLM fallback (OpenRouter $\rightarrow$ Groq $\rightarrow$ NVIDIA NIM)
* Automatic **Notion database synchronization** & local cleanup

---

## 2. Architecture Comparison

| Feature | Current Implementation | Dynamic Automated Pipeline |
| :--- | :--- | :--- |
| **Portfolio Website** | Unused; zero network calls to `portfolio.onl9.club` | Puppeteer/fetch scraper extracts live experience, skills, projects, and learning labs with local 24h caching & offline fallback |
| **`my_cvs/` Source PDFs** | Reads text into `merged_cvs_source.txt` only for character count | Deep parser extracts bullet points, skills, certifications, and tracks changes via SHA-256 manifest |
| **Profile Storage** | Static `candidate_profile.json` | Intelligent Aggregator merges Portfolio + CVs + Base Profile into a unified active profile |
| **LLM Prompts** | Hardcoded 4 employers, 3 projects, and 2 schools | Dynamic template generator builds prompt rules from the active profile |
| **Integrity Validator** | Static assertions; signature bug on lines 2234/2251 passing `mergedText` | Dynamic validator verifies that all active profile entities are present; fixes signature bug |
| **Page Budget** | 2 full pages (CV), 1 page (CL) | Strictly enforced via content-height measurement and dynamic font scaling |
| **Deployment / Notion** | Standalone Node.js script + Notion API | Maintained with automatic upload and clean output lifecycle |

---

## 3. Step-by-Step Implementation Roadmap (7 Phases, 21 Steps)

### Phase 1: Live Portfolio Ingestion Engine (`portfolio_scraper.js`)
* **Step 1.1: Scraper Core & DOM Extraction**
  * Develop `portfolio_scraper.js` using Puppeteer to parse `https://portfolio.onl9.club`.
  * Extract: About summary, Work Experience (Neurix, Mitre10, Datacom, Woolworths, etc.), Education (Unitec, Maharaja Surajmal), Skills categorized across 8 groups (Infrastructure, Cloud, IaC, CI/CD, Containers, Monitoring, Security, AI), Projects (Portfolio, Learning Physics, ONL9 Toolkit, Job Pipeline), and Troubleshooting Labs (SadServers, KodeKloud, Iximiuz).
* **Step 1.2: Resilient Local Caching & Offline Fallback**
  * Cache extracted portfolio data in `portfolio_cache.json` with a 24-hour TTL.
  * If `portfolio.onl9.club` is slow or unreachable, gracefully fall back to cache or `candidate_profile.json` without failing the pipeline.
* **Step 1.3: Data Normalization & Sanitization**
  * Clean date strings, resolve Cloudflare email protection tokens, and format into standard JSON schema.

### Phase 2: Multi-CV PDF Text & Section Parser (`cv_parser.js`)
* **Step 2.1: Dynamic PDF Discovery & SHA-256 Hashing**
  * Scan `my_cvs/*.pdf`. Maintain a SHA-256 file manifest (`my_cvs/.manifest.json`) to detect additions, deletions, or edits immediately.
* **Step 2.2: Sectional & Semantic Entity Extraction**
  * Extract sections (Professional Experience, Technical Skills, Projects, Education) from any arbitrary CV layout.
* **Step 2.3: Granular Bullet Point & Source Tagging**
  * Tag extracted bullet points with source file provenance (e.g. `cv_linux_devops.pdf` vs `cv_support_infrastructure.pdf`).

### Phase 3: Unified Profile Aggregator (`profile_aggregator.js`)
* **Step 3.1: Intelligent Merge & Conflict Resolution Engine**
  * Merge data across 3 sources: Base `candidate_profile.json` + Live `portfolio.onl9.club` + Extracted `my_cvs/*.pdf`.
  * Map company aliases (e.g. "Datacom" = "Datacom NZ", "Neurix" = "Neurix Limited").
  * Deduplicate achievement bullets using string similarity, prioritizing high-impact, metric-driven points.
  * Union all skill keywords and assign standardized category tags.
* **Step 3.2: Dynamic Keyword & Tag Indexing for ATS Classifier**
  * Auto-generate normalized search tags for new skills to feed `classifyJob()` and `scoreForJob()`.
* **Step 3.3: Safe Profile Persistence & Backup**
  * Save the aggregated profile to `candidate_profile.json` and keep an automated timestamped backup in `candidate_profile.backup.json`.

### Phase 4: Decouple Hardcoded Strings in Pipeline Prompts
* **Step 4.1: Dynamic LLM Prompt Builder**
  * Refactor `generateCVAndCoverLetter()` in `job_application_pipeline.js`:
    * Replace hardcoded 4 employers with `candidateProfile.experience.map(...)`.
    * Replace hardcoded projects with `candidateProfile.projects.map(...)`.
    * Replace hardcoded education with `candidateProfile.education.map(...)`.
* **Step 4.2: Dynamic Factual Baseline Document Formatter**
  * Update `buildFactualApplicationDocuments()` to format any number of dynamic employers and skill categories cleanly.
* **Step 4.3: Dynamic Repair & Re-fit Prompts**
  * Refactor self-repair prompts (lines 2221–2226) to dynamically pull verified employers and projects from the active profile.

### Phase 5: Dynamic Integrity Validator (`validateCVIntegrity`)
* **Step 5.1: Dynamic Factual Entity Verification**
  * Update `validateCVIntegrity(cvMarkdown, profile)` to verify presence of every employer, role title, project, and educational institution dynamically extracted from `profile`.
* **Step 5.2: Fix Function Signature Call Bug**
  * Fix the bug on lines 2234 and 2251 where `mergedText` (string) was passed instead of `candidateProfile` (object).
* **Step 5.3: Strict Anti-Hallucination & Formatting Rules**
  * Ensure standard section order, placeholder detection, and word budget (750 to 1200 words) remain enforced.

### Phase 6: Core Pipeline Orchestrator Integration & UI
* **Step 6.1: Preflight Sync Lifecycle Hook**
  * Insert profile sync hook into `JobApplicationPipeline.run()` before job scraping.
  * Log summary: `[Profile Sync] Live portfolio fetched | X source CVs parsed | Active profile updated`.
* **Step 6.2: Environment Variable Configuration**
  * Add configuration options to `.env` and `.env.example`:
    * `PORTFOLIO_URL=https://portfolio.onl9.club`
    * `SYNC_PORTFOLIO_ON_RUN=true`
    * `PORTFOLIO_CACHE_HOURS=24`
* **Step 6.3: Web Form & CLI Enhancements**
  * Update `job_application_form.html` and `server.js` to display the count of detected CVs in `my_cvs/` and last sync time.
  * Add CLI flags: `--force-sync` and `--skip-sync` in `run_pipeline.js`.

### Phase 7: Comprehensive Verification & Zero-Error Validation
* **Step 7.1: Isolated Unit Tests**
  * Create `tests/dynamic_sync_test.js` covering the scraper, CV parser, aggregator, and dynamic integrity validator.
* **Step 7.2: Visual Layout & Page-Budget Enforcement**
  * Run test generation to verify:
    * CV PDF fills **EXACTLY 2 full A4 pages** with content height $\ge 92\%$.
    * Cover Letter PDF fits **EXACTLY 1 page**.
* **Step 7.3: End-to-End Pipeline & Notion Sync Validation**
  * Execute a real pipeline run: verify ATS scoring on `ats.onl9.club` (target 90%+), automatic Notion database upload, and automatic output directory cleanup.

---

## 4. Execution Order & Deliverables Summary

| Step | Phase | Key Deliverable | Verification Check |
| :--- | :--- | :--- | :--- |
| **Phase 1** | Portfolio Ingestion | `portfolio_scraper.js` + `portfolio_cache.json` | Puppeteer parses live site + offline fallback test passes |
| **Phase 2** | CV PDF Extractor | `cv_parser.js` + PDF hashing manifest | Extracts bullets & skills from any PDF in `my_cvs/` |
| **Phase 3** | Profile Aggregator | `profile_aggregator.js` + sync logic | Deduplicates & updates `candidate_profile.json` |
| **Phase 4** | Prompt Decoupling | Dynamic prompt generator in `job_application_pipeline.js` | No hardcoded employer or project strings in prompts |
| **Phase 5** | Dynamic Integrity Gate | Refactored `validateCVIntegrity()` + bug fix | Validates dynamic entities + zero false errors |
| **Phase 6** | Pipeline Integration | Orchestrator preflight hook + `.env` + Web UI | Web form and CLI show active CV count & portfolio status |
| **Phase 7** | Zero-Error Verification | Full test suite + E2E test run | 2-page CV ($\ge 92\%$), 1-page CL, ATS score 90%+, Notion sync ok |

---

## 5. File Location
* **PDF Blueprint:** `d:\Project\Jobs Automation - Copy\Workflow\Dynamic_CV_Pipeline_Automation_Plan.pdf`
* **Markdown Blueprint:** `d:\Project\Jobs Automation - Copy\Workflow\Dynamic_CV_Pipeline_Automation_Plan.md`
