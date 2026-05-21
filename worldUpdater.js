// worldUpdater.js
// -------------------------------------------------------------
// EQ2Emu World DB updater (memory-safe):
// - Catalog stores metadata only (NO SQL bodies cached)
// - Loads SQL per selected table at execution time
// -------------------------------------------------------------

const axios = require('axios');
const JSZip = require('jszip');

/** GitHub source */
const GITHUB_OWNER = 'nuadaxxx';
const GITHUB_REPO  = 'eq2emu-database';
const GITHUB_PATH  = 'worldtables_with_data';

/** Debug logging */
const DEBUG = process.env.WORLD_UPDATER_DEBUG === '1' ||
              (process.env.DEBUG || '').includes('world-updater');
const logD = (...a) => { if (DEBUG) console.log('[world-updater:debug]', ...a); };
const logI = (...a) => console.log('[world-updater]', ...a);
const logW = (...a) => console.warn('[world-updater:warn]', ...a);
const logE = (...a) => console.error('[world-updater:ERROR]', ...a);

/** Tables to omit unless explicitly allowed (includeChars=true) */
const DANGEROUS_TABLES = new Set(
  'char_colors,character_aa,character_achievements,character_achievements_items,character_buyback,character_claim_items,character_collections,character_details,character_factions,character_history,character_house_deposits,character_house_history,character_houses,character_instances,character_items,character_items_group_members,character_languages,character_lua_history,character_macros,character_mail,character_pictures,character_properties,character_quest_progress,character_quest_rewards,character_quest_temporary_rewards,character_quests,character_recipe_books,character_recipes,character_skillbar,characer_skills,character_social,character_spell_effect_targets,character_spell_effects,character_spells,character_spirit_shards,character_titles,characters,charactersProperties,charactersproperties,statistics,web_users,character_custom_spell_dataindex,character_custom_spell_display,character_custom_spell_data,guild_colors,guild_event_filters,guild_events,guild_members,guild_point_history,guild_ranks,guild_recruiting,guilds,spawn_location_entry_houses,spawn_location_name_houses,spawn_location_placement_houses,spawn_houses,spawn_signs_houses,spawn_widgets_houses,spawn_objects_houses,spawn_ground_houses,spawn_npcs_houses,broker_seller_log,broker_items,broker_sellers,seq_character_items'
    .split(',').map(s => s.trim())
);

/** Grouping via simple prefixes (no regex footguns) */
const GROUP_PREFIXES = {
  'Zones & Geography':     ['zones', 'zone', 'zone_', 'zoneaccess', 'door', 'doors', 'transport', 'navmesh', 'waypoint', 'waypoints', 'region', 'harvest_node', 'harvest_nodes'],
  'Loot & Drops':          ['loot_', 'loot', 'chest_traps', 'spawn_loot'],
  'Spawns & Placement':    ['spawn_', 'spawn', 'spawnlocation', 'grid', 'path', 'waypoint'],
  'NPCs & Factions':       ['npc_', 'npc', 'faction', 'factions', 'language', 'languages'],
  'Items & Appearance':    ['item_', 'items', 'appear', 'appearance', 'model', 'models', 'item_appearance', 'equip'],
  'Quests':                ['quest_', 'quests', 'quest', 'journal', 'dialogue', 'conversation', 'text'],
  'Merchants & Economy':   ['merchant', 'vendors', 'vendor', 'shop', 'economy', 'broker_'],
  'Spells & Combat':       ['spell_', 'spells', 'spell', 'ability', 'combat', 'proc', 'buff', 'effect'],
  'Tradeskills & Recipes': ['recipe', 'recipes', 'tradeskill', 'craft', 'combine'],
  'Rules & Systems':       ['rule', 'rules', 'server', 'setting', 'settings', 'world_'],
  'Books & Text':          ['book_', 'books', 'book', 'texts', 'text', 'npc_text']
};
function assignGroup(tableName) {
  const t = String(tableName || '').toLowerCase();
  for (const [group, prefixes] of Object.entries(GROUP_PREFIXES)) {
    if (prefixes.some(p => t.startsWith(p))) return group;
  }
  return 'Other / Misc';
}
function groupCatalog(catalog) {
  const groups = {};
  for (const row of catalog) {
    if (!groups[row.group]) groups[row.group] = [];
    groups[row.group].push({ table: row.table, fileName: row.fileName });
  }
  return groups;
}

