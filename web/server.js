#!/usr/bin/env node
// Local web front-end for the AppBuilder build workflow.
//
// Reads the workflow inputs from .github/workflows/buildapp.yml and each app's
// manifest and registry from apps/<app>/, so those files stay the single source
// of truth. Serves a small UI that can dispatch the GitHub Actions workflow for
// one app set or emit an equivalent local build script. No runtime dependencies.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const WORKFLOW_REL = '.github/workflows/buildapp.yml';
const WORKFLOW_NAME = 'buildapp.yml';
const UPDATE_WORKFLOW_NAME = 'update-tweaks.yml';
const WORKFLOWS = {
  [WORKFLOW_NAME]: WORKFLOW_REL,
  [UPDATE_WORKFLOW_NAME]: '.github/workflows/update-tweaks.yml',
};
const CHECKER_REL = 'Tools/check-tweak-updates.py';
const UPDATE_CACHE_MS = 6 * 60 * 60 * 1000;
const APPS_DIR = 'apps';
const PREREQ_BINS = ['make', 'git', 'curl', 'unzip', 'ldid', 'dpkg', 'cyan', 'xcodebuild', 'python3'];
const TWEAK_INPUT = 'enabled_tweaks';
const MAX_BODY = 1 << 20;
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'server.log');

function log(kind, detail) {
  const line = `${new Date().toISOString()} [${kind}] ${detail}\n`;
  try { process.stderr.write(line); } catch { /* stderr already gone */ }
  try { appendFileSync(LOG_FILE, line); } catch { /* log file unwritable */ }
}

// A local server must not die from one bad request, a closed pipe, or a
// detached terminal. Log these paths and keep serving.
process.on('uncaughtException', (err) => log('uncaughtException', err?.stack || String(err)));
process.on('unhandledRejection', (err) => log('unhandledRejection', err?.stack || String(err)));
process.on('SIGHUP', () => log('signal', 'SIGHUP ignored'));
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// ---------------------------------------------------------------------------
// Workflow / Makefile parsing
// ---------------------------------------------------------------------------

function parseWorkflowInputs(yaml) {
  const inputs = {};
  let inInputs = false;
  let current = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (!inInputs) {
      if (/^ {4}inputs:\s*$/.test(line)) inInputs = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const name = /^ {6}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (name) {
      current = name[1];
      inputs[current] = { name: current, type: 'string', default: '', required: false, description: '' };
      continue;
    }
    if (!current) continue;
    const prop = /^ {8}(description|default|required|type):\s*(.*)$/.exec(line);
    if (!prop) continue;
    const [, key, rest] = prop;
    let raw = rest.trim();
    if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
      raw = raw.slice(1, -1);
    }
    if (key === 'default') {
      if (raw === 'true') inputs[current].default = true;
      else if (raw === 'false') inputs[current].default = false;
      else inputs[current].default = raw;
    } else if (key === 'required') {
      inputs[current].required = raw === 'true';
    } else if (key === 'type') {
      inputs[current].type = raw;
    } else {
      inputs[current].description = raw;
    }
  }
  return inputs;
}

// A makefile reader that understands the one pattern the app files use: a plain
// assignment sets a value, `+=` lines extend it. That is how an app's
// tweaks.json groups and the custom.mk append layer on top of registry.mk.
function readAssignments(text) {
  const joined = text.replace(/\\\r?\n[ \t]*/g, ' ');
  const lines = joined.split(/\r?\n/);
  return (name) => {
    const base = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const plain = new RegExp(`^${base}\\s*[:?]?=\\s*(.*)$`);
    const append = new RegExp(`^${base}\\s*\\+=\\s*(.*)$`);
    let value = null;
    for (const line of lines) {
      const added = append.exec(line);
      if (added) {
        value = `${value ?? ''} ${added[1].trim()}`.trim();
        continue;
      }
      const m = plain.exec(line);
      if (m && value === null) value = m[1].trim();
    }
    return value;
  };
}

const mkList = (v) => (v || '').split(/\s+/).filter(Boolean);

