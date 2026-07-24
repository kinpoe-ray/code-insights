#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const STATE_VERSION = 1;
const LOCK_STALE_MS = 5 * 60 * 1_000;
const CHILD_TIMEOUT_MS = 45_000;
const MAX_CHILD_OUTPUT = 256 * 1_024;
const MAX_OUTBOX_EVENTS = 100;
const MAX_DRAIN_EVENTS = 1_000;
const CURRENT_STATUSES = new Set(['active', 'paused']);
const ITEM_STATUSES = new Set(['pending', 'session_staged', 'failed', 'succeeded']);
const SENDER_BOOTSTRAP = `
import { pathToFileURL } from 'node:url';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
process.argv = [process.execPath, payload.sender, ...payload.args];
await import(pathToFileURL(payload.sender).href);
`;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function usage() {
  return [
    'Usage: code-insights-analysis-alert.mjs evaluate',
    '  --db PATH --sqlite-bin PATH --state PATH --config PATH',
    '  --campaign-id ID [--dry-run]',
  ].join('\n');
}

function parseArgs(argv) {
  if (argv[0] !== 'evaluate') fail(usage(), 64);
  const options = { dryRun: false };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (!['--db', '--sqlite-bin', '--state', '--config', '--campaign-id'].includes(arg)) {
      fail(usage(), 64);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(usage(), 64);
    options[arg.slice(2).replaceAll('-', '')] = value;
    index++;
  }
  for (const key of ['db', 'sqlitebin', 'state', 'config', 'campaignid']) {
    if (!options[key]) fail(usage(), 64);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.campaignid)) {
    fail('Invalid campaign identifier.', 64);
  }
  return options;
}