/** GitHub headers (use token if present to avoid rate limits) */
function ghHeaders() {
  const h = { 'User-Agent': 'eq2emu-world-updater' };
  if (process.env.GITHUB_TOKEN) {
    h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    logD('Using GITHUB_TOKEN (len):', String(process.env.GITHUB_TOKEN).length);
  } else {
    logD('No GITHUB_TOKEN set (may be rate-limited).');
  }
  return h;
}

/** Resolve branch/tag/SHA -> { commitSha, treeSha } */
async function resolveTreeSha(ref) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${encodeURIComponent(ref)}`;
  logD('resolveTreeSha GET', url);
  const r = await axios.get(url, { headers: ghHeaders(), validateStatus: () => true });
  logD('resolveTreeSha status:', r.status, 'rate remaining:', r.headers['x-ratelimit-remaining']);
  if (r.status !== 200) throw new Error(`Commits API ${r.status} – ${(JSON.stringify(r.data) || '').slice(0,300)}`);
  const commitSha = r.data.sha;
  const treeSha = r.data.commit?.tree?.sha;
  if (!treeSha) throw new Error('Missing tree SHA in commit object');
  logD('commitSha:', commitSha, 'treeSha:', treeSha);
  return { commitSha, treeSha };
}

/** Find .zip files under worldtables_with_data/ using the tree SHA (recursive) */
async function listGithubZipsRecursive(ref) {
  const { commitSha, treeSha } = await resolveTreeSha(ref);

  const treeUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${treeSha}?recursive=1`;
  logD('tree GET', treeUrl);
  const r = await axios.get(treeUrl, { headers: ghHeaders(), validateStatus: () => true });
  logD('tree status:', r.status, 'rate remaining:', r.headers['x-ratelimit-remaining']);
  if (r.status !== 200) throw new Error(`Trees API ${r.status} – ${(JSON.stringify(r.data) || '').slice(0,300)}`);

  const tree = Array.isArray(r.data.tree) ? r.data.tree : [];
  logD('tree entries:', tree.length);

  const prefix = `${GITHUB_PATH}/`;
  const zipNodes = tree.filter(n =>
    n.type === 'blob' &&
    typeof n.path === 'string' &&
    n.path.startsWith(prefix) &&
    /\.zip$/i.test(n.path)
  );

  logD('.zip under', prefix, ':', zipNodes.length);
  if (DEBUG && zipNodes.length) {
    logD('first ZIPs:', zipNodes.slice(0, 5).map(n => n.path));
  }

  return {
    commitSha,
    zips: zipNodes.map(n => ({
      path: n.path,
      name: n.path.split('/').pop(),
      blobSha: n.sha,
      raw_url: `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${commitSha}/${n.path}`
    }))
  };
}

