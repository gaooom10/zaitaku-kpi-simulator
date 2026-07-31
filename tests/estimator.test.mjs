import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

assert.equal(scripts.length, 1, 'index.html must contain one inline script');
const appScript = scripts[0][1];

class FakeClassList {
  constructor(element, initial = '') {
    this.element = element;
    this.names = new Set(initial.split(/\s+/).filter(Boolean));
  }

  contains(name) {
    return this.names.has(name);
  }

  add(...names) {
    names.forEach(name => this.names.add(name));
    this.sync();
  }

  remove(...names) {
    names.forEach(name => this.names.delete(name));
    this.sync();
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.names.has(name) : Boolean(force);
    if (enabled) this.names.add(name);
    else this.names.delete(name);
    this.sync();
    return enabled;
  }

  replace(oldName, newName) {
    if (!this.names.delete(oldName)) return false;
    this.names.add(newName);
    this.sync();
    return true;
  }

  sync() {
    this.element._className = [...this.names].join(' ');
  }
}

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = Boolean(options.bubbles);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeElement {
  constructor(ownerDocument, { id = '', tagName = 'DIV', className = '' } = {}) {
    this.ownerDocument = ownerDocument;
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.parentElement = null;
    this.value = '';
    this._textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.scrollLeft = 0;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this._innerHTML = '';
    this._className = className;
    this.classList = new FakeClassList(this, className);
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value);
    this.classList = new FakeClassList(this, this._className);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this._textContent = '';
    this.children = [];
    this.ownerDocument.registerDynamicMarkup(this, this._innerHTML);
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this._innerHTML = this._textContent;
    this.children = [];
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter(candidate => candidate !== listener));
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event);
    if (event.bubbles && this.parentElement) this.parentElement.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  querySelectorAll(selector) {
    if (selector === 'input') {
      return this.children.filter(child => child.tagName === 'INPUT');
    }
    if (selector === '[data-del]') {
      return this.children.filter(child => Object.hasOwn(child.dataset, 'del'));
    }
    return [];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  replaceChildren(...children) {
    this._innerHTML = '';
    this._textContent = '';
    this.children = children;
    for (const child of children) child.parentElement = this;
  }

  setAttribute(name, value) {
    const stringValue = String(value);
    this.attributes.set(name, stringValue);
    if (name === 'class') this.className = stringValue;
    if (name === 'disabled') this.disabled = true;
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = stringValue;
    }
  }

  getAttribute(name) {
    if (name === 'class') return this.className;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'disabled') this.disabled = false;
    if (name === 'hidden') this.hidden = false;
  }
}

class FakeDocument {
  constructor(markup) {
    this.elements = new Map();
    this.selectorElements = new Map();
    this.tableWrapper = new FakeElement(this, { className: 'tblwrap' });
    this.registerStaticMarkup(markup);
    for (const group of ['mode', 'dep', 'kyoka', 'jujitsu', 'pricemode', 'estmode', 'span']) {
      this.registerButtonGroup(markup, group);
    }
  }

  registerStaticMarkup(markup) {
    for (const match of markup.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
      const [, tagName, attributes, id] = match;
      const element = new FakeElement(this, {
        id,
        tagName,
        className: this.attributeValue(attributes, 'class') ?? '',
      });
      element.value = this.attributeValue(attributes, 'value') ?? '';
      this.applyDataAttributes(element, attributes);
      this.elements.set(id, element);
    }
  }

  registerButtonGroup(markup, containerId) {
    const container = markup.match(
      new RegExp(`<div\\b[^>]*\\bid="${containerId}"[^>]*>([\\s\\S]*?)<\\/div>`, 'i'),
    );
    const buttons = [];
    for (const match of (container?.[1] ?? '').matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const [, attributes, content] = match;
      const element = new FakeElement(this, {
        tagName: 'BUTTON',
        className: this.attributeValue(attributes, 'class') ?? '',
      });
      element.textContent = content.replace(/<[^>]+>/g, '').trim();
      this.applyDataAttributes(element, attributes);
      buttons.push(element);
    }
    this.selectorElements.set(`#${containerId} button`, buttons);
  }

