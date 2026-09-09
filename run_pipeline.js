#!/usr/bin/env node
/**
 * CLI entry — thin wrapper around job_application_pipeline.js
 *
 * Usage:
 *   node run_pipeline.js <job_link> [llm_api_key] [llm_model] [llm_base_url]
 *   LLM_API_KEY / LLM_MODEL / LLM_BASE_URL / M_JOB_API_* env vars are also respected.
 *
 * Example:
 *   node run_pipeline.js "https://www.seek.co.nz/job/123"
 *   node run_pipeline.js "https://www.seek.co.nz/job/123" "gsk_..." "openai/gpt-oss-120b"
 */

const JobApplicationPipeline = require('./job_application_pipeline');

async function main() {
    const args = process.argv.slice(2);
    if (!args[0] || args[0] === '--help' || args[0] === '-h') {
        console.log('Usage: node run_pipeline.js <job_link> [llm_api_key] [llm_model] [llm_base_url]');
        console.log('');
        console.log('  job_link:     SEEK / LinkedIn / Indeed / TradeMe / any career URL');
        console.log('  llm_api_key:  optional override (else uses LLM_API_KEY / M_JOB_API_KEY env)');
        console.log('  llm_model:    optional override (else uses LLM_MODEL / M_JOB_API_MODEL)');
        console.log('  llm_base_url: optional override (else uses LLM_BASE_URL / M_JOB_API_BASE_URL)');
        console.log('');
        console.log('Examples:');
        console.log('  node run_pipeline.js "https://www.seek.co.nz/job/94121243"');
        console.log('  node run_pipeline.js "https://www.seek.co.nz/job/94121243" "gsk_xxx" "openai/gpt-oss-120b"');
        process.exit(args[0] ? 0 : 1);
    }

    const [jobLink, llmApiKey, llmModel, llmBaseUrl] = args;

    try { new URL(jobLink); } catch {
        console.error(`Invalid URL: ${jobLink}`);
        process.exit(1);
    }

    const pipeline = new JobApplicationPipeline({
        jobLink,
        llmApiKey: llmApiKey || undefined,
        llmModel: llmModel || undefined,
        llmBaseUrl: llmBaseUrl || undefined,
    });

    try {
        const result = await pipeline.run();
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
