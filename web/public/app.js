const output = document.getElementById('output');
const form = document.getElementById('build-form');
const dispatchBtn = document.getElementById('dispatch');
const scriptBtn = document.getElementById('script');
const scriptActions = document.getElementById('script-actions');
const checkBtn = document.getElementById('check-updates');
const updateBtn = document.getElementById('update-tweaks');
const syncBtn = document.getElementById('sync');
const updateSummary = document.getElementById('update-summary');
const appSelect = document.getElementById('app-select');

let config = null;
let updates = null;
let currentScript = '';

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function setOutput(text, cls = '') {
  output.textContent = text;
  output.className = cls;
}

// The app whose tweaks the picker and the dispatch describe. The server orders
// the list so apps[0] is the workflow default, which is also the first option.
function currentApp() {
  const id = appSelect.value || (config.apps[0] && config.apps[0].id);
  return config.apps.find((a) => a.id === id) || config.apps[0] || null;
}

function tweakBoxes() {
  return [...document.querySelectorAll('#tweak-groups input[data-tweak]')];
}

function updateCount() {
  const boxes = tweakBoxes();
  const count = document.getElementById('tweak-count');
  count.textContent = boxes.length ? `${boxes.filter((b) => b.checked).length} / ${boxes.length} selected` : '';
}

function renderPrereqs() {
  const list = document.getElementById('prereqs');
  list.replaceChildren();
  const items = config.prereqs.map((p) => ({ label: p.name, ok: p.ok, title: p.detail || 'not found' }));
  items.push({ label: 'Theos', ok: config.theos.ok, title: config.theos.path || 'not found (set $THEOS)' });
  for (const item of items) {
    list.append(h('li', { class: item.ok ? 'ok' : 'bad', title: item.title, text: `${item.ok ? '\u2713' : '\u2717'} ${item.label}` }));
  }
}

function renderApps() {
  appSelect.replaceChildren();
  for (const app of config.apps) {
    appSelect.append(h('option', { value: app.id, text: app.name }));
  }
  appSelect.value = currentApp() ? currentApp().id : '';
}

function renderInputs() {
  const wrap = document.getElementById('inputs');
  wrap.replaceChildren();
  for (const [key, spec] of Object.entries(config.inputs)) {
    // app_id is driven by the app selector; enabled_tweaks by the tweak picker.
    if (key === config.tweakInput || key === 'app_id') continue;
    const id = `input-${key}`;
    const desc = spec.description ? h('span', { class: 'desc', text: spec.description }) : null;
    if (spec.type === 'boolean') {
      const box = h('input', { type: 'checkbox', id });
      box.checked = Boolean(spec.default);
      box.dataset.key = key;
      box.dataset.kind = 'boolean';
      wrap.append(h('div', { class: 'field check' }, [box, h('label', { for: id, text: key }), desc]));
    } else {
      const input = h('input', { type: key === 'decrypted_ipa_url' ? 'url' : 'text', id, value: spec.default ?? '' });
      input.dataset.key = key;
      input.dataset.kind = 'string';
      wrap.append(h('div', { class: 'field' }, [h('label', { for: id, text: spec.required ? `${key} *` : key }), input, desc]));
    }
  }
}

function updateFor(id) {
  return (updates && updates.tweaks ? updates.tweaks : []).find((t) => t.id === id) || null;
}

// Splits an app's tweaks into display groups: the app's tweaks.json order, then a
// Custom group for tweaks added through the app, then everything unlisted.
function appGroups(app) {
  const named = new Map(app.groups.map((name) => [name, []]));
  const custom = [];
  const other = [];
  for (const tweak of app.tweaks) {
    if (tweak.custom) custom.push(tweak);
    else if (tweak.group && named.has(tweak.group)) named.get(tweak.group).push(tweak);
    else other.push(tweak);
  }
  const groups = [...named].filter(([, list]) => list.length).map(([name, tweaks]) => ({ name, tweaks }));
  if (custom.length) groups.push({ name: 'Custom', tweaks: custom });
  if (other.length) groups.push({ name: 'Other', tweaks: other });
  return groups;
}