function assertPrivateParent(path, label) {
  const parent = dirname(path);
  const info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} parent must be a regular directory.`, 78);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail(`${label} parent must be owned by the current user.`, 78);
  }
  if ((info.mode & 0o077) !== 0) {
    fail(`${label} parent permissions must not allow group or other access.`, 78);
  }
}

function readPrivateFile(path, label) {
  assertPrivateParent(path, label);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) {
      fail(`${label} must be a single-link regular file.`, 78);
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      fail(`${label} must be owned by the current user.`, 78);
    }
    if ((info.mode & 0o077) !== 0) {
      fail(`${label} permissions must not allow group or other access.`, 78);
    }
    return readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (Number.isInteger(error?.exitCode)) throw error;
    fail(`${label} could not be opened safely.`, 78);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function senderFingerprint(path) {
  assertTrustedSenderParents(path);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail('Alert sender must be a single-link regular file.', 78);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail('Alert sender must be owned by the current user.', 78);
  }
  if ((info.mode & 0o022) !== 0) {
    fail('Alert sender must not be group- or other-writable.', 78);
  }
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

function assertTrustedSenderParents(path) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let current = dirname(path);
  while (true) {
    const info = lstatSync(current);
    if (
      !info.isDirectory()
      || info.isSymbolicLink()
      || (info.mode & 0o022) !== 0
      || (uid !== null && info.uid !== uid && info.uid !== 0)
    ) {
      fail('Alert sender parent path is unsafe.', 78);
    }
    if (
      current === dirname(current)
      || (uid !== null && info.uid === uid && (info.mode & 0o077) === 0)
    ) {
      return;
    }
    current = dirname(current);
  }
}

function readConfig(path) {
  if (!existsSync(path)) return null;
  let value;
  try {
    value = JSON.parse(readPrivateFile(path, 'Alert configuration'));
  } catch {
    fail('Alert configuration could not be read safely.', 78);
  }
  if (value?.version !== 1 || typeof value.enabled !== 'boolean') {
    fail('Alert configuration has an unsupported shape.', 78);
  }
  if (!value.enabled) return value;
  if (
    typeof value.target !== 'string'
    || value.target.trim() === ''
    || value.target.trim().startsWith('-')
    || value.target.length > 128
    || /[\u0000-\u001F\u007F]/.test(value.target)
  ) {
    fail('Alert target is invalid.', 78);
  }
  if (
    typeof value.senderScript !== 'string'
    || !isAbsolute(value.senderScript)
    || !existsSync(value.senderScript)
  ) {
    fail('Alert sender is unavailable.', 78);
  }
  return {
    version: 1,
    enabled: true,
    target: value.target.trim(),
    senderScript: value.senderScript,
    senderFingerprint: senderFingerprint(value.senderScript),
  };
}

function emptyState() {
  return {
    version: STATE_VERSION,
    nextSequence: 1,
    incidents: [],
    outbox: [],
  };
}

function assertFailureList(failures, message) {
  if (!Array.isArray(failures) || failures.length < 1 || failures.length > 10_000) {
    fail(message, 78);
  }
  const sessionIds = new Set();
  for (const failure of failures) {
    if (
      typeof failure?.sessionId !== 'string'
      || failure.sessionId.length < 1
      || failure.sessionId.length > 512
      || /[\u0000-\u001F\u007F]/.test(failure.sessionId)
      || typeof failure.errorCode !== 'string'
      || !/^[A-Z0-9_-]{1,64}$/.test(failure.errorCode)
      || sessionIds.has(failure.sessionId)
    ) {
      fail(message, 78);
    }
    sessionIds.add(failure.sessionId);
  }
}

function assertStoredEvent(event) {
  if (
    typeof event?.eventId !== 'string'
    || !/^[a-f0-9]{64}$/.test(event.eventId)
    || !['detected', 'resolved'].includes(event.phase)
    || typeof event.message !== 'string'
    || event.message.length < 1
    || event.message.length > 4_000
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(event.message)
  ) {
    fail('Alert state contains an invalid queued event.', 78);
  }
  if (event.phase === 'detected') {
    if (
      !Number.isSafeInteger(event.sequence)
      || event.sequence < 1
      || typeof event.campaignId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(event.campaignId)
    ) {
      fail('Alert state contains an invalid queued event.', 78);
    }
    assertFailureList(event.failures, 'Alert state contains an invalid queued event.');
    return;
  }
  if (
    typeof event.campaignId !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(event.campaignId)
    || !Array.isArray(event.incidentRefs)
    || event.incidentRefs.some(reference => (
      typeof reference?.incidentId !== 'string'
      || !/^[a-f0-9]{64}$/.test(reference.incidentId)
    ))
  ) {
    fail('Alert state contains an invalid queued event.', 78);
  }
}

function readState(path) {
  if (!existsSync(path)) {
    assertPrivateParent(path, 'Alert state');
    return emptyState();
  }
  let value;
  try {
    value = JSON.parse(readPrivateFile(path, 'Alert state'));
  } catch {
    fail('Alert state could not be read safely.', 78);
  }
  if (
    value?.version !== STATE_VERSION
    || !Number.isSafeInteger(value.nextSequence)
    || value.nextSequence < 1
    || !Array.isArray(value.incidents)
  ) {
    fail('Alert state has an unsupported shape.', 78);
  }
  value.outbox ??= [];
  if (!Array.isArray(value.outbox) || value.outbox.length > MAX_OUTBOX_EVENTS) {
    fail('Alert state has an unsupported shape.', 78);
  }
  for (const incident of value.incidents) {
    if (
      typeof incident.incidentId !== 'string'
      || !/^[a-f0-9]{64}$/.test(incident.incidentId)
      || !Number.isSafeInteger(incident.sequence)
      || incident.sequence < 1
      || typeof incident.originCampaignId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(incident.originCampaignId)
      || typeof incident.sessionId !== 'string'
      || incident.sessionId.length < 1
      || incident.sessionId.length > 512
      || /[\u0000-\u001F\u007F]/.test(incident.sessionId)
      || typeof incident.errorCode !== 'string'
      || !/^[A-Z0-9_-]{1,64}$/.test(incident.errorCode)
      || !['open', 'resolved', 'superseded'].includes(incident.status)
    ) {
      fail('Alert state contains an invalid incident.', 78);
    }
  }
  for (const event of value.outbox) assertStoredEvent(event);
  const incidentIds = new Set();
  for (const incident of value.incidents) {
    if (incidentIds.has(incident.incidentId)) {
      fail('Alert state contains an invalid incident.', 78);
    }
    incidentIds.add(incident.incidentId);
  }
  const eventIds = new Set();
  for (const event of value.outbox) {
    if (eventIds.has(event.eventId)) {
      fail('Alert state contains an invalid queued event.', 78);
    }
    eventIds.add(event.eventId);
    if (
      event.phase === 'resolved'
      && event.incidentRefs.some(reference => !incidentIds.has(reference.incidentId))
    ) {
      fail('Alert state contains an invalid queued event.', 78);
    }
  }
  const maxSequence = value.incidents.reduce(
    (highest, incident) => Math.max(highest, incident.sequence),
    0,
  );
  const maxQueuedSequence = value.outbox.reduce(
    (highest, event) => event.phase === 'detected'
      ? Math.max(highest, event.sequence)
      : highest,
    0,
  );
  if (value.nextSequence <= Math.max(maxSequence, maxQueuedSequence)) {
    fail('Alert state has an invalid sequence cursor.', 78);
  }
  return value;
}

function atomicWriteState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  let descriptor;
  let parentDescriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    parentDescriptor = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(parentDescriptor);
    closeSync(parentDescriptor);
    parentDescriptor = undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
    rmSync(temporary, { force: true });
  }
}

function acquireStateLock(statePath) {
  assertPrivateParent(statePath, 'Alert state');
  const lockPath = `${statePath}.lock`;
  const ownerPath = join(lockPath, 'owner.json');
  const tryAcquire = () => {
    const token = randomBytes(24).toString('hex');
    const processStartedAt = readProcessStartedAt(process.pid);
    if (!processStartedAt) fail('Alert state lock is unsafe.', 78);
    mkdirSync(lockPath, { mode: 0o700 });
    try {
      writeFileSync(ownerPath, `${JSON.stringify({
        version: 1,
        pid: process.pid,
        processStartedAt,
        token,
        createdAt: Date.now(),
      })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      rmdirSync(lockPath);
      throw error;
    }
    return {
      release() {
        try {
          const owner = readLockOwner(lockPath);
          if (owner.token !== token) return;
          unlinkSync(ownerPath);
          rmdirSync(lockPath);
        } catch {
          // Never remove a lock whose ownership can no longer be proven.
        }
      },
    };
  };
  try {
    return tryAcquire();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const owner = readLockOwner(lockPath);
  if (
    processMatchesStart(owner.pid, owner.processStartedAt)
    || Date.now() - owner.createdAt <= LOCK_STALE_MS
  ) {
    return null;
  }
  try {
    const current = readLockOwner(lockPath);
    if (current.token !== owner.token) return null;
    unlinkSync(ownerPath);
    rmdirSync(lockPath);
  } catch {
    return null;
  }
  try {
    return tryAcquire();
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
}

function readLockOwner(lockPath) {
  const directory = lstatSync(lockPath);
  if (
    !directory.isDirectory()
    || directory.isSymbolicLink()
    || (typeof process.getuid === 'function' && directory.uid !== process.getuid())
    || (directory.mode & 0o077) !== 0
  ) {
    fail('Alert state lock is unsafe.', 78);
  }
  const ownerPath = join(lockPath, 'owner.json');
  let descriptor;
  try {
    descriptor = openSync(ownerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    if (
      !info.isFile()
      || info.nlink !== 1
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
      || (info.mode & 0o077) !== 0
    ) {
      fail('Alert state lock is unsafe.', 78);
    }
    const owner = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (
      owner?.version !== 1
      || !Number.isSafeInteger(owner.pid)
      || owner.pid <= 0
      || typeof owner.processStartedAt !== 'string'
      || owner.processStartedAt.length < 1
      || owner.processStartedAt.length > 128
      || /[\u0000-\u001F\u007F]/.test(owner.processStartedAt)
      || typeof owner.token !== 'string'
      || !/^[a-f0-9]{48}$/.test(owner.token)
      || !Number.isSafeInteger(owner.createdAt)
      || owner.createdAt <= 0
    ) {
      fail('Alert state lock is unsafe.', 78);
    }
    return owner;
  } catch (error) {
    if (Number.isInteger(error?.exitCode)) throw error;
    fail('Alert state lock is unsafe.', 78);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readProcessStartedAt(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 4_096,
    env: { PATH: '/usr/bin:/bin' },
  });
  if (result.error || result.status !== 0) return '';
  return result.stdout.trim().replace(/\s+/g, ' ');
}

function processMatchesStart(pid, expectedStart) {
  const actualStart = readProcessStartedAt(pid);
  return actualStart !== '' && actualStart === expectedStart;
}

function runChild(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: MAX_CHILD_OUTPUT,
    env: process.env,
  });
}