// Builds one entry of the config's `apps` array from apps/<id>/. The registry is
// the source of the tweak ids and their build wiring, app.json carries the
// manifest, payloads.mk the prebuilt .deb versions and custom.mk the tweaks that
// were added through the app. tweaks.json only decides the picker grouping.
async function buildApp(id) {
  const dir = path.join(REPO_ROOT, APPS_DIR, id);
  const read = (file) => readFile(path.join(dir, file), 'utf8').catch(() => '');
  const [manifestText, registry, payloads, custom, tweaksText] = await Promise.all([
    readFile(path.join(dir, 'app.json'), 'utf8').catch(() => '{}'),
    read('registry.mk'),
    read('payloads.mk'),
    read('custom.mk'),
    read('tweaks.json'),
  ]);
  const manifest = JSON.parse(manifestText);
  const readVar = readAssignments(`${registry}\n${custom}\n${payloads}`);

  const groups = [];
  const groupOf = new Map();
  try {
    for (const group of JSON.parse(tweaksText).groups || []) {
      if (!group || !group.name) continue;
      groups.push(group.name);
      for (const tweak of group.tweaks || []) groupOf.set(tweak, group.name);
    }
  } catch { /* tweaks.json is optional: every tweak then falls into "Other" */ }

  const registryIds = mkList(readVar('APP_TWEAK_REGISTRY'));
  const payloadIds = mkList(readVar('APP_PAYLOAD_TWEAKS'));
  const switchIds = mkList(readVar('APP_SWITCH_TWEAKS'));
  const customIds = new Set(mkList(readVar('CUSTOM_TWEAKS')));
  const defaults = new Set(mkList(readVar('APP_DEFAULT_TWEAKS')));
  const ids = [
    ...registryIds,
    ...payloadIds.filter((pid) => !registryIds.includes(pid)),
    ...switchIds.filter((sid) => !registryIds.includes(sid) && !payloadIds.includes(sid)),
  ];

  const tweaks = await Promise.all(ids.map(async (tweakId) => {
    const payload = payloadIds.includes(tweakId);
    // A switch compiles nothing; it only tells the build to do something.
    const isSwitch = switchIds.includes(tweakId);
    // Payload tweaks ship as prebuilt .debs, so their version lives in payloads.mk
    // under the mixed-case <id>_VERSION; submodules keep it in their control file.
    const control = payload || isSwitch ? {} : await readControl(tweakId);
    return {
      id: tweakId,
      payload,
      switch: isSwitch,
      default: defaults.has(tweakId),
      version: (payload ? readVar(`${tweakId}_VERSION`) : control.version) || null,
      dylib: readVar(`${tweakId}_DYLIB`) || null,
      subproject: readVar(`${tweakId}_SUBPROJECT`) || null,
      group: groupOf.get(tweakId) || null,
      custom: customIds.has(tweakId),
      name: control.name,
      description: control.description,
    };
  }));

  return {
    id: manifest.id || id,
    name: manifest.name || readVar('APP_NAME') || id,
    bundleIds: manifest.bundleIds || [readVar('APP_BUNDLE_ID')].filter(Boolean),
    tweaks,
    groups,
    defaults: [...defaults],
  };
}

async function listApps() {
  try {
    const entries = await readdir(path.join(REPO_ROOT, APPS_DIR), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function readControl(id) {
  try {
    const txt = await readFile(path.join(REPO_ROOT, 'Tweaks', id, 'control'), 'utf8');
    const field = (name) => {
      const m = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(txt);
      return m ? m[1].trim() : undefined;
    };
    return { name: field('Name'), version: field('Version'), description: field('Description') };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Environment introspection
// ---------------------------------------------------------------------------

async function readRepoInfo() {
  const info = { owner: null, repo: null, branch: null };
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT });
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(stdout.trim());
    if (m) {
      info.owner = m[1];
      info.repo = m[2];
    }
  } catch { /* no remote */ }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT });
    const branch = stdout.trim();
    if (branch && branch !== 'HEAD') info.branch = branch;
  } catch { /* detached */ }
  return info;
}

async function which(bin) {
  try {
    const { stdout } = await execFileAsync('sh', ['-c', `command -v ${bin}`]);
    return { name: bin, ok: true, detail: stdout.trim() };
  } catch {
    return { name: bin, ok: false, detail: null };
  }
}