/** Download a ZIP file (raw first, fallback to blobs API) and return Buffer */
async function fetchZipBuffer(rawUrl, blobSha) {
  try {
    logD('raw ZIP GET', rawUrl);
    const zr = await axios.get(rawUrl, { headers: ghHeaders(), responseType: 'arraybuffer', validateStatus: () => true });
    logD('raw ZIP status:', zr.status, 'bytes:', zr.data ? zr.data.byteLength : 0);
    if (zr.status === 200 && zr.data) return Buffer.from(zr.data);
    logW('raw ZIP failed, falling back to blob API:', zr.status);
  } catch (e) {
    logW('raw ZIP GET error, falling back to blob API:', e.message);
  }

  // Blob API fallback (base64)
  const blobUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${blobSha}`;
  logD('blob ZIP GET', blobUrl);
  const br = await axios.get(blobUrl, { headers: ghHeaders(), validateStatus: () => true });
  logD('blob ZIP status:', br.status);
  if (br.status !== 200) throw new Error(`Blob API ${br.status} – ${(JSON.stringify(br.data) || '').slice(0,200)}`);
  if (br.data.encoding !== 'base64') throw new Error('Unexpected blob encoding: ' + br.data.encoding);
  return Buffer.from(br.data.content || '', 'base64');
}

/** Extract *.sql entry names ONLY (no contents) from a ZIP buffer */
async function listSqlEntriesFromZip(zipBuffer, zipName) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const entries = Object.keys(zip.files).filter(k => /\.sql$/i.test(k));
  logD(`ZIP ${zipName}: SQL entries:`, entries.length);
  return entries;
}

/** Detect table name from entry/path; fallback to filename base */
function detectTableNameFromPaths(entryName, zipName) {
  // Preferred: /home/eq2emu/backups/_/tablename.sql
  const base = (entryName || '').split('/').pop() || '';
  if (base.toLowerCase().endsWith('.sql')) {
    return base.slice(0, -4); // remove .sql
  }
  const zipBase = (zipName || '').replace(/\.zip$/i, '');
  return zipBase || base || 'unknown_table';
}

/** Public: build a catalog (metadata only) */
async function fetchWorldTableCatalog({ ref = 'main' } = {}) {
  logI('Catalog: ref =', ref);
  const { commitSha, zips } = await listGithubZipsRecursive(ref);
  logI('Found ZIPs:', zips.length, 'at commit', commitSha);

  if (!zips.length) {
    logW('No ZIP files found under', GITHUB_PATH, '— check ref/path or rate limits.');
    return [];
  }

  const catalog = [];
  // Process sequentially; DO NOT store SQL text
  for (const z of zips) {
    try {
      const zipBuf = await fetchZipBuffer(z.raw_url, z.blobSha);
      const sqlEntries = await listSqlEntriesFromZip(zipBuf, z.name);

      if (!sqlEntries.length) {
        logW(`ZIP ${z.name} contained no *.sql files.`);
        continue;
      }

      // Most zips in this repo are one table → one .sql
      for (const entryName of sqlEntries) {
        const table = detectTableNameFromPaths(entryName, z.name);
        const group = assignGroup(table);
        catalog.push({
          // Minimal, memory-light row:
          table,                  // SQL table name (from file name)
          group,                  // group bucket
          fileName: `${z.name} :: ${entryName}`,   // for UI preview
          path: `${z.path}::${entryName}`,         // path inside repo+zip
          // JIT fetch info (used later by applyPlan):
          zip: {
            name: z.name,
            path: z.path,
            blobSha: z.blobSha,
            raw_url: z.raw_url,
            commitSha
          },
          entryName
        });
      }
    } catch (err) {
      logE('ZIP list/parse failed for', z.path, '→', err.message);
    }
  }

  catalog.sort((a, b) => a.table.localeCompare(b.table));
  logI('Catalog ready. Tables:', catalog.length);
  return catalog;
}

/**
 * Progress-capable version:
 * Calls onProgress(msgOrObject) with human-readable strings or small objects.
 * Returns same metadata-only catalog.
 */
async function fetchWorldTableCatalogWithProgress({ ref = 'main', onProgress } = {}) {
  const send = (m) => { try { onProgress && onProgress(m); } catch {} };

  send(`Resolving ref "${ref}"…`);
  const { commitSha, treeSha } = await resolveTreeSha(ref);
  send({ type: 'resolved', commitSha, treeSha });

  // Walk tree for ZIPs
  const treeUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${treeSha}?recursive=1`;
  const tr = await axios.get(treeUrl, { headers: ghHeaders(), validateStatus: () => true });
  if (tr.status !== 200) throw new Error(`Trees API ${tr.status}`);
  const tree = Array.isArray(tr.data.tree) ? tr.data.tree : [];
  const prefix = `${GITHUB_PATH}/`;
  const zips = tree.filter(n => n.type === 'blob' && n.path && n.path.startsWith(prefix) && /\.zip$/i.test(n.path))
                   .map(n => ({
                     path: n.path,
                     name: n.path.split('/').pop(),
                     blobSha: n.sha,
                     raw_url: `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${commitSha}/${n.path}`
                   }));

  send(`Found ZIPs: ${zips.length} @ commit ${commitSha}`);

  const catalog = [];
  for (let i = 0; i < zips.length; i++) {
    const z = zips[i];
    send(`Downloading ${z.name} (${i + 1}/${zips.length})…`);
    try {
      const buf = await fetchZipBuffer(z.raw_url, z.blobSha);
      const sqlEntries = await listSqlEntriesFromZip(buf, z.name);
      send(`Found ${sqlEntries.length} SQL in ${z.name}`);
      for (const entryName of sqlEntries) {
        const table = detectTableNameFromPaths(entryName, z.name);
        const group = assignGroup(table);
        catalog.push({
          table,
          group,
          fileName: `${z.name} :: ${entryName}`,
          path: `${z.path}::${entryName}`,
          zip: { name: z.name, path: z.path, blobSha: z.blobSha, raw_url: z.raw_url, commitSha },
          entryName
        });
      }
      if (sqlEntries.length === 0) send({ type: 'zipEmpty', zip: z.name });
    } catch (err) {
      send({ type: 'zipError', zip: z.name, error: String(err.message || err) });
    }
  }

  catalog.sort((a, b) => a.table.localeCompare(b.table));
  send({ type: 'done', tables: catalog.length, commitSha });
  return catalog;
}

