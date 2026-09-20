#!/usr/bin/env node
/**
 * CLI entry — thin wrapper around job_application_pipeline.js
 *
 * Usage:
 *   node run_pipeline.js <job_link> [llm_api_key] [llm_model] [llm_base_url]
 *   LLM_API_KEY / LLM_MODEL / LLM_BASE_URL env vars or .env provider chain are also respected.
 *
 * Example:
 *   node run_pipeline.js "https://www.seek.co.nz/job/123"
 *   node run_pipeline.js "https://www.seek.co.nz/job/123" "gsk_..." "openai/gpt-oss-120b"
 */

const JobApplicationPipeline = require('./job_application_pipeline');

async function main() {
    const rawArgs = process.argv.slice(2);
    if (!rawArgs[0] || rawArgs.includes('--help') || rawArgs.includes('-h')) {
        console.log('Usage: node run_pipeline.js <job_link> [llm_api_key] [llm_model] [llm_base_url] [--force-sync] [--skip-sync]');
        console.log('');
        console.log('  job_link:     SEEK / LinkedIn / Indeed / TradeMe / any career URL');
        console.log('  llm_api_key:  optional override (else uses LLM_API_KEY / .env provider chain)');
        console.log('  llm_model:    optional override (else uses LLM_MODEL / .env provider chain)');
        console.log('  llm_base_url: optional override (else uses LLM_BASE_URL / .env provider chain)');
        console.log('  --force-sync: force fresh live portfolio scrape & CV PDF re-parsing');
        console.log('  --skip-sync:  skip preflight profile synchronization');
        console.log('');
        console.log('Examples:');
        console.log('  node run_pipeline.js "https://www.seek.co.nz/job/94121243"');
        console.log('  node run_pipeline.js "https://www.seek.co.nz/job/94121243" --force-sync');
        console.log('  node run_pipeline.js "https://www.seek.co.nz/job/94121243" "gsk_xxx" "openai/gpt-oss-120b"');
        process.exit(rawArgs[0] ? 0 : 1);
    }

    const forceSync = rawArgs.includes('--force-sync') || rawArgs.includes('-f');
    const skipSync = rawArgs.includes('--skip-sync');
    const positional = rawArgs.filter(a => !a.startsWith('--') && !a.startsWith('-'));
    const [jobLink, llmApiKey, llmModel, llmBaseUrl] = positional;

    if (!jobLink) {
        console.error('Error: Job link URL is required.');
        process.exit(1);
    }

    try { new URL(jobLink); } catch {
        console.error(`Invalid URL: ${jobLink}`);
        process.exit(1);
    }

    const pipeline = new JobApplicationPipeline({
        jobLink,
        llmApiKey: llmApiKey || undefined,
        llmModel: llmModel || undefined,
        llmBaseUrl: llmBaseUrl || undefined,
        forceSync,
        skipSync,
    });

    try {
        const result = await pipeline.run();
        if (!result || result.success === false) {
            console.error('\nPipeline failed:', result?.error || 'Unknown error');
            console.error(JSON.stringify(result, null, 2));
            process.exit(1);
        }
        console.log('\nPipeline completed successfully');
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
    } catch (err) {
        console.error('\nPipeline failed:', err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    }
}

main();