async function findTheos() {
  const candidates = [process.env.THEOS, path.join(REPO_ROOT, '.theos'), path.join(homedir(), 'theos')].filter(Boolean);
  for (const dir of candidates) {
    try {
      const s = await stat(path.join(dir, 'makefiles', 'common.mk'));
      if (s.isFile()) return { ok: true, path: dir };
    } catch { /* keep looking */ }
  }
  return { ok: false, path: null };
}

// ---------------------------------------------------------------------------
// Config assembly
// ---------------------------------------------------------------------------

async function buildConfig() {
  const [workflowYaml, repo, theos, ...prereqs] = await Promise.all([
    readFile(path.join(REPO_ROOT, WORKFLOW_REL), 'utf8'),
    readRepoInfo(),
    findTheos(),
    ...PREREQ_BINS.map(which),
  ]);
  const inputs = parseWorkflowInputs(workflowYaml);
  const apps = (await Promise.all((await listApps()).map(buildApp))).filter(Boolean);
  // The workflow's default app_id leads the list, so the UI opens on the same
  // app a dispatch without an explicit choice would build.
  const preferred = typeof inputs.app_id?.default === 'string' ? inputs.app_id.default : '';
  apps.sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : a.id.localeCompare(b.id)));
  return {
    workflow: WORKFLOW_NAME,
    updateWorkflow: UPDATE_WORKFLOW_NAME,
    repo,
    inputs,
    tweakInput: TWEAK_INPUT,
    apps,
    prereqs,
    theos,
  };
}

// ---------------------------------------------------------------------------
// Input normalisation for dispatch / script generation
// ---------------------------------------------------------------------------

function normaliseTweaks(value, valid) {
  const raw = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  const seen = new Set();
  const out = [];
  for (const id of raw.split(/[\s,]+/).filter(Boolean)) {
    if (!valid.has(id)) throw new Error(`Unknown tweak id: ${id}`);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function findApp(config, submitted, specs) {
  const requested = String(submitted?.app_id ?? specs?.app_id?.default ?? '').trim();
  return config.apps.find((a) => a.id === requested) || config.apps[0] || null;
}

function resolveInputs(config, submitted, specs = config.inputs, { lenient = false } = {}) {
  const values = {};
  // Valid tweak ids come from the app the same submission selects: switching the
  // app in the UI must not let another app's tweak ids through.
  const app = findApp(config, submitted, specs);
  const validTweaks = new Set((app ? app.tweaks : []).map((t) => t.id));
  for (const [key, spec] of Object.entries(specs)) {
    if (key === config.tweakInput) {
      values[key] = normaliseTweaks(submitted?.[key], validTweaks).join(' ');
      continue;
    }
    const provided = submitted?.[key];
    const value = provided === undefined || provided === null || provided === '' ? spec.default : provided;
    if (spec.type === 'boolean') {
      values[key] = value === true || value === 'true' || value === '1' ? 'true' : 'false';
    } else {
      const str = value === undefined || value === null ? '' : String(value);
      if (spec.required && !lenient && str.trim() === '') throw new Error(`Missing required input: ${key}`);
      values[key] = str;
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function dispatchWorkflow({ token, owner, repo, ref, inputs, workflow = WORKFLOW_NAME }) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${workflow}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AppBuilder-WebUI',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref, inputs }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  return { status: res.status, ok: res.ok, body };
}

// ---------------------------------------------------------------------------
// Tweak updates
// ---------------------------------------------------------------------------

// The report is app-scoped, so cache one entry per selected app.
const updatesCache = new Map();

async function checkTweakUpdates({ token = '', refresh = false, app = '' } = {}) {
  const key = app || '';
  const cached = updatesCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < UPDATE_CACHE_MS) {
    return { ...cached.data, cached: true };
  }
  const args = [CHECKER_REL, '--json'];
  if (app) args.push('--app', app);
  const { stdout } = await execFileAsync('python3', args, {
    cwd: REPO_ROOT,
    maxBuffer: 32 << 20,
    timeout: 180000,
    // The token only raises the GitHub API rate limit; the check works without one.
    env: { ...process.env, GITHUB_TOKEN: token || process.env.GITHUB_TOKEN || '' },
  });
  const data = JSON.parse(stdout);
  updatesCache.set(key, { at: Date.now(), data });
  return data;
}

async function git(args) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: REPO_ROOT, maxBuffer: 32 << 20, timeout: 600000,
  });
  return `${stdout}${stderr}`.trim();
}