function tweakLabel(tweak, selected) {
  const box = h('input', { type: 'checkbox' });
  box.checked = selected ? selected.has(tweak.id) : tweak.default;
  box.dataset.tweak = tweak.id;
  box.addEventListener('change', updateCount);
  const info = updateFor(tweak.id);
  const meta = [tweak.dylib, tweak.version].filter(Boolean).join(' \u00b7 ');
  const badge = info && info.outdated
    ? h('a', {
      class: 'badge outdated',
      href: info.url || '#',
      target: '_blank',
      rel: 'noreferrer',
      title: `${tweak.id}: ${info.local_version} -> ${info.upstream_version} (${info.url || 'no upstream url'})`,
      text: `${info.local_version} \u2192 ${info.upstream_version}`,
    })
    // The badge sits inside the label, which would toggle the checkbox.
    : null;
  if (badge) badge.addEventListener('click', (event) => event.stopPropagation());
  return h('label', { class: 'tweak', title: info && info.note ? info.note : tweak.description || '' }, [
    box,
    h('span', {}, [
      h('span', { class: 'id', text: tweak.id }),
      meta ? h('span', { class: 'meta', text: `  ${meta}` }) : null,
      badge,
    ]),
  ]);
}

function renderTweaks({ keepSelection = false } = {}) {
  const wrap = document.getElementById('tweak-groups');
  const selected = keepSelection ? new Set(tweakBoxes().filter((b) => b.checked).map((b) => b.dataset.tweak)) : null;
  wrap.replaceChildren();
  const app = currentApp();
  if (!app || app.tweaks.length === 0) {
    // Mirror the iOS app: this app has no tweaks in the repo, and the only way to
    // get some is the add-tweak button that appends to apps/<app>/custom.mk.
    wrap.append(h('p', { class: 'hint empty', text: 'No tweaks in the repo for this app \u2014 add some via the + button.' }));
    updateCount();
    return;
  }
  for (const group of appGroups(app)) {
    wrap.append(h('h3', { text: group.name }));
    const grid = h('div', { class: 'tweaks' });
    for (const tweak of group.tweaks) grid.append(tweakLabel(tweak, selected));
    wrap.append(grid);
  }
  updateCount();
}

function renderUpdateSummary() {
  if (!updates) {
    updateSummary.textContent = 'Update check failed.';
    return;
  }
  const when = String(updates.checked_at || '').replace('T', ' ').replace('Z', ' UTC');
  const parts = [updates.outdated.length
    ? `${updates.outdated.length} outdated: ${updates.outdated.join(', ')}`
    : `all ${updates.tweaks.length} tweaks up to date`];
  const support = updates.outdated_support || [];
  if (support.length) parts.push(`shared modules behind: ${support.join(', ')}`);
  if (updates.offline) parts.push('check incomplete - some repositories were unreachable');
  if (when) parts.push(`checked ${when}${updates.cached ? ' (cached)' : ''}`);
  updateSummary.textContent = parts.join(' \u00b7 ');
}

function renderTarget() {
  const wrap = document.getElementById('target');
  wrap.replaceChildren();
  const fields = [
    ['owner', 'Owner', config.repo.owner || '', false],
    ['repo', 'Repository', config.repo.repo || '', false],
    ['ref', 'Git ref', config.repo.branch || 'main', false],
    ['token', 'GitHub token', '', true],
  ];
  for (const [key, label, value, secret] of fields) {
    const input = h('input', { type: secret ? 'password' : 'text', id: `target-${key}`, value });
    input.dataset.target = key;
    wrap.append(h('div', { class: 'field' }, [h('label', { for: `target-${key}`, text: label }), input]));
  }
}

function collectTarget() {
  const target = {};
  for (const el of document.querySelectorAll('#target [data-target]')) target[el.dataset.target] = el.value;
  return target;
}

