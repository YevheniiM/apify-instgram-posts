import axios from 'axios';

function getToken() {
  return process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || process.env.TOKEN || null;
}

async function getRun(runId, token) {
  const url = `https://api.apify.com/v2/actor-runs/${runId}`;
  const { data } = await axios.get(url, { params: { token } });
  return data?.data;
}

async function getDatasetInfo(datasetId, token) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}`;
  const { data } = await axios.get(url, { params: { token } });
  return data?.data;
}

async function getDatasetItems(datasetId, token, { limit = 100000, offset = 0, fields = [] } = {}) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items`;
  const params = { token, clean: true, format: 'json', limit, offset };
  if (fields && fields.length) params.fields = fields.join(',');
  const { data } = await axios.get(url, { params });
  return Array.isArray(data) ? data : [];
}

function summarizeItems(items) {
  const stats = {
    total: items.length,
    posts: 0,
    profile_summary: [],
    duplicates: [],
    uniqueShortcodes: 0,
  };

  const seen = new Map(); // shortcode -> count

  for (const it of items) {
    const type = it?.type || null;
    if (type === 'profile_summary') {
      stats.profile_summary.push({
        username: it.username,
        expectedCount: it.expectedCount ?? null,
        discoveredCount: it.discoveredCount ?? null,
        extractedCount: it.extractedCount ?? null,
        missingCount: it.missingCount ?? null,
      });
      continue;
    }

    const sc = it?.shortCode || it?.shortcode || null;
    if (sc) {
      stats.posts++;
      const c = (seen.get(sc) || 0) + 1;
      seen.set(sc, c);
    }
  }

  const dups = [];
  for (const [sc, c] of seen.entries()) {
    if (c > 1) dups.push({ shortcode: sc, count: c });
  }

  stats.uniqueShortcodes = seen.size;
  stats.duplicates = dups;
  return stats;
}

async function analyzeRun(runId) {
  const token = getToken();
  if (!token) {
    throw new Error('APIFY_TOKEN not found in environment. Please export APIFY_TOKEN.');
  }

  const run = await getRun(runId, token);
  if (!run) throw new Error(`Run ${runId} not found`);

  const datasetId = run.defaultDatasetId;
  const kvId = run.defaultKeyValueStoreId;
  const startedAt = run.startedAt;
  const finishedAt = run.finishedAt;
  const status = run.status;
  const usageUsd = run?.usage?.totalUsd ?? run?.usageTotalUsd ?? null;

  const dsInfo = datasetId ? await getDatasetInfo(datasetId, token) : null;
  const items = datasetId ? await getDatasetItems(datasetId, token, { fields: ['type','shortCode','shortcode','username'] }) : [];
  const summary = summarizeItems(items);

  return {
    runId,
    status,
    startedAt,
    finishedAt,
    usageUsd,
    datasetId,
    datasetItemCount: dsInfo?.itemCount ?? items.length,
    postsCount: summary.posts,
    uniqueShortcodes: summary.uniqueShortcodes,
    duplicateCount: summary.duplicates.length,
    duplicatesSample: summary.duplicates.slice(0, 10),
    profileSummaries: summary.profile_summary,
  };
}

async function main() {
  const ids = process.argv.slice(2).filter(Boolean);
  if (ids.length === 0) {
    console.error('Usage: node scripts/analyze-run.mjs <RUN_ID_1> [RUN_ID_2 ...]');
    process.exit(2);
  }

  const results = [];
  for (const id of ids) {
    try {
      const res = await analyzeRun(id);
      results.push(res);
    } catch (e) {
      results.push({ runId: id, error: e.message });
    }
  }

  console.log(JSON.stringify({ analyzedAt: new Date().toISOString(), results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

