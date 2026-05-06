#!/usr/bin/env node
// fetch-clips.js
// Usage:
//   1. Create clips.txt with one Twitch clip URL per line
//   2. Set env vars: TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET
//   3. Run: node fetch-clips.js
//   Outputs: clips.json

const fs   = require('fs');
const path = require('path');

const CLIENT_ID     = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const INPUT_FILE    = path.join(__dirname, 'clips.txt');
const OUTPUT_FILE   = path.join(__dirname, 'clips.json');

function extractClipId(url) {
  const m = url.match(/clips\.twitch\.tv\/([^/?&#\s]+)/) ||
            url.match(/twitch\.tv\/[^/]+\/clip\/([^/?&#\s]+)/);
  return m ? m[1] : null;
}

async function getAccessToken() {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function fetchClipMetadata(ids, token) {
  // Helix accepts up to 100 IDs per request
  const params = ids.map(id => `id=${encodeURIComponent(id)}`).join('&');
  const res = await fetch(`https://api.twitch.tv/helix/clips?${params}`, {
    headers: {
      'Client-Id': CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error(`Clips request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data; // array of clip objects
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`Error: ${INPUT_FILE} not found. Create it with one Twitch clip URL per line.`);
    process.exit(1);
  }

  const lines = fs.readFileSync(INPUT_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (lines.length === 0) {
    console.error('Error: clips.txt is empty.');
    process.exit(1);
  }

  // Extract clip IDs, preserving original URL for reference
  const entries = lines.map(url => ({ url, id: extractClipId(url) }));
  const invalid = entries.filter(e => !e.id);
  if (invalid.length) {
    console.warn('Warning: could not parse clip ID from these URLs (skipping):');
    invalid.forEach(e => console.warn(' ', e.url));
  }

  const valid = entries.filter(e => e.id);
  if (valid.length === 0) {
    console.error('Error: no valid Twitch clip URLs found.');
    process.exit(1);
  }

  // Load existing clips.json and key by clip ID so we can skip re-fetching
  const cachedById = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      for (const entry of existing) {
        const id = extractClipId(entry.clipUrl);
        if (id) cachedById[id] = entry;
      }
    } catch (e) {
      console.warn(`Warning: could not parse existing clips.json (${e.message}) — refetching all.`);
    }
  }

  const toFetch = valid.filter(e => !cachedById[e.id] || !cachedById[e.id].creatorName);
  const cachedCount = valid.length - toFetch.length;

  console.log(`${valid.length} clip(s) total — ${cachedCount} cached, ${toFetch.length} new.`);

  const metaById = {};
  if (toFetch.length > 0) {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.error('Error: Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables (needed to fetch new clips).');
      process.exit(1);
    }

    const token = await getAccessToken();

    // Batch in groups of 100 (API limit)
    for (let i = 0; i < toFetch.length; i += 100) {
      const batch = toFetch.slice(i, i + 100);
      const meta  = await fetchClipMetadata(batch.map(e => e.id), token);
      for (const clip of meta) metaById[clip.id] = clip;
    }

    // Warn about any IDs the API didn't return
    const notFound = toFetch.filter(e => !metaById[e.id]);
    if (notFound.length) {
      console.warn('Warning: API returned no data for these clips (check they are public):');
      notFound.forEach(e => console.warn(' ', e.url));
    }
  }

  // Build clips.json entries, preserving clips.txt order
  const clipsJson = valid
    .map(e => {
      const clip = metaById[e.id];
      if (clip) {
        const created = new Date(clip.created_at);
        const year    = created.getUTCFullYear();
        const month   = created.getUTCMonth() + 1; // 1-indexed
        const date    = `${year}-${String(month).padStart(2, '0')}`;

        return {
          date,
          clipUrl:      e.url,
          thumbnailUrl: clip.thumbnail_url,
          creatorName:  clip.creator_name,
          year,
          month
        };
      }
      if (cachedById[e.id]) return cachedById[e.id];
      return null;
    })
    .filter(Boolean);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(clipsJson, null, 2));
  console.log(`Done. Wrote ${clipsJson.length} clip(s) to clips.json`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