async function localDrift() {
  const drift = [];
  const status = await git(['status', '--porcelain', '--untracked-files=no']);
  if (status) drift.push('the working tree has local modifications');
  const dirty = (await git(['submodule', 'foreach', '--quiet',
    'test -z "$(git status --porcelain --untracked-files=no)" || echo "$sm_path"']))
    .split(/\s+/).filter(Boolean);
  if (dirty.length) drift.push(`submodules with local modifications: ${dirty.join(', ')}`);
  return drift;
}

// Pulls the repository and the tweak sources it pins, so the UI shows what the
// update workflow just pushed.
async function syncRepo() {
  const drift = await localDrift();
  if (drift.length) {
    throw new Error(`refusing to sync - ${drift.join('; ')}. Commit or stash them first.`);
  }
  const log = [await git(['fetch', '--prune', 'origin'])];
  try {
    log.push(await git(['pull', '--ff-only']));
  } catch (err) {
    log.push(`git pull skipped: ${(err.stderr || err.message || '').trim()}`);
  }
  log.push(await git(['submodule', 'sync', '--recursive']));
  log.push(await git(['submodule', 'update', '--init', '--recursive']));
  updatesCache.clear();
  return log.filter(Boolean).join('\n');
}

function shq(value) {
  return `"${String(value).replace(/[\\$"`]/g, (c) => `\\${c}`)}"`;
}