/** Build a plan based on user selection and options (no SQL bodies) */
function buildUpdatePlan({
  catalog,
  selectedTables = [],
  selectedGroups = [],
  includeChars = false,
  mode = 'apply',      // 'apply' or 'replace'
  truncate = false     // TRUNCATE before inserts
}) {
  const tableSet = new Set(selectedTables.map(x => x.toLowerCase()));
  const groupSet = new Set(selectedGroups);

  let chosen = catalog.filter(row =>
    groupSet.has(row.group) || tableSet.has(row.table.toLowerCase())
  );
  const initiallyChosen = chosen.length;

  if (!includeChars) {
    const excluded = chosen.filter(r => DANGEROUS_TABLES.has(r.table)).map(r => r.table);
    if (excluded.length) logW('Excluding dangerous tables (enable includeChars to override):', excluded);
    chosen = chosen.filter(r => !DANGEROUS_TABLES.has(r.table));
  }

  const seen = new Set();
  const steps = [];
  for (const row of chosen) {
    if (seen.has(row.table)) continue;
    seen.add(row.table);

    steps.push({
      table: row.table,
      group: row.group,
      fileName: row.fileName,
      zip: row.zip,          // carry JIT fetch info
      entryName: row.entryName
      // NOTE: no SQL here; we'll fetch during apply
    });
  }

  logI('Plan:',
    'selectedTables=', selectedTables.length,
    'selectedGroups=', selectedGroups.length,
    'initialSteps=', initiallyChosen,
    'finalSteps=', steps.length,
    'mode=', mode,
    'truncate=', truncate,
    'includeChars=', includeChars
  );

  return { steps, options: { includeChars, mode, truncate } };
}

/** Use your existing world_db connection (callback API) */
function query(conn, sql, args = []) {
  return new Promise((resolve, reject) => {
    conn.query(sql, args, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

/** Pragmatic SQL splitter: handles quotes and other special characters*/
function splitSqlStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  let inS = false, inD = false, inLine = false, inBlock = false;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLine) { if (ch === '\n') { inLine = false; cur += ch; } else cur += ch; i++; continue; }
    if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; cur += '*/'; i += 2; continue; } cur += ch; i++; continue; }
    if (inS) { if (ch === '\\') { cur += ch + (sql[i + 1] || ''); i += 2; continue; } if (ch === '\'') inS = false; cur += ch; i++; continue; }
    if (inD) { if (ch === '\\') { cur += ch + (sql[i + 1] || ''); i += 2; continue; } if (ch === '"') inD = false; cur += ch; i++; continue; }

    if (ch === '-' && next === '-') { inLine = true; cur += '--'; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlock = true; cur += '/*'; i += 2; continue; }
    if (ch === '\'') { inS = true; cur += ch; i++; continue; }
    if (ch === '"')  { inD = true; cur += ch; i++; continue; }

    if (ch === ';') { out.push(cur + ';'); cur = ''; i++; continue; }

    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur);

  if (DEBUG) {
    logD('splitSqlStatements -> count:', out.length);
    out.slice(0, 3).forEach((s, idx) => logD(`stmt[${idx}] first80:`, s.trim().slice(0, 80)));
  }

  return out;
}

// ---- Error helpers and instrumented execution ----
function errMsg(e) {
  return (e && (e.message || e.sqlMessage)) || 'Unknown error';
}