function runSenderChild(config, args, event) {
  const current = senderFingerprint(config.senderScript);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs']) {
    if (current[key] !== config.senderFingerprint[key]) {
      fail('Alert sender changed after validation.', 78);
    }
  }
  const env = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NO_COLOR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.CODE_INSIGHTS_ALERT_EVENT_ID = event.eventId;
  env.CODE_INSIGHTS_ALERT_PHASE = event.phase;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', SENDER_BOOTSTRAP], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: MAX_CHILD_OUTPUT,
    env,
    input: JSON.stringify({
      sender: config.senderScript,
      args,
    }),
  });
}

function sqliteJson(sqliteBin, dbPath, sql) {
  const result = runChild(sqliteBin, ['-json', dbPath, sql]);
  if (result.error || result.status !== 0) fail('Could not inspect the analysis campaign.', 74);
  try {
    const value = JSON.parse(result.stdout.trim() || '[]');
    if (!Array.isArray(value)) throw new Error('not an array');
    return value;
  } catch {
    fail('Analysis campaign inspection returned invalid data.', 74);
  }
}

function readCampaign(sqliteBin, dbPath, campaignId) {
  const campaignRows = sqliteJson(sqliteBin, dbPath, `
    SELECT id, provider, model, pipeline_revision, status, total_items
    FROM analysis_campaigns
    WHERE id = '${campaignId}'
    LIMIT 1;
  `);
  if (campaignRows.length === 0) return null;
  if (campaignRows.length !== 1) fail('Analysis campaign inspection was ambiguous.', 74);
  const campaign = campaignRows[0];
  if (
    campaign.id !== campaignId
    || typeof campaign.provider !== 'string'
    || typeof campaign.model !== 'string'
    || typeof campaign.pipeline_revision !== 'string'
    || !['active', 'paused', 'completed', 'cancelled'].includes(campaign.status)
    || !Number.isSafeInteger(campaign.total_items)
    || campaign.total_items < 0
  ) {
    fail('Analysis campaign has an invalid shape.', 74);
  }

  const items = sqliteJson(sqliteBin, dbPath, `
    SELECT session_id, status, COALESCE(error_code, '') AS error_code
    FROM analysis_campaign_items
    WHERE campaign_id = '${campaignId}'
    ORDER BY session_id ASC;
  `);
  for (const item of items) {
    if (
      typeof item.session_id !== 'string'
      || !ITEM_STATUSES.has(item.status)
      || typeof item.error_code !== 'string'
    ) {
      fail('Analysis campaign item has an invalid shape.', 74);
    }
  }
  return {
    id: campaign.id,
    provider: campaign.provider,
    model: campaign.model,
    pipelineRevision: campaign.pipeline_revision,
    status: campaign.status,
    totalItems: campaign.total_items,
    items: items.map(item => ({
      sessionId: item.session_id,
      status: item.status,
      errorCode: item.error_code || 'ANALYSIS_FAILED',
    })),
  };
}