function buildLocalScript(values) {
  // Only forward the overrides the user actually set; an empty BUNDLE_ID on the
  // make command line would beat the Makefile's fallback to the app registry.
  const makeArgs = [];
  if (values.sdk_version) makeArgs.push(`  SDK_VERSION=${shq(values.sdk_version)}`);
  if (values.bundle_id) makeArgs.push(`  BUNDLE_ID=${shq(values.bundle_id)}`);
  if (values.app_name) makeArgs.push(`  DISPLAY_NAME=${shq(values.app_name)}`);
  if (values.ipa_prefix) makeArgs.push(`  IPA_PREFIX=${shq(values.ipa_prefix)}`);
  makeArgs.push('  ENABLED_TWEAKS="$ENABLED_TWEAKS"');
  return `#!/usr/bin/env bash
# Generated by the AppBuilder web UI. Mirrors .github/workflows/${WORKFLOW_NAME}.
# Requires: Theos (THEOS), make, curl, unzip, ldid, dpkg.
set -euo pipefail

export THEOS=\${THEOS:-$HOME/theos}
APP=${shq(values.app_id)}
IPA_URL=${shq(values.decrypted_ipa_url)}
ENABLED_TWEAKS=${shq(values.enabled_tweaks)}

command -v make >/dev/null || { echo "error: make not found" >&2; exit 1; }
[ -f "$THEOS/makefiles/common.mk" ] || { echo "error: Theos not found at $THEOS" >&2; exit 1; }
[ -n "$IPA_URL" ] || { echo "error: decrypted_ipa_url is empty" >&2; exit 1; }

git submodule update --init --recursive

# Unpack into a scratch dir: the IPA URL is only a hash in app.json, so there is
# no local file to reuse, and the app bundle inside is whatever the IPA carries.
IPA_TMP="$(mktemp -d)"
trap 'rm -rf "$IPA_TMP"' EXIT
curl -fsSL "$IPA_URL" -o "$IPA_TMP/app.ipa"
unzip -q "$IPA_TMP/app.ipa" -d "$IPA_TMP"
APP_BUNDLE="$(find "$IPA_TMP/Payload" -maxdepth 1 -name '*.app' -type d | head -n1)"
[ -n "$APP_BUNDLE" ] || { echo "error: no .app bundle inside the IPA Payload/" >&2; exit 1; }
APP_VERSION=$(defaults read "$APP_BUNDLE/Info" CFBundleVersion)
echo "$APP version: $APP_VERSION"

make package THEOS_PACKAGE_SCHEME=rootless IPA="$APP_BUNDLE" FINALPACKAGE=1 APP="$APP" \\
${makeArgs.join(' \\\n')}

echo "Built: $(ls -t packages | head -n1)"
`;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(req, res, pathname) {
  if (res.writableEnded || res.destroyed) return;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/config') {
    sendJson(res, 200, await buildConfig());
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/updates') {
    const body = await readBody(req);
    sendJson(res, 200, await checkTweakUpdates({
      token: (body.token || '').trim(),
      refresh: Boolean(body.refresh),
      app: (body.app || '').trim(),
    }));
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/sync') {
    sendJson(res, 200, { ok: true, output: await syncRepo() });
    return true;
  }
  if (req.method === 'POST' && (pathname === '/api/dispatch' || pathname === '/api/local-script')) {
    const body = await readBody(req);
    const config = await buildConfig();
    if (pathname === '/api/local-script') {
      // The script carries its own guards for missing values, so an incomplete
      // form still yields a runnable skeleton to inspect or edit.
      sendJson(res, 200, { script: buildLocalScript(resolveInputs(config, body.inputs, config.inputs, { lenient: true })) });
      return true;
    }
    const workflow = (body.workflow || WORKFLOW_NAME).trim();
    const rel = WORKFLOWS[workflow];
    if (!rel) throw new Error(`Unknown workflow: ${workflow}`);
    const specs = rel === WORKFLOW_REL
      ? config.inputs
      : parseWorkflowInputs(await readFile(path.join(REPO_ROOT, rel), 'utf8'));
    const values = resolveInputs(config, body.inputs, specs);
    const token = (body.token || process.env.GITHUB_TOKEN || '').trim();
    const owner = (body.owner || config.repo.owner || '').trim();
    const repo = (body.repo || config.repo.repo || '').trim();
    const ref = (body.ref || config.repo.branch || 'main').trim();
    if (!token) throw new Error('A GitHub token is required to dispatch the workflow');
    if (!owner || !repo) throw new Error('GitHub owner/repository could not be determined');
    const result = await dispatchWorkflow({ token, owner, repo, ref, inputs: values, workflow });
    sendJson(res, result.ok ? 200 : 502, {
      ok: result.ok,
      status: result.status,
      workflow,
      message: result.ok
        ? `Workflow ${workflow} dispatched on ${owner}/${repo}@${ref}.`
        : result.status === 404
          // GitHub only resolves workflows that exist on the default branch; the
          // ref then decides which revision of the file actually runs.
          ? `${workflow} is not dispatchable on ${owner}/${repo}: GitHub only knows workflows that exist on the default branch. Add the file there, or merge the branch that carries it. GitHub said: ${result.body.slice(0, 300)}`
          : `GitHub responded ${result.status}: ${result.body.slice(0, 500)}`,
      runsUrl: `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`,
    });
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  let pathname = '/';
  req.on('error', (err) => log('request', err.message));
  res.on('error', (err) => log('response', err.message));
  res.on('close', () => {
    if (!res.writableEnded) log('request', `${req.method} ${pathname} aborted by client`);
  });
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    if (pathname.startsWith('/api/')) {
      if (await handleApi(req, res, pathname)) return;
      sendJson(res, 404, { error: 'Unknown endpoint' });
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    log('handler', `${req.method} ${pathname}: ${err.stack || err}`);
    try {
      if (!res.writableEnded && !res.destroyed) {
        if (pathname.startsWith('/api/')) sendJson(res, 400, { error: err.message });
        else {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Internal error: ${err.message}`);
        }
      }
    } catch (nested) {
      log('handler', `could not send error response: ${nested.message}`);
    }
  }
});

server.on('clientError', (err, socket) => {
  log('clientError', err.code || err.message);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
server.on('error', (err) => log('server', err.stack || err.message));

server.headersTimeout = 20000;
server.requestTimeout = 60000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, () => {
  console.log(`AppBuilder web UI: http://${HOST}:${PORT}`);
  console.log(`Repository: ${REPO_ROOT}`);
  log('start', `listening on ${HOST}:${PORT}`);
});