function enrichSqlError(err, extra = {}) {
  const msg = [
    errMsg(err),
    extra.table && `table=${extra.table}`,
    Number.isFinite(extra.stmtIndex) && `stmtIndex=${extra.stmtIndex}`,
    extra.preview && `preview=${JSON.stringify(extra.preview)}`,
    err?.code && `code=${err.code}`,
    (err?.errno !== undefined) && `errno=${err.errno}`,
    err?.sqlState && `sqlState=${err.sqlState}`,
  ].filter(Boolean).join(' | ');

  const wrapped = new Error(msg);
  wrapped.code = err?.code;
  wrapped.errno = err?.errno;
  wrapped.sqlState = err?.sqlState;
  wrapped.original = err;
  wrapped.meta = { ...extra };
  return wrapped;
}

/** JIT: download a single SQL body for a plan step */
async function loadSqlForStep(step) {
  const { raw_url, blobSha } = step.zip || {};
  if (!raw_url || !blobSha) throw new Error(`Missing ZIP info for ${step.table}`);

  const buf = await fetchZipBuffer(raw_url, blobSha);
  const zip = await JSZip.loadAsync(buf);

  // Choose the matching entryName if present; otherwise first *.sql
  let file = null;
  if (step.entryName && zip.files[step.entryName]) {
    file = zip.files[step.entryName];
  } else {
    const names = Object.keys(zip.files).filter(k => /\.sql$/i.test(k));
    if (names.length) file = zip.files[names[0]];
  }
  if (!file || file.dir) throw new Error(`SQL entry not found in ${step.zip?.name}`);

  // Load as string (one file at a time — memory stays bounded)
  return await file.async('string');
}

/** Apply per-table SQL with options to the DB (TRUNCATE/REPLACE) */
function transformSqlForOptions(sql, table, options) {
  let out = sql;
  if (options.truncate) {
    out = `TRUNCATE TABLE \`${table}\`;\n` + out;
  }
  if (options.mode === 'replace') {
    out = out.replace(/\bINSERT\s+INTO\b/gi, 'REPLACE INTO');
  } else if (options.mode !== 'apply') {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }
  return out;
}

async function runSqlSafely(conn, sql) {
  const stmts = splitSqlStatements(sql);
  for (let i = 0; i < stmts.length; i++) {
    const s = (stmts[i] || '').trim();
    if (!s) continue;
    try {
      await query(conn, s);
    } catch (e) {
      const preview = s.replace(/\s+/g, ' ').slice(0, 300);
      throw enrichSqlError(e, { stmtIndex: i, preview });
    }
  }
}

/** Main executor: JIT loads one SQL at a time (low memory) */
async function applyPlan(world_db, plan, onLog) {
  const send = (msg) => { if (typeof onLog === 'function') onLog(msg); logI(msg); };
  const options = plan.options || { mode: 'apply', truncate: false };

  send('Disabling FOREIGN_KEY_CHECKS and starting TRANSACTION…');
  await query(world_db, 'SET FOREIGN_KEY_CHECKS=0;');
  await query(world_db, 'START TRANSACTION;');

  try {
    for (const step of plan.steps) {
      send(`Updating ${step.table} (${step.fileName})…`);

      // JIT download + transform + execute
      const rawSql = await loadSqlForStep(step);
      const sql = transformSqlForOptions(rawSql, step.table, options);

      try {
        await runSqlSafely(world_db, sql);
      } catch (e) {
        const meta = e.meta || {};
        // Ensure the client sees details in the log stream before throwing
        send(JSON.stringify({
          level: 'error',
          table: step.table,
          stmtIndex: Number.isFinite(meta.stmtIndex) ? meta.stmtIndex : undefined,
          preview: meta.preview,
          code: e.code, errno: e.errno, sqlState: e.sqlState,
          message: errMsg(e)
        }));
        throw enrichSqlError(e, { ...meta, table: step.table });
      }
    }

    send('Committing…');
    await query(world_db, 'COMMIT;');
  } catch (e) {
    logE('applyPlan error:', errMsg(e));
    try { await query(world_db, 'ROLLBACK;'); logW('Rolled back.'); } catch {}
    throw e;
  } finally {
    try { await query(world_db, 'SET FOREIGN_KEY_CHECKS=1;'); send('FOREIGN_KEY_CHECKS re-enabled.'); } catch {}
  }
}

module.exports = {
  fetchWorldTableCatalog,
  fetchWorldTableCatalogWithProgress,
  groupCatalog,
  buildUpdatePlan,
  applyPlan,
  DANGEROUS_TABLES
};