function histogram(rows) {
  const result = {};
  for (const row of rows) {
    const code = normalizeErrorCode(row.errorCode);
    result[code] = (result[code] ?? 0) + 1;
  }
  return result;
}

function normalizeErrorCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_-]{1,64}$/.test(value)
    ? value
    : 'ANALYSIS_FAILED';
}

function normalizeFailures(rows) {
  return rows
    .map(row => ({
      sessionId: row.sessionId,
      errorCode: normalizeErrorCode(row.errorCode),
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function failureSignature(campaignId, failure) {
  return `${campaignId}\u0000${failure.sessionId}\u0000${failure.errorCode}`;
}

function countsFor(campaign) {
  const counts = { pending: 0, session_staged: 0, failed: 0, succeeded: 0 };
  for (const item of campaign.items) counts[item.status]++;
  return counts;
}

function describeCause(errorCodes) {
  const labels = {
    INVALID_MODEL_OUTPUT: '模型返回的结构化结果在自动重试后仍无法解析',
    RATE_LIMIT: '模型服务触发限流',
    AUTHENTICATION: '模型服务鉴权失败',
    INPUT_CHANGED: '会话内容在任务创建后发生变化',
    ANALYSIS_FAILED: '分析失败，但现有错误码不足以确认更具体原因',
  };
  const entries = Object.entries(errorCodes)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 1) return labels[entries[0][0]] ?? labels.ANALYSIS_FAILED;
  return entries
    .map(([code, count]) => `${labels[code] ?? labels.ANALYSIS_FAILED}（${count} 条）`)
    .join('；');
}

function describeSolution(errorCodes) {
  const codes = new Set(Object.keys(errorCodes));
  if (codes.has('AUTHENTICATION')) {
    return '旧分析结果已保留；请检查模型服务凭证，确认后再重试。';
  }
  if (codes.has('RATE_LIMIT')) {
    return '旧分析结果已保留；后续任务会安全重试。若持续出现，请降低批量或检查服务配额。';
  }
  if (codes.has('INPUT_CHANGED')) {
    return '旧分析结果已保留；请基于最新会话内容重新建立任务后重试。';
  }
  if (codes.has('INVALID_MODEL_OUTPUT')) {
    return '旧分析结果已保留，失败项会在后续任务中安全重试；若重复出现，再收紧输出约束或切换模型。';
  }
  return '旧分析结果已保留；请查看脱敏日志确认原因后再重试。';
}

function makeDetectedEvent(campaign, state, failedRows) {
  const sequence = state.nextSequence;
  const failures = normalizeFailures(failedRows);
  const errorCodes = histogram(failures);
  const eventId = createHash('sha256')
    .update(`${campaign.id}|${sequence}|detected`)
    .digest('hex');
  const count = failures.length;
  return {
    eventId,
    phase: 'detected',
    sequence,
    campaignId: campaign.id,
    failures,
    message: [
      `Code Insights 自动分析失败：当前任务发现 ${count} 条失败。`,
      `原因：${describeCause(errorCodes)}。`,
      `解决：${describeSolution(errorCodes)}`,
    ].join('\n'),
  };
}

function makeResolvedEvent(campaign, incidents) {
  const incidentIds = incidents
    .map(incident => incident.incidentId)
    .sort();
  const eventId = createHash('sha256')
    .update(`${campaign.id}|${incidentIds.join(',')}|resolved`)
    .digest('hex');
  const recoveredCount = new Set(
    incidents.map(incident => incident.sessionId),
  ).size;
  const counts = countsFor(campaign);
  const suffix = counts.failed === 0
    ? '当前任务没有失败项，无需操作。'
    : `这些会话已恢复；当前任务仍有 ${counts.failed} 条其他失败，将继续按原告警处理。`;
  return {
    eventId,
    phase: 'resolved',
    campaignId: campaign.id,
    incidentRefs: incidents.map(incident => ({
      incidentId: incident.incidentId,
    })),
    message: `Code Insights 自动分析已恢复：此前失败的 ${recoveredCount} 条会话已成功完成。${suffix}`,
  };
}

function planEvaluation(state, campaign) {
  if (campaign.status === 'cancelled') {
    const discarded = supersedeCampaign(state, campaign.id);
    return {
      nextState: discarded.nextState,
      changed: discarded.changed,
      event: null,
    };
  }
  const nextState = structuredClone(state);
  const itemBySession = new Map(campaign.items.map(item => [item.sessionId, item]));
  const queuedResolved = new Set(
    nextState.outbox
      .filter(event => event.phase === 'resolved')
      .flatMap(event => event.incidentRefs)
      .map(reference => reference.incidentId),
  );
  const resolved = [];
  let changed = false;

  for (const incident of nextState.incidents) {
    if (incident.status !== 'open') continue;
    if (queuedResolved.has(incident.incidentId)) continue;
    const item = itemBySession.get(incident.sessionId);
    const supersede = () => {
      incident.status = 'superseded';
      incident.supersededAt = new Date().toISOString();
      changed = true;
    };
    if (campaign.id !== incident.originCampaignId) {
      continue;
    }
    if (item?.status === 'succeeded') {
      resolved.push(incident);
      continue;
    }
    if (
      campaign.status === 'cancelled'
      || campaign.status === 'completed'
      || (
        item?.status === 'failed'
        && normalizeErrorCode(item.errorCode) !== incident.errorCode
      )
    ) {
      supersede();
    }
  }

  const covered = new Set(
    [
      ...nextState.incidents
        .filter(incident => (
          incident.status === 'open'
          && incident.originCampaignId === campaign.id
        ))
        .map(incident => failureSignature(campaign.id, incident)),
      ...nextState.outbox
        .filter(event => event.phase === 'detected' && event.campaignId === campaign.id)
        .flatMap(event => event.failures)
        .map(failure => failureSignature(campaign.id, failure)),
    ],
  );
  const newFailures = CURRENT_STATUSES.has(campaign.status)
    ? campaign.items.filter(item => (
      item.status === 'failed'
      && !covered.has(failureSignature(campaign.id, {
        sessionId: item.sessionId,
        errorCode: normalizeErrorCode(item.errorCode),
      }))
    ))
    : [];

  if (newFailures.length > 0) {
    return {
      nextState,
      changed,
      event: makeDetectedEvent(campaign, nextState, newFailures),
    };
  }
  if (resolved.length > 0) {
    return {
      nextState,
      changed,
      event: makeResolvedEvent(campaign, resolved),
    };
  }
  return { nextState, changed, event: null };
}

function parseChildJson(result) {
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

function deliver(config, event, dryRun) {
  const pathsResult = parseChildJson(
    runSenderChild(config, ['--config-paths'], event),
  );
  if (pathsResult?.success !== true) fail('TeamTalk alert preflight failed.', 75);

  const checkResult = parseChildJson(
    runSenderChild(config, ['--check'], event),
  );
  if (checkResult?.success !== true || checkResult.configured !== true) {
    fail('TeamTalk alert configuration is unavailable.', 75);
  }

  const args = [
    ...(dryRun ? ['--dry-run'] : []),
    config.target,
    event.message,
  ];
  const result = runSenderChild(config, args, event);
  const parsed = parseChildJson(result);
  if (parsed?.success !== true || (dryRun && parsed.dryRun !== true)) {
    fail('TeamTalk alert delivery failed.', 75);
  }
}

function recordDelivered(state, event) {
  const now = new Date().toISOString();
  if (event.phase === 'detected') {
    for (const failure of event.failures) {
      state.incidents.push({
        incidentId: createHash('sha256')
          .update(`${event.eventId}|${failure.sessionId}|${failure.errorCode}`)
          .digest('hex'),
        sequence: event.sequence,
        originCampaignId: event.campaignId,
        sessionId: failure.sessionId,
        errorCode: failure.errorCode,
        status: 'open',
        detectedEventId: event.eventId,
        detectedSentAt: now,
      });
    }
    state.nextSequence = Math.max(state.nextSequence, event.sequence + 1);
    return;
  }
  for (const resolved of event.incidentRefs) {
    const incident = state.incidents.find(candidate => (
      candidate.incidentId === resolved.incidentId
      && candidate.status === 'open'
    ));
    if (!incident) continue;
    incident.status = 'resolved';
    incident.resolvedEventId = event.eventId;
    incident.resolvedSentAt = now;
  }
}

function supersedeCampaign(state, campaignId) {
  const nextState = structuredClone(state);
  let changed = false;
  for (const incident of nextState.incidents) {
    if (incident.status !== 'open' || incident.originCampaignId !== campaignId) continue;
    incident.status = 'superseded';
    incident.supersededAt = new Date().toISOString();
    changed = true;
  }
  const retained = nextState.outbox.filter(event => (
    !(
      event.phase === 'detected'
      && event.campaignId === campaignId
    )
    && !(
      event.phase === 'resolved'
      && event.incidentRefs.some(reference => {
        const incident = nextState.incidents.find(
          candidate => candidate.incidentId === reference.incidentId,
        );
        return incident?.originCampaignId === campaignId;
      })
    )
  ));
  if (retained.length !== nextState.outbox.length) {
    nextState.outbox = retained;
    changed = true;
  }
  return { nextState, changed };
}

function supersedeMissingCampaign(state, campaignId) {
  return supersedeCampaign(state, campaignId);
}

function eventOriginCampaignIds(state, event) {
  if (event.phase === 'detected') return [event.campaignId];
  const origins = [...new Set(event.incidentRefs.map(reference => {
    const incident = state.incidents.find(
      candidate => candidate.incidentId === reference.incidentId,
    );
    if (!incident) fail('Alert state contains an invalid queued event.', 78);
    return incident.originCampaignId;
  }))];
  if (origins.length !== 1 || origins[0] !== event.campaignId) {
    fail('Alert state contains an invalid queued event.', 78);
  }
  return origins;
}

function discardInvalidOutboxOrigins(
  state,
  sqliteBin,
  dbPath,
) {
  let nextState = structuredClone(state);
  let changed = false;
  const campaigns = new Map();

  while (nextState.outbox.length > 0) {
    const head = nextState.outbox[0];
    const invalidOrigins = [];
    for (const campaignId of eventOriginCampaignIds(nextState, head)) {
      if (!campaigns.has(campaignId)) {
        campaigns.set(campaignId, readCampaign(sqliteBin, dbPath, campaignId));
      }
      const origin = campaigns.get(campaignId);
      if (!origin || origin.status === 'cancelled') invalidOrigins.push(campaignId);
    }
    if (invalidOrigins.length === 0) break;
    for (const campaignId of invalidOrigins) {
      const superseded = supersedeCampaign(nextState, campaignId);
      nextState = superseded.nextState;
      changed ||= superseded.changed;
    }
    continue;
  }
  return { nextState, changed };
}

function discardStaleResolvedHead(state, campaigns) {
  const nextState = structuredClone(state);
  const head = nextState.outbox[0];
  if (!head || head.phase !== 'resolved') {
    return { nextState, changed: false };
  }
  const campaign = campaigns.get(head.campaignId);
  if (!campaign) fail('Alert state contains an invalid queued event.', 78);
  const items = new Map(campaign.items.map(item => [item.sessionId, item]));
  const stillResolved = head.incidentRefs.every(reference => {
    const incident = nextState.incidents.find(
      candidate => candidate.incidentId === reference.incidentId,
    );
    return incident && items.get(incident.sessionId)?.status === 'succeeded';
  });
  if (stillResolved) return { nextState, changed: false };
  nextState.outbox.shift();
  return { nextState, changed: true };
}

function validateOutboxHead(
  state,
  sqliteBin,
  dbPath,
) {
  let nextState = structuredClone(state);
  let changed = false;
  while (nextState.outbox.length > 0) {
    const origins = discardInvalidOutboxOrigins(
      nextState,
      sqliteBin,
      dbPath,
    );
    nextState = origins.nextState;
    changed ||= origins.changed;
    if (nextState.outbox.length === 0) break;

    const campaigns = new Map();
    for (const campaignId of eventOriginCampaignIds(nextState, nextState.outbox[0])) {
      if (!campaigns.has(campaignId)) {
        campaigns.set(campaignId, readCampaign(sqliteBin, dbPath, campaignId));
      }
    }
    const resolved = discardStaleResolvedHead(nextState, campaigns);
    nextState = resolved.nextState;
    changed ||= resolved.changed;
    if (!resolved.changed) break;
  }
  return { nextState, changed };
}

function writeOutcome(outcome) {
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

function planForCampaign(state, campaign, campaignId) {
  return campaign
    ? planEvaluation(state, campaign)
    : {
      ...supersedeMissingCampaign(state, campaignId),
      event: null,
    };
}

function reconcileNonCurrentIncidents(
  state,
  sqliteBin,
  dbPath,
  currentCampaignId,
) {
  let nextState = structuredClone(state);
  let changed = false;
  const origins = new Map();
  for (const incident of nextState.incidents) {
    if (incident.status !== 'open' || incident.originCampaignId === currentCampaignId) {
      continue;
    }
    const currentSequence = origins.get(incident.originCampaignId);
    origins.set(
      incident.originCampaignId,
      currentSequence === undefined
        ? incident.sequence
        : Math.min(currentSequence, incident.sequence),
    );
  }
  const orderedOrigins = [...origins.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([campaignId]) => campaignId);
  for (const campaignId of orderedOrigins) {
    const campaign = readCampaign(sqliteBin, dbPath, campaignId);
    const plan = planForCampaign(nextState, campaign, campaignId);
    nextState = plan.nextState;
    changed ||= plan.changed;
    if (plan.event) {
      return { nextState, changed, event: plan.event };
    }
  }
  return { nextState, changed, event: null };
}

function enqueueEvent(state, event) {
  if (state.outbox.length >= MAX_OUTBOX_EVENTS) {
    fail('Alert outbox is full.', 75);
  }
  state.outbox.push(event);
  if (event.phase === 'detected') {
    state.nextSequence = Math.max(state.nextSequence, event.sequence + 1);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = readConfig(options.config);
  if (!config || !config.enabled) {
    writeOutcome({ success: true, action: 'disabled' });
    return;
  }

  const lock = acquireStateLock(options.state);
  if (!lock) {
    writeOutcome({ success: true, action: 'busy' });
    return;
  }
  try {
    const state = readState(options.state);
    const initialCampaign = readCampaign(
      options.sqlitebin,
      options.db,
      options.campaignid,
    );
    if (options.dryRun) {
      const validated = validateOutboxHead(
        state,
        options.sqlitebin,
        options.db,
      );
      const historical = reconcileNonCurrentIncidents(
        validated.nextState,
        options.sqlitebin,
        options.db,
        options.campaignid,
      );
      const plan = planForCampaign(
        historical.nextState,
        initialCampaign,
        options.campaignid,
      );
      const event = plan.nextState.outbox[0] ?? historical.event ?? plan.event;
      if (!event) {
        writeOutcome({
          success: true,
          action: initialCampaign ? 'no_change' : 'campaign_missing',
        });
        return;
      }
      deliver(config, event, true);
      writeOutcome({
        success: true,
        action: 'previewed',
        phase: event.phase,
        eventId: event.eventId,
      });
      return;
    }

    let nextState = state;
    const deliveredEvents = [];
    for (let iteration = 0; iteration < MAX_DRAIN_EVENTS; iteration++) {
      const validated = validateOutboxHead(
        nextState,
        options.sqlitebin,
        options.db,
      );
      nextState = validated.nextState;
      let stateChanged = validated.changed;

      // A full queue must still be drainable. Once one event succeeds, the
      // next iteration captures any newly observed failure into the free slot.
      if (nextState.outbox.length < MAX_OUTBOX_EVENTS) {
        const historical = reconcileNonCurrentIncidents(
          nextState,
          options.sqlitebin,
          options.db,
          options.campaignid,
        );
        nextState = historical.nextState;
        stateChanged ||= historical.changed;
        if (historical.event) {
          enqueueEvent(nextState, historical.event);
          stateChanged = true;
        }
      }
      if (nextState.outbox.length < MAX_OUTBOX_EVENTS) {
        const currentCampaign = readCampaign(
          options.sqlitebin,
          options.db,
          options.campaignid,
        );
        const plan = planForCampaign(
          nextState,
          currentCampaign,
          options.campaignid,
        );
        nextState = plan.nextState;
        stateChanged ||= plan.changed;
        if (plan.event) {
          enqueueEvent(nextState, plan.event);
          stateChanged = true;
        }
      }
      if (stateChanged) atomicWriteState(options.state, nextState);

      // Re-read the actual FIFO head immediately before delivery so a
      // concurrent cancellation or recovery reversal cannot reuse an older
      // campaign snapshot.
      const revalidated = validateOutboxHead(
        nextState,
        options.sqlitebin,
        options.db,
      );
      nextState = revalidated.nextState;
      if (revalidated.changed) atomicWriteState(options.state, nextState);

      const event = nextState.outbox[0];
      if (!event) break;
      deliver(config, event, false);
      const delivered = nextState.outbox.shift();
      if (!delivered || delivered.eventId !== event.eventId) {
        fail('Alert outbox changed unexpectedly.', 75);
      }
      recordDelivered(nextState, event);

      // The runner may currently be evaluating campaign B while the FIFO head
      // belongs to completed campaign A. Re-plan A immediately so a queued
      // failure that already succeeded is followed by its factual recovery.
      const originCampaign = readCampaign(
        options.sqlitebin,
        options.db,
        event.campaignId,
      );
      const originPlan = planForCampaign(
        nextState,
        originCampaign,
        event.campaignId,
      );
      nextState = originPlan.nextState;
      if (originPlan.event) enqueueEvent(nextState, originPlan.event);
      atomicWriteState(options.state, nextState);
      deliveredEvents.push(event);
      if (iteration === MAX_DRAIN_EVENTS - 1) {
        fail('Alert outbox could not be drained safely.', 75);
      }
    }

    if (deliveredEvents.length === 0) {
      writeOutcome({
        success: true,
        action: initialCampaign ? 'no_change' : 'campaign_missing',
      });
      return;
    }
    writeOutcome({
      success: true,
      action: 'sent',
      count: deliveredEvents.length,
      phases: [...new Set(deliveredEvents.map(event => event.phase))],
      eventIds: deliveredEvents.map(event => event.eventId),
    });
  } finally {
    lock.release();
  }
}

try {
  main();
} catch (error) {
  const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  const safeMessages = new Set([
    usage(),
    'Invalid campaign identifier.',
    'Alert configuration parent must be a regular directory.',
    'Alert configuration parent must be owned by the current user.',
    'Alert configuration parent permissions must not allow group or other access.',
    'Alert configuration could not be read safely.',
    'Alert configuration has an unsupported shape.',
    'Alert target is invalid.',
    'Alert sender is unavailable.',
    'Alert sender must be a single-link regular file.',
    'Alert sender must be owned by the current user.',
    'Alert sender must not be group- or other-writable.',
    'Alert sender parent path is unsafe.',
    'Alert sender changed after validation.',
    'Alert state parent must be a regular directory.',
    'Alert state parent must be owned by the current user.',
    'Alert state parent permissions must not allow group or other access.',
    'Alert state could not be read safely.',
    'Alert state has an unsupported shape.',
    'Alert state contains an invalid incident.',
    'Alert state contains an invalid queued event.',
    'Alert state has an invalid sequence cursor.',
    'Alert state lock is unsafe.',
    'Alert outbox is full.',
    'Alert outbox changed unexpectedly.',
    'Alert outbox could not be drained safely.',
    'Could not inspect the analysis campaign.',
    'Analysis campaign inspection returned invalid data.',
    'Analysis campaign inspection was ambiguous.',
    'Analysis campaign has an invalid shape.',
    'Analysis campaign item has an invalid shape.',
    'TeamTalk alert preflight failed.',
    'TeamTalk alert configuration is unavailable.',
    'TeamTalk alert delivery failed.',
  ]);
  const message = safeMessages.has(error?.message)
    ? error.message
    : 'Analysis alert failed safely.';
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCode;
}