function collect() {
  const inputs = {};
  for (const el of document.querySelectorAll('#inputs [data-key]')) {
    inputs[el.dataset.key] = el.dataset.kind === 'boolean' ? el.checked : el.value;
  }
  inputs.app_id = currentApp() ? currentApp().id : '';
  inputs[config.tweakInput] = tweakBoxes().filter((b) => b.checked).map((b) => b.dataset.tweak);
  return { inputs, target: collectTarget() };
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

function selectedAppId() {
  return currentApp() ? currentApp().id : '';
}

async function checkUpdates(refresh = false) {
  updateSummary.textContent = 'Checking upstream versions\u2026';
  try {
    updates = await post('/api/updates', {
      token: document.getElementById('target-token')?.value || '',
      refresh,
      app: selectedAppId(),
    });
  } catch (err) {
    updates = null;
    updateSummary.textContent = `Update check failed: ${err.message}`;
    return;
  }
  renderTweaks({ keepSelection: true });
  renderUpdateSummary();
}

async function reloadConfig() {
  const fresh = await (await fetch('/api/config')).json();
  const previous = selectedAppId();
  config = fresh;
  renderPrereqs();
  renderApps();
  if (config.apps.some((a) => a.id === previous)) appSelect.value = previous;
  renderTweaks({ keepSelection: true });
}

appSelect.addEventListener('change', async () => {
  // Tweak ids are app-scoped, so a stale selection and a stale update report must
  // both be discarded when the app changes.
  updates = null;
  renderTweaks();
  renderUpdateSummary();
  await checkUpdates(true);
});

document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const preset = button.dataset.preset;
    const app = currentApp();
    for (const box of tweakBoxes()) {
      const tweak = app.tweaks.find((t) => t.id === box.dataset.tweak);
      box.checked = preset === 'all' ? true : preset === 'none' ? false : Boolean(tweak && tweak.default);
    }
    updateCount();
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { inputs, target } = collect();
  dispatchBtn.disabled = true;
  scriptActions.hidden = true;
  setOutput('Dispatching workflow\u2026');
  try {
    const data = await post('/api/dispatch', { ...target, inputs });
    setOutput(`${data.message}\n\nWatch progress: ${data.runsUrl}`, 'ok');
  } catch (err) {
    setOutput(`Error: ${err.message}`, 'error');
  } finally {
    dispatchBtn.disabled = false;
  }
});

scriptBtn.addEventListener('click', async () => {
  const { inputs } = collect();
  scriptBtn.disabled = true;
  scriptActions.hidden = true;
  setOutput('Generating script\u2026');
  try {
    const data = await post('/api/local-script', { inputs });
    currentScript = data.script;
    setOutput(data.script);
    scriptActions.hidden = false;
  } catch (err) {
    setOutput(`Error: ${err.message}`, 'error');
  } finally {
    scriptBtn.disabled = false;
  }
});

checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  try {
    await checkUpdates(true);
  } finally {
    checkBtn.disabled = false;
  }
});

updateBtn.addEventListener('click', async () => {
  if (!updates || !Array.isArray(updates.outdated)) {
    setOutput('Run a version check first.', 'error');
    return;
  }
  const ids = updates.outdated;
  if (!ids.length) {
    setOutput('Nothing to update - every tweak is up to date.', 'ok');
    return;
  }
  // The server falls back to $GITHUB_TOKEN, so an empty field is fine here.
  const target = collectTarget();
  const branch = target.ref || 'the branch';
  if (!confirm(`Update ${ids.length} tweak(s) of ${selectedAppId()} on GitHub?\n\n${ids.join(', ')}\n\n` +
    `The workflow bumps the sources, compiles the bumped tweaks and pushes to ${branch}.`)) return;
  updateBtn.disabled = true;
  setOutput(`Dispatching ${config.updateWorkflow}\u2026`);
  try {
    const data = await post('/api/dispatch', {
      ...target,
      workflow: config.updateWorkflow,
      inputs: {
        app: selectedAppId(),
        only: ids.join(' '),
        include_payload: true,
        include_support: true,
        verify: true,
        push: true,
      },
    });
    setOutput(`${data.message}\n\nWatch progress: ${data.runsUrl}\n\n` +
      'When it finished, use "Sync repository" and then dispatch a build.', 'ok');
  } catch (err) {
    setOutput(`Error: ${err.message}`, 'error');
  } finally {
    updateBtn.disabled = false;
  }
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  setOutput('Syncing repository\u2026');
  try {
    const data = await post('/api/sync', {});
    setOutput(`Repository synced.\n\n${data.output}`, 'ok');
    await reloadConfig();
    await checkUpdates(true);
  } catch (err) {
    setOutput(`Error: ${err.message}`, 'error');
  } finally {
    syncBtn.disabled = false;
  }
});

document.getElementById('download').addEventListener('click', () => {
  const blob = new Blob([currentScript], { type: 'text/x-shellscript' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: 'build-swing.sh' });
  link.click();
  URL.revokeObjectURL(url);
});

document.getElementById('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(currentScript);
  setOutput(currentScript);
});

try {
  config = await (await fetch('/api/config')).json();
  document.getElementById('workflow-name').textContent = config.workflow;
  renderPrereqs();
  renderApps();
  renderInputs();
  renderTweaks();
  renderTarget();
  setOutput('Ready. Pick an app and its tweaks, then dispatch a GitHub Actions build or generate a local build script.');
  // The version check talks to GitHub, so it runs after the UI is usable.
  checkUpdates(false);
} catch (err) {
  setOutput(`Failed to load configuration: ${err.message}`, 'error');
}