  registerDynamicMarkup(parent, markup) {
    for (const match of markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
      const [, tagName, attributes] = match;
      const id = this.attributeValue(attributes, 'id') ?? '';
      const element = new FakeElement(this, {
        id,
        tagName,
        className: this.attributeValue(attributes, 'class') ?? '',
      });
      element.value = this.attributeValue(attributes, 'value') ?? '';
      element.parentElement = parent;
      this.applyDataAttributes(element, attributes);
      parent.children.push(element);
      if (id) this.elements.set(id, element);
    }
  }

  applyDataAttributes(element, attributes) {
    for (const match of attributes.matchAll(/\bdata-([\w-]+)="([^"]*)"/gi)) {
      const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      element.dataset[key] = match[2];
    }
  }

  attributeValue(attributes, name) {
    const match = attributes.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
    return match?.[1];
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }

  querySelectorAll(selector) {
    return this.selectorElements.get(selector) ?? [];
  }

  querySelector(selector) {
    return selector === '.tblwrap' ? this.tableWrapper : null;
  }
}

function loadApplication() {
  const document = new FakeDocument(html);
  const sandbox = {
    console,
    document,
    Event: FakeEvent,
    requestAnimationFrame: callback => callback(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(appScript, context, { filename: 'index.html' });
  return { context, document };
}

function publicFunction(context, name) {
  const value = vm.runInContext(`typeof ${name} === 'function' ? ${name} : undefined`, context);
  assert.equal(typeof value, 'function', `${name} must be a public function in index.html`);
  return value;
}

function assertInvalid(result, expectedCode) {
  assert.equal(result?.ok, false);
  assert.equal(result?.code, expectedCode);
}

function assertClose(actual, expected, message) {
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-12);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test('document declares UTF-8 before browser content is decoded', () => {
  assert.match(html.slice(0, 1024), /<meta\s+charset=["']?utf-8["']?/i);
});

function markEstimateAsVisible(document) {
  const output = document.getElementById('estout');
  output.className = 'estout show';
  output.innerHTML = '<button id="applymu">適用</button><button id="applypt">反映</button>';
  return output;
}

function assertEstimateIsInvalidated(output) {
  assert.equal(output.classList.contains('show'), false);
  assert.equal(output.innerHTML, '');
}

test('solveEstimate rejects an all-zero dataset as insufficient data', () => {
  const { context } = loadApplication();
  const solveEstimate = publicFunction(context, 'solveEstimate');

  const result = solveEstimate({
    mode: 'simple',
    previousPatients: 0,
    currentPatients: 0,
    annualNewPatients: 0,
  });

  assertInvalid(result, 'insufficient-data');
});

test('solveEstimate treats current patients without any source population as inconsistent', () => {
  const { context } = loadApplication();
  const solveEstimate = publicFunction(context, 'solveEstimate');

  const result = solveEstimate({
    mode: 'simple',
    previousPatients: 0,
    currentPatients: 1,
    annualNewPatients: 0,
  });

  assertInvalid(result, 'inconsistent-input');
});

test('solveEstimate rejects patient counts that cannot be produced by the inputs', () => {
  const { context } = loadApplication();
  const solveEstimate = publicFunction(context, 'solveEstimate');

  const result = solveEstimate({
    mode: 'simple',
    previousPatients: 80,
    currentPatients: 201,
    annualNewPatients: 120,
  });

  assertInvalid(result, 'inconsistent-input');
});

test('solveEstimate rejects malformed estimator inputs', async t => {
  const { context } = loadApplication();
  const solveEstimate = publicFunction(context, 'solveEstimate');
  const cases = [
    {
      name: 'negative patient count',
      input: { mode: 'simple', previousPatients: -1, currentPatients: 20, annualNewPatients: 10 },
    },
    {
      name: 'fractional patient count',
      input: { mode: 'simple', previousPatients: 10, currentPatients: 20.5, annualNewPatients: 10 },
    },
    {
      name: 'infinite annual intake',
      input: { mode: 'simple', previousPatients: 10, currentPatients: 20, annualNewPatients: Infinity },
    },
    {
      name: 'unsafe integer patient count',
      input: {
        mode: 'simple',
        previousPatients: Number.MAX_SAFE_INTEGER + 1,
        currentPatients: 20,
        annualNewPatients: 10,
      },
    },
    {
      name: 'monthly intake with only 11 values',
      input: {
        mode: 'monthly',
        previousPatients: 10,
        currentPatients: 20,
        monthlyNewPatients: Array(11).fill(1),
      },
    },
    {
      name: 'monthly intake whose total exceeds the safe integer range',
      input: {
        mode: 'monthly',
        previousPatients: 0,
        currentPatients: 20,
        monthlyNewPatients: Array(12).fill(Number.MAX_SAFE_INTEGER),
      },
    },
  ];

  for (const { name, input } of cases) {
    await t.test(name, () => assertInvalid(solveEstimate(input), 'invalid-input'));
  }
});

test('solveEstimate distinguishes a valid dataset whose solution is outside 3 to 60 months', () => {
  const { context } = loadApplication();
  const solveEstimate = publicFunction(context, 'solveEstimate');

  const result = solveEstimate({
    mode: 'simple',
    previousPatients: 100,
    currentPatients: 99,
    annualNewPatients: 0,
  });

  assertInvalid(result, 'out-of-range');
});

test('out-of-range guidance is limited to this model and names alternative causes', () => {
  const { context } = loadApplication();
  const estimateErrorMessage = publicFunction(context, 'estimateErrorMessage');

  for (const direction of ['below', 'above']) {
    const message = estimateErrorMessage({ code: 'out-of-range', direction });
    assert.match(message, /この残存モデル/);
    assert.match(message, /入力・集計定義やモデル前提/);
    assert.doesNotMatch(message, /平均診療期間が/);
  }
});

test('solveEstimate recovers a known 12-month simple-model fixture', () => {
  const { context } = loadApplication();
  const solveEstimate = publicFunction(context, 'solveEstimate');

  const result = solveEstimate({
    mode: 'simple',
    previousPatients: 80,
    currentPatients: 127,
    annualNewPatients: 120,
  });

  assert.equal(result?.ok, true);
  assert.ok(Math.abs(result.mu - 12) < 0.2, `expected about 12 months, got ${result.mu}`);
  assert.equal(result.nearest, 12);
});

test('monthly 12 x 10 intake produces the same estimate as annual intake 120', () => {
  const { context } = loadApplication();
  const solveEstimate = publicFunction(context, 'solveEstimate');
  const shared = { previousPatients: 80, currentPatients: 127 };
  const simple = solveEstimate({ ...shared, mode: 'simple', annualNewPatients: 120 });
  const monthly = solveEstimate({
    ...shared,
    mode: 'monthly',
    monthlyNewPatients: Array(12).fill(10),
  });

  assert.equal(simple.ok, true);
  assert.equal(monthly.ok, true);
  assert.ok(Math.abs(simple.mu - monthly.mu) < 1e-9);
  assert.equal(monthly.nearest, simple.nearest);
});

test('invalidateEstimate clears stale results and every estimator input invokes it', () => {
  const { context, document } = loadApplication();
  const invalidateEstimate = publicFunction(context, 'invalidateEstimate');
  const renderMonths = publicFunction(context, 'renderMonths');

  const output = markEstimateAsVisible(document);
  invalidateEstimate();
  assertEstimateIsInvalidated(output);

  for (const id of ['e-prev', 'e-new', 'e-now']) {
    markEstimateAsVisible(document);
    document.getElementById(id).dispatchEvent(new FakeEvent('input', { bubbles: true }));
    assertEstimateIsInvalidated(output);
  }

  renderMonths();
  for (let index = 0; index < 12; index++) {
    markEstimateAsVisible(document);
    document.getElementById(`em-${index}`).dispatchEvent(new FakeEvent('input', { bubbles: true }));
    assertEstimateIsInvalidated(output);
  }
});

test('estimator mode buttons invalidate results and retain monthly input listeners', () => {
  const { document } = loadApplication();
  const output = markEstimateAsVisible(document);
  const modeButtons = document.querySelectorAll('#estmode button');
  const monthly = modeButtons.find(button => button.dataset.e === 'monthly');
  const simple = modeButtons.find(button => button.dataset.e === 'simple');
  assert.ok(monthly);
  assert.ok(simple);

  monthly.dispatchEvent(new FakeEvent('click'));
  assertEstimateIsInvalidated(output);
  assert.equal(document.getElementById('e-months').querySelectorAll('input').length, 12);

  markEstimateAsVisible(document);
  document.getElementById('em-11').dispatchEvent(new FakeEvent('input'));
  assertEstimateIsInvalidated(output);

  markEstimateAsVisible(document);
  simple.dispatchEvent(new FakeEvent('click'));
  assertEstimateIsInvalidated(output);
});

test('a previously captured apply action cannot use a result after estimator input changes', () => {
  const { context, document } = loadApplication();
  const estimate = publicFunction(context, 'estimate');
  document.getElementById('e-prev').value = '80';
  document.getElementById('e-new').value = '120';
  document.getElementById('e-now').value = '127';
  estimate();

  const staleApplyMu = document.getElementById('applymu');
  const staleApply = document.getElementById('applypt');
  assert.ok(staleApplyMu, 'a valid estimate must expose the duration apply action');
  assert.ok(staleApply, 'a valid estimate must expose the apply action');

  document.getElementById('e-now').value = '50';
  document.getElementById('e-now').dispatchEvent(new FakeEvent('input', { bubbles: true }));
  vm.runInContext('state.mu = 6', context);
  const before = vm.runInContext('[state.home, state.fac, state.mode, state.mu]', context);
  staleApplyMu.dispatchEvent(new FakeEvent('click'));
  staleApply.dispatchEvent(new FakeEvent('click'));

  const after = vm.runInContext('[state.home, state.fac, state.mode, state.mu]', context);
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.equal(after[2], before[2]);
  assert.equal(after[3], 6);
});

test('render uses a dash instead of NaN for revenue shares when revenue is zero', () => {
  const { context, document } = loadApplication();
  vm.runInContext('state.new = 0; state.home = 0; state.fac = 0; state.events = []; render()', context);

  assert.equal(document.getElementById('t-med-pct').textContent, '–');
  assert.equal(document.getElementById('t-kaigo-pct').textContent, '–');
});

test('renderEvents rounds and clamps event inputs without replacing state on blank input', () => {
  const { context, document } = loadApplication();
  const renderEvents = publicFunction(context, 'renderEvents');
  vm.runInContext('state.events = [{month: 6, delta: 3}]', context);
  renderEvents();

  const [monthInput, deltaInput] = document.getElementById('events').querySelectorAll('input');
  assert.ok(monthInput);
  assert.ok(deltaInput);

  monthInput.value = '999';
  monthInput.dispatchEvent(new FakeEvent('input'));
  assert.equal(vm.runInContext('state.events[0].month', context), 36);

  monthInput.value = '2.6';
  monthInput.dispatchEvent(new FakeEvent('input'));
  assert.equal(vm.runInContext('state.events[0].month', context), 3);

  deltaInput.value = '3.6';
  deltaInput.dispatchEvent(new FakeEvent('input'));
  assert.equal(vm.runInContext('state.events[0].delta', context), 4);

  monthInput.value = '';
  monthInput.dispatchEvent(new FakeEvent('input'));
  deltaInput.value = '';
  deltaInput.dispatchEvent(new FakeEvent('input'));
  assert.equal(vm.runInContext('state.events[0].month', context), 3);
  assert.equal(vm.runInContext('state.events[0].delta', context), 4);

  monthInput.dispatchEvent(new FakeEvent('change'));
  deltaInput.dispatchEvent(new FakeEvent('change'));
  assert.equal(monthInput.value, '3');
  assert.equal(deltaInput.value, '4');
});

test('renderEvents preserves events outside the selected forecast horizon', () => {
  const { context, document } = loadApplication();
  const renderEvents = publicFunction(context, 'renderEvents');
  const eventBox = document.getElementById('events');

  vm.runInContext('state.years = 3; state.events = [{month: 24, delta: 3}]', context);
  renderEvents();
  assert.equal(vm.runInContext('state.events[0].month', context), 24);
  assert.doesNotMatch(eventBox.innerHTML, /予測期間外/);

  vm.runInContext('state.years = 1', context);
  renderEvents();
  assert.equal(vm.runInContext('state.events[0].month', context), 24);
  assert.match(eventBox.innerHTML, /予測期間外/);
  assert.equal(eventBox.querySelectorAll('input')[0].value, '24');

  vm.runInContext('state.years = 3', context);
  renderEvents();
  assert.equal(vm.runInContext('state.events[0].month', context), 24);
  assert.doesNotMatch(eventBox.innerHTML, /予測期間外/);
});

test('forecast horizon buttons do not rewrite future event months', () => {
  const { context, document } = loadApplication();
  const renderEvents = publicFunction(context, 'renderEvents');
  const horizonButtons = document.querySelectorAll('#span button');
  const oneYear = horizonButtons.find(button => button.dataset.y === '1');
  const threeYears = horizonButtons.find(button => button.dataset.y === '3');
  assert.ok(oneYear);
  assert.ok(threeYears);

  vm.runInContext('state.years = 3; state.events = [{month: 24, delta: 3}]', context);
  renderEvents();
  oneYear.dispatchEvent(new FakeEvent('click'));
  assert.equal(vm.runInContext('state.events[0].month', context), 24);
  assert.match(document.getElementById('events').innerHTML, /予測期間外/);

  threeYears.dispatchEvent(new FakeEvent('click'));
  assert.equal(vm.runInContext('state.events[0].month', context), 24);
  assert.doesNotMatch(document.getElementById('events').innerHTML, /予測期間外/);
});

test('an empty unconfirmed profile leaves every legacy calculation unchanged', () => {
  const { context } = loadApplication();
  const compute = publicFunction(context, 'compute');
  const rows = compute();

  for (const row of rows) {
    assert.equal(row.addon, 0);
    assert.equal(row.device, 0);
    assert.equal(row.emergency, 0);
    assert.equal(row.terminal, 0);
    assert.equal(row.med, row.medBase);
    assert.equal(row.rev, row.medBase + row.kaigo);
  }
});

test('entered profile values do not affect revenue, patients, or reference counts before confirmation', () => {
  const { context } = loadApplication();
  const compute = publicFunction(context, 'compute');
  const legacyRows = compute();
  vm.runInContext(
    'Object.assign(state, {devicePatients: 10, monthlyAddonRevenue: 40000, emergencyVisits: 2, terminalCases: 1, profileEnabled: false})',
    context,
  );
  const unconfirmedRows = compute();

  assert.equal(unconfirmedRows.length, legacyRows.length);
  for (let index = 0; index < legacyRows.length; index++) {
    const legacy = legacyRows[index];
    const current = unconfirmedRows[index];
    assert.equal(current.home, legacy.home);
    assert.equal(current.fac, legacy.fac);
    assert.equal(current.total, legacy.total);
    assert.equal(current.medBase, legacy.medBase);
    assert.equal(current.med, legacy.med);
    assert.equal(current.rev, legacy.rev);
    assert.equal(current.addon, 0);
    assert.equal(current.device, 0);
    assert.equal(current.emergency, 0);
    assert.equal(current.terminal, 0);
  }
});

test('a confirmed profile adds proportional medical revenue without changing the patient forecast', () => {
  const { context } = loadApplication();
  const compute = publicFunction(context, 'compute');
  vm.runInContext(
    'Object.assign(state, {devicePatients: 10, monthlyAddonRevenue: 40000, emergencyVisits: 2, terminalCases: 1, profileEnabled: false})',
    context,
  );
  const unconfirmedRows = compute();
  vm.runInContext('state.profileEnabled = true', context);
  const confirmedRows = compute();

  for (let index = 0; index < unconfirmedRows.length; index++) {
    const before = unconfirmedRows[index];
    const after = confirmedRows[index];
    assert.equal(after.home, before.home);
    assert.equal(after.fac, before.fac);
    assert.equal(after.total, before.total);
    assert.equal(after.medBase, before.medBase);
    assertClose(after.addon, after.total * 1000);
    assertClose(after.med, after.medBase + after.addon);
    assertClose(after.rev, after.med + after.kaigo);
    assertClose(after.device, after.total * 0.25);
    assertClose(after.emergency, after.total * 0.05);
    assertClose(after.terminal, after.total * 0.025);
  }
});

test('deriveProfile converts 40000 yen over the initial 40 patients to 1000 yen per patient-month', () => {
  const { context } = loadApplication();
  const deriveProfile = publicFunction(context, 'deriveProfile');
  const profile = deriveProfile({
    baselinePatients: 40,
    devicePatients: 10,
    monthlyAddonRevenue: 40000,
    emergencyVisits: 2,
    terminalCases: 1,
  });

  assert.equal(profile.ok, true);
  assert.equal(profile.baselinePatients, 40);
  assert.equal(profile.addonPerPatient, 1000);
  assert.equal(profile.deviceRate, 0.25);
  assert.equal(profile.emergencyRate, 0.05);
  assert.equal(profile.terminalRate, 0.025);
});

test('deriveProfile reports device counts over baseline and nonzero profiles without a baseline', () => {
  const { context } = loadApplication();
  const deriveProfile = publicFunction(context, 'deriveProfile');
  const overBaseline = deriveProfile({
    baselinePatients: 40,
    devicePatients: 41,
    monthlyAddonRevenue: 0,
    emergencyVisits: 0,
    terminalCases: 0,
  });
  const missingBaseline = deriveProfile({
    baselinePatients: 0,
    devicePatients: 0,
    monthlyAddonRevenue: 40000,
    emergencyVisits: 0,
    terminalCases: 0,
  });
  const emptyBaseline = deriveProfile({
    baselinePatients: 0,
    devicePatients: 0,
    monthlyAddonRevenue: 0,
    emergencyVisits: 0,
    terminalCases: 0,
  });

  assertInvalid(overBaseline, 'device-over-total');
  assert.equal(overBaseline.deviceRate, 0);
  assertInvalid(missingBaseline, 'missing-baseline');
  assert.equal(missingBaseline.addonPerPatient, 0);
  assert.equal(emptyBaseline.ok, true);
  assert.equal(emptyBaseline.code, null);
  assert.equal(emptyBaseline.hasInput, false);
});

test('deriveProfile rejects invalid aggregate values in every profile field', async t => {
  const { context } = loadApplication();
  const deriveProfile = publicFunction(context, 'deriveProfile');
  const valid = {
    baselinePatients: 40,
    devicePatients: 10,
    monthlyAddonRevenue: 40000,
    emergencyVisits: 2,
    terminalCases: 1,
  };
  const fields = ['devicePatients', 'monthlyAddonRevenue', 'emergencyVisits', 'terminalCases'];
  const invalidValues = [
    ['negative', -1],
    ['fractional', 1.5],
    ['infinite', Infinity],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ];

  for (const field of fields) {
    for (const [description, value] of invalidValues) {
      await t.test(`${field}: ${description}`, () => {
        assertInvalid(deriveProfile({ ...valid, [field]: value }), 'invalid-input');
      });
    }
  }
});

test('blank profile inputs preserve state and restore the saved value on change', () => {
  const { context, document } = loadApplication();
  const fixtures = [
    ['profile-device', 'devicePatients', 10],
    ['profile-addon', 'monthlyAddonRevenue', 40000],
    ['profile-emergency', 'emergencyVisits', 2],
    ['profile-terminal', 'terminalCases', 1],
  ];
  vm.runInContext(
    'Object.assign(state, {devicePatients: 10, monthlyAddonRevenue: 40000, emergencyVisits: 2, terminalCases: 1}); render()',
    context,
  );

  for (const [id, key, expected] of fixtures) {
    const input = document.getElementById(id);
    input.value = '';
    input.dispatchEvent(new FakeEvent('input'));
    assert.equal(vm.runInContext(`state.${key}`, context), expected);
    assert.equal(input.value, '');
    assert.equal(input.getAttribute('aria-invalid'), 'true');

    input.dispatchEvent(new FakeEvent('change'));
    assert.equal(vm.runInContext(`state.${key}`, context), expected);
    assert.equal(String(input.value), String(expected));
    assert.equal(input.getAttribute('aria-invalid'), null);
  }
});

test('the profile confirmation checkbox is the gate that starts proportional reflection', () => {
  const { context, document } = loadApplication();
  const compute = publicFunction(context, 'compute');
  const addonInput = document.getElementById('profile-addon');
  const confirmation = document.getElementById('profile-apply');

  addonInput.value = '40000';
  addonInput.dispatchEvent(new FakeEvent('input'));
  assert.equal(vm.runInContext('state.monthlyAddonRevenue', context), 40000);
  assert.equal(vm.runInContext('state.profileEnabled', context), false);
  assert.equal(compute()[0].addon, 0);

  confirmation.checked = true;
  confirmation.dispatchEvent(new FakeEvent('change'));
  assert.equal(vm.runInContext('state.profileEnabled', context), true);
  assert.equal(compute()[0].addon, 40000);
});

test('custom all-inclusive pricing warns when additional revenue may be counted twice', () => {
  const { context, document } = loadApplication();
  vm.runInContext(
    'Object.assign(state, {customPrice: true, monthlyAddonRevenue: 40000}); render()',
    context,
  );

  const warning = document.getElementById('profile-warning');
  assert.match(warning.textContent, /二重計上/);
  assert.match(warning.textContent, /追加収益欄を0円/);
  assert.equal(warning.classList.contains('show'), true);
});

test('changing a confirmed profile or its pricing baseline requires confirmation again', async t => {
  const cases = [
    {
      name: 'monthly aggregate changes',
      change(document) {
        const input = document.getElementById('profile-addon');
        input.value = '50000';
        input.dispatchEvent(new FakeEvent('input'));
      },
    },
    {
      name: 'starting patient count changes',
      change(document) {
        const input = document.getElementById('p0home');
        input.value = '26';
        input.dispatchEvent(new FakeEvent('input'));
      },
    },
    {
      name: 'pricing mode changes',
      change(document) {
        const button = document.querySelectorAll('#pricemode button')
          .find(candidate => candidate.dataset.pm === 'custom');
        assert.ok(button);
        button.dispatchEvent(new FakeEvent('click'));
      },
    },
    {
      name: 'automatic-price qualification changes',
      change(document) {
        const button = document.querySelectorAll('#kyoka button')
          .find(candidate => candidate.dataset.k === 'bedless');
        assert.ok(button);
        button.dispatchEvent(new FakeEvent('click'));
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const { context, document } = loadApplication();
      const compute = publicFunction(context, 'compute');
      vm.runInContext(
        'Object.assign(state, {monthlyAddonRevenue: 40000, profileEnabled: true}); render()',
        context,
      );
      assert.equal(compute()[0].addon, 40000);

      fixture.change(document);

      assert.equal(vm.runInContext('state.profileEnabled', context), false);
      assert.equal(document.getElementById('profile-apply').checked, false);
      assert.equal(compute()[0].addon, 0);
    });
  }
});

test('profile confirmation stays disabled until aggregate inputs can be converted safely', () => {
  const { context, document } = loadApplication();
  const confirmation = document.getElementById('profile-apply');
  const addonInput = document.getElementById('profile-addon');
  const deviceInput = document.getElementById('profile-device');
  const homeInput = document.getElementById('p0home');
  const facilityInput = document.getElementById('p0fac');

  assert.equal(confirmation.disabled, true);

  addonInput.value = '40000';
  addonInput.dispatchEvent(new FakeEvent('input'));
  assert.equal(confirmation.disabled, false);

  deviceInput.value = '41';
  deviceInput.dispatchEvent(new FakeEvent('input'));
  assert.equal(confirmation.disabled, true);
  assert.equal(vm.runInContext('state.profileEnabled', context), false);

  deviceInput.value = '0';
  deviceInput.dispatchEvent(new FakeEvent('input'));
  assert.equal(confirmation.disabled, false);
  confirmation.checked = true;
  confirmation.dispatchEvent(new FakeEvent('change'));
  assert.equal(vm.runInContext('state.profileEnabled', context), true);

  homeInput.value = '0';
  homeInput.dispatchEvent(new FakeEvent('input'));
  facilityInput.value = '0';
  facilityInput.dispatchEvent(new FakeEvent('input'));
  assert.equal(confirmation.disabled, true);
  assert.equal(confirmation.checked, false);
  assert.equal(vm.runInContext('state.profileEnabled', context), false);
});

test('an invalid profile edit immediately removes previously confirmed revenue', () => {
  const { context, document } = loadApplication();
  const compute = publicFunction(context, 'compute');
  const addonInput = document.getElementById('profile-addon');
  const confirmation = document.getElementById('profile-apply');

  addonInput.value = '40000';
  addonInput.dispatchEvent(new FakeEvent('input'));
  confirmation.checked = true;
  confirmation.dispatchEvent(new FakeEvent('change'));
  assert.equal(compute()[0].addon, 40000);

  addonInput.value = '-1';
  addonInput.dispatchEvent(new FakeEvent('input'));

  assert.equal(vm.runInContext('state.profileEnabled', context), false);
  assert.equal(confirmation.checked, false);
  assert.equal(compute()[0].addon, 0);
  assert.equal(addonInput.value, '-1');
  assert.equal(addonInput.getAttribute('aria-invalid'), 'true');
  assert.match(document.getElementById('profile-warning').textContent, /0以上の整数/);
});

test('the aggregate profile UI has no patient-name or free-text input', () => {
  const profileMarkup = html.match(/<details\b[^>]*\bid="profile"[^>]*>[\s\S]*?<\/details>/i)?.[0];
  assert.ok(profileMarkup, 'the aggregate profile section must exist');

  const inputs = [...profileMarkup.matchAll(/<input\b([^>]*)>/gi)].map(match => match[1]);
  const numberInputs = inputs.filter(attributes => /\btype="number"/i.test(attributes));
  const checkboxInputs = inputs.filter(attributes => /\btype="checkbox"/i.test(attributes));
  assert.equal(numberInputs.length, 4);
  assert.equal(checkboxInputs.length, 1);
  assert.equal(inputs.length, 5);
  assert.doesNotMatch(profileMarkup, /<textarea\b|contenteditable\s*=|\btype=["']text["']/i);
  assert.match(profileMarkup, /患者名や患者別台帳は不要/);
});
