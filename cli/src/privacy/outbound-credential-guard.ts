/**
 * One outbound credential boundary shared by the CLI and server LLM paths.
 *
 * Every supported provider receives cloned, redacted messages. Provider names
 * do not establish endpoint locality: Ollama and llama.cpp may target a remote
 * custom URL, so they cross the same credential boundary as cloud adapters.
 * Reports intentionally contain location/count metadata only.
 */

export type OutboundCredentialCategory =
  | 'known-secret'
  | 'fixed-prefix-token'
  | 'jwt'
  | 'authorization'
  | 'api-key-header'
  | 'credential-assignment'
  | 'private-key'
  | 'credential-url'
  | 'query-signature'
  | 'cookie'
  | 'npmrc';

export interface RedactionReportEntry {
  category: OutboundCredentialCategory;
  count: number;
  messageIndex: number;
  blockIndex?: number;
}

export interface GuardContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface GuardableOutboundMessage {
  content: string | GuardContentBlock[];
}

export interface OutboundCredentialGuardOptions {
  provider: string;
  knownSecrets?: readonly string[];
}

export interface OutboundCredentialGuardResult<T> {
  messages: T[];
  report: RedactionReportEntry[];
}

interface CandidateSpan {
  start: number;
  end: number;
  category: OutboundCredentialCategory;
  priority: number;
  count?: number;
}

interface RedactedText {
  text: string;
  counts: Map<OutboundCredentialCategory, number>;
}

const SUPPORTED_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'llamacpp',
]);
const MAX_KNOWN_SECRET_SPANS = 256;

const PRIORITY = {
  privateKey: 120,
  cookie: 115,
  authorization: 110,
  apiKeyHeader: 108,
  npmrc: 106,
  credentialUrl: 104,
  querySignature: 102,
  assignment: 100,
  knownSecret: 90,
  fixedPrefix: 80,
  jwt: 70,
} as const;

const FIXED_PREFIX_PATTERNS = [
  /\bsk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\b(?:npm_|hf_)[A-Za-z0-9_-]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
];

const JWT_PATTERN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{7,}\.eyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g;
const URL_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s<>"']+/g;
const QUERY_PARAMETER_PATTERN = /[?&]([A-Za-z0-9_.-]{1,64})=([^&#\s"']{1,4096})/g;

const QUERY_SECRET_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authtoken',
  'clientsecret',
  'password',
  'refreshtoken',
  'sig',
  'signature',
  'token',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
  'xgoogcredential',
  'xgoogsignature',
]);

function privateKeyMarker(action: 'BEGIN' | 'END', kind: string): string {
  return ['-----', action, ' ', kind, '-----'].join('');
}

const PRIVATE_KEY_MARKERS = [
  [privateKeyMarker('BEGIN', 'PRIVATE KEY'), privateKeyMarker('END', 'PRIVATE KEY')],
  [privateKeyMarker('BEGIN', 'ENCRYPTED PRIVATE KEY'), privateKeyMarker('END', 'ENCRYPTED PRIVATE KEY')],
  [privateKeyMarker('BEGIN', 'RSA PRIVATE KEY'), privateKeyMarker('END', 'RSA PRIVATE KEY')],
  [privateKeyMarker('BEGIN', 'EC PRIVATE KEY'), privateKeyMarker('END', 'EC PRIVATE KEY')],
  [privateKeyMarker('BEGIN', 'DSA PRIVATE KEY'), privateKeyMarker('END', 'DSA PRIVATE KEY')],
  [privateKeyMarker('BEGIN', 'OPENSSH PRIVATE KEY'), privateKeyMarker('END', 'OPENSSH PRIVATE KEY')],
  [privateKeyMarker('BEGIN', 'PGP PRIVATE KEY BLOCK'), privateKeyMarker('END', 'PGP PRIVATE KEY BLOCK')],
] as const;

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isCredentialKey(value: string): boolean {
  const key = normalizedKey(value);
  return [
    'apikey',
    'accesstoken',
    'authtoken',
    'refreshtoken',
    'clientsecret',
    'secretaccesskey',
    'accesskey',
    'secretkey',
    'secret',
    'token',
    'password',
    'passwd',
    'pwd',
    'credential',
    'credentials',
    'privatekey',
    'databaseurl',
    'dburl',
  ].some((suffix) => key.endsWith(suffix));
}

function unquoted(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed[0] === '"' && trimmed.at(-1) === '"')
      || (trimmed[0] === "'" && trimmed.at(-1) === "'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isPlaceholder(value: string): boolean {
  const candidate = unquoted(value);
  const lower = candidate.toLowerCase();
  if (!candidate) return true;
  if (
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(candidate)
    || /^\{\{[^{}\r\n]{1,128}\}\}$/.test(candidate)
    || /^<[^<>\r\n]{1,128}>$/.test(candidate)
    || /^\[(?:redacted|masked|hidden)(?::[a-z0-9-]+)?\]$/i.test(candidate)
  ) {
    return true;
  }
  if (
    /^(?:your[-_ ]|example[-_ ]|sample[-_ ]|test[-_ ]|dummy[-_ ])/.test(lower)
    || /^(?:changeme|change-me|replace-me|redacted|masked|hidden|none|null|undefined|x{3,})$/.test(lower)
  ) {
    return true;
  }
  return false;
}

function addSpan(
  spans: CandidateSpan[],
  start: number,
  end: number,
  category: OutboundCredentialCategory,
  priority: number,
  count?: number,
): void {
  if (start >= 0 && end > start) {
    spans.push({
      start,
      end,
      category,
      priority,
      ...(count !== undefined && { count }),
    });
  }
}

function collectPatternSpans(
  text: string,
  pattern: RegExp,
  spans: CandidateSpan[],
  category: OutboundCredentialCategory,
  priority: number,
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    addSpan(spans, match.index, match.index + match[0].length, category, priority);
    if (match[0].length === 0) pattern.lastIndex++;
  }
}

function collectCapturedPatternSpans(
  text: string,
  pattern: RegExp,
  spans: CandidateSpan[],
  category: OutboundCredentialCategory,
  priority: number,
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[1];
    if (value && !isPlaceholder(value)) {
      const relativeStart = match[0].lastIndexOf(value);
      addSpan(
        spans,
        match.index + relativeStart,
        match.index + relativeStart + value.length,
        category,
        priority,
      );
    }
    if (match[0].length === 0) pattern.lastIndex++;
  }
}

function forEachLine(
  text: string,
  visit: (line: string, offset: number) => void,
): void {
  let offset = 0;
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline;
    visit(text.slice(offset, end), offset);
    if (newline === -1) break;
    offset = newline + 1;
  }
}

function trimEndIndex(line: string, start: number): number {
  let end = line.length;
  while (end > start && /\s/.test(line[end - 1])) end--;
  return end;
}

function scalarSpan(line: string, valueStart: number): { start: number; end: number } | null {
  let start = valueStart;
  while (start < line.length && /\s/.test(line[start])) start++;
  if (start >= line.length) return null;

  const quote = line[start];
  if (quote === '"' || quote === "'") {
    let cursor = start + 1;
    while (cursor < line.length) {
      if (line[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (line[cursor] === quote) {
        return { start: start + 1, end: cursor };
      }
      cursor++;
    }
    return null;
  }

  let end = start;
  while (
    end < line.length
    && !/\s/.test(line[end])
    && line[end] !== ','
    && line[end] !== ';'
    && line[end] !== '#'
  ) {
    end++;
  }
  return end > start ? { start, end } : null;
}

function collectPrivateKeySpans(text: string, spans: CandidateSpan[]): void {
  for (const [beginMarker, endMarker] of PRIVATE_KEY_MARKERS) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const start = text.indexOf(beginMarker, searchFrom);
      if (start === -1) break;
      const markerEnd = text.indexOf(endMarker, start + beginMarker.length);
      if (markerEnd === -1) {
        addSpan(spans, start, text.length, 'private-key', PRIORITY.privateKey);
        break;
      }
      const end = markerEnd + endMarker.length;
      addSpan(spans, start, end, 'private-key', PRIORITY.privateKey);
      searchFrom = end;
    }
  }
}

function collectKnownSecretSpans(
  text: string,
  knownSecrets: readonly string[],
  spans: CandidateSpan[],
): void {
  const uniqueSecrets = new Set(knownSecrets.filter((secret) => secret.length > 0));
  const knownSecretSpans: CandidateSpan[] = [];
  let occurrenceCount = 0;
  for (const secret of uniqueSecrets) {
    let searchFrom = 0;
    while (searchFrom <= text.length - secret.length) {
      const start = text.indexOf(secret, searchFrom);
      if (start === -1) break;
      occurrenceCount++;
      if (knownSecretSpans.length < MAX_KNOWN_SECRET_SPANS) {
        addSpan(
          knownSecretSpans,
          start,
          start + secret.length,
          'known-secret',
          PRIORITY.knownSecret,
        );
      }
      searchFrom = start + secret.length;
    }
  }

  if (occurrenceCount > MAX_KNOWN_SECRET_SPANS) {
    // A very short configured value can otherwise allocate one span and one
    // replacement per character. Fail closed by redacting the full message,
    // while retaining only the aggregate occurrence count.
    addSpan(
      spans,
      0,
      text.length,
      'known-secret',
      PRIORITY.privateKey + 1,
      occurrenceCount,
    );
    return;
  }
  spans.push(...knownSecretSpans);
}

function collectInlineAssignmentSpans(text: string, spans: CandidateSpan[]): void {
  const pattern = /[{\[,]\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*([:=])\s*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const isAuthorizationAssignment = normalizedKey(match[1]) === 'authorization'
      && match[2] === '=';
    if (isCredentialKey(match[1]) || isAuthorizationAssignment) {
      const value = scalarSpan(text, match.index + match[0].length);
      if (value && !isPlaceholder(text.slice(value.start, value.end))) {
        addSpan(
          spans,
          value.start,
          value.end,
          'credential-assignment',
          PRIORITY.assignment,
        );
      }
    }
    if (match[0].length === 0) pattern.lastIndex++;
  }
}

function collectInlineCookieSpans(text: string, spans: CandidateSpan[]): void {
  const pattern = /\b(?:set-cookie|cookie)\b["']?\s*:\s*/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const valueStart = match.index + match[0].length;
    const quotedValue = scalarSpan(text, valueStart);
    if (text[valueStart] === '"' || text[valueStart] === "'") {
      if (
        quotedValue
        && !isPlaceholder(text.slice(quotedValue.start, quotedValue.end))
      ) {
        addSpan(
          spans,
          quotedValue.start,
          quotedValue.end,
          'cookie',
          PRIORITY.cookie,
        );
      }
      continue;
    }

    let end = valueStart;
    while (
      end < text.length
      && text[end] !== '\n'
      && text[end] !== ','
      && text[end] !== '}'
    ) {
      end++;
    }
    while (end > valueStart && /\s/.test(text[end - 1])) end--;
    if (
      end > valueStart
      && !isPlaceholder(text.slice(valueStart, end))
    ) {
      addSpan(spans, valueStart, end, 'cookie', PRIORITY.cookie);
    }
  }
}

function collectQuotedAuthorizationSpans(
  text: string,
  spans: CandidateSpan[],
): void {
  const pattern = /\b(?:proxy-)?authorization\b["']?\s*:\s*/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = scalarSpan(text, match.index + match[0].length);
    if (!value) continue;

    const serializedValue = text.slice(value.start, value.end);
    const credentials = serializedValue.match(
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+[ \t]+(.+)$/,
    );
    if (!credentials || isPlaceholder(credentials[1])) continue;

    const relativeStart = serializedValue.length - credentials[1].length;
    addSpan(
      spans,
      value.start + relativeStart,
      value.end,
      'authorization',
      PRIORITY.authorization,
    );
  }
}

function collectShellQuotedAuthorizationSpans(
  text: string,
  spans: CandidateSpan[],
): void {
  const pattern = /\b(?:proxy-)?authorization\b["']?\s*:\s*/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const shellQuote = text[match.index - 1];
    if (shellQuote !== '"' && shellQuote !== "'") continue;

    let valueStart = match.index + match[0].length;
    while (valueStart < text.length && /[ \t]/.test(text[valueStart])) {
      valueStart++;
    }
    if (text[valueStart] === '"' || text[valueStart] === "'") continue;

    const scheme = text.slice(valueStart).match(
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+[ \t]+/,
    );
    if (!scheme) continue;

    const credentialStart = valueStart + scheme[0].length;
    let credentialEnd = credentialStart;
    while (credentialEnd < text.length) {
      if (text[credentialEnd] === '\\' && shellQuote === '"') {
        credentialEnd += 2;
        continue;
      }
      if (text[credentialEnd] === shellQuote) break;
      credentialEnd++;
    }
    if (
      credentialEnd < text.length
      && credentialEnd > credentialStart
      && !isPlaceholder(text.slice(credentialStart, credentialEnd))
    ) {
      addSpan(
        spans,
        credentialStart,
        credentialEnd,
        'authorization',
        PRIORITY.authorization,
      );
    }
  }
}

function collectUnquotedAuthorizationSpans(
  text: string,
  spans: CandidateSpan[],
): void {
  const pattern = /\b(?:proxy-)?authorization\b["']?\s*:\s*/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const surroundingQuote = text[match.index - 1];
    if (surroundingQuote === '"' || surroundingQuote === "'") continue;

    let valueStart = match.index + match[0].length;
    while (valueStart < text.length && /[ \t]/.test(text[valueStart])) {
      valueStart++;
    }
    if (text[valueStart] === '"' || text[valueStart] === "'") continue;

    const scheme = text.slice(valueStart).match(
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+[ \t]+/,
    );
    if (!scheme) continue;

    const credentialStart = valueStart + scheme[0].length;
    const newline = text.indexOf('\n', credentialStart);
    const lineEnd = newline === -1 ? text.length : newline;
    let credentialEnd = lineEnd;
    let quote: '"' | "'" | undefined;

    for (let cursor = credentialStart; cursor < lineEnd; cursor++) {
      const character = text[cursor];
      if (quote) {
        if (character === '\\') {
          cursor++;
        } else if (character === quote) {
          quote = undefined;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '}' || character === ']') {
        credentialEnd = cursor;
        break;
      }
      if (
        character === ','
        && /^\s*["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*:/.test(
          text.slice(cursor + 1, lineEnd),
        )
      ) {
        credentialEnd = cursor;
        break;
      }
    }

    while (
      credentialEnd > credentialStart
      && /\s/.test(text[credentialEnd - 1])
    ) {
      credentialEnd--;
    }
    if (
      credentialEnd > credentialStart
      && !isPlaceholder(text.slice(credentialStart, credentialEnd))
    ) {
      addSpan(
        spans,
        credentialStart,
        credentialEnd,
        'authorization',
        PRIORITY.authorization,
      );
    }
  }
}

function collectHeaderAndAssignmentSpans(text: string, spans: CandidateSpan[]): void {
  collectInlineAssignmentSpans(text, spans);
  collectInlineCookieSpans(text, spans);
  collectQuotedAuthorizationSpans(text, spans);
  collectShellQuotedAuthorizationSpans(text, spans);
  collectUnquotedAuthorizationSpans(text, spans);
  collectCapturedPatternSpans(
    text,
    /\b(?:proxy-)?authorization\b["']?\s*:\s*["']?\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s+([A-Za-z0-9._~+\/=-]{8,})/gi,
    spans,
    'authorization',
    PRIORITY.authorization,
  );
  collectCapturedPatternSpans(
    text,
    /\b(?:bearer|basic)\s+([A-Za-z0-9._~+\/=-]{8,})/gi,
    spans,
    'authorization',
    PRIORITY.authorization,
  );

  forEachLine(text, (line, offset) => {
    const apiHeader = line.match(
      /^(\s*["']?(?:x-api-key|api-key|x-auth-token|x-access-token|x-amz-security-token)["']?\s*[:=]\s*)/i,
    );
    if (apiHeader) {
      const value = scalarSpan(line, apiHeader[1].length);
      if (value && !isPlaceholder(line.slice(value.start, value.end))) {
        addSpan(
          spans,
          offset + value.start,
          offset + value.end,
          'api-key-header',
          PRIORITY.apiKeyHeader,
        );
      }
    }

    const cookie = line.match(/^(\s*(?:set-cookie|cookie)\s*:\s*)/i);
    if (cookie) {
      const start = cookie[1].length;
      const end = trimEndIndex(line, start);
      if (end > start && !isPlaceholder(line.slice(start, end))) {
        addSpan(
          spans,
          offset + start,
          offset + end,
          'cookie',
          PRIORITY.cookie,
        );
      }
    }

    const npmrc = line.match(
      /^(?:\s*\/\/[^\s:]+\/?:)?\s*(?::_authToken|_authToken|_auth|_password)\s*=\s*/i,
    );
    if (npmrc) {
      const value = scalarSpan(line, npmrc[0].length);
      if (value && !isPlaceholder(line.slice(value.start, value.end))) {
        addSpan(
          spans,
          offset + value.start,
          offset + value.end,
          'npmrc',
          PRIORITY.npmrc,
        );
      }
    }

    const withoutExport = line.replace(/^\s*export\s+/, '');
    const exportOffset = line.length - withoutExport.length;
    const equals = withoutExport.indexOf('=');
    if (equals > 0) {
      const key = withoutExport.slice(0, equals).trim().replace(/^["']|["']$/g, '');
      const isCredentialAssignment = isCredentialKey(key)
        || normalizedKey(key) === 'authorization';
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) && isCredentialAssignment) {
        const value = scalarSpan(line, exportOffset + equals + 1);
        if (value && !isPlaceholder(line.slice(value.start, value.end))) {
          addSpan(
            spans,
            offset + value.start,
            offset + value.end,
            'credential-assignment',
            PRIORITY.assignment,
          );
        }
      }
    }

    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim().replace(/^["']|["']$/g, '');
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) && isCredentialKey(key)) {
        const value = scalarSpan(line, colon + 1);
        if (value && !isPlaceholder(line.slice(value.start, value.end))) {
          addSpan(
            spans,
            offset + value.start,
            offset + value.end,
            'credential-assignment',
            PRIORITY.assignment,
          );
        }
      }
    }
  });
}

function collectUrlSpans(text: string, spans: CandidateSpan[]): void {
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const url = match[0];
    const schemeEnd = url.indexOf('://') + 3;
    const at = url.indexOf('@', schemeEnd);
    if (at !== -1) {
      const credentials = url.slice(schemeEnd, at);
      const colon = credentials.indexOf(':');
      const secretPart = colon === -1 ? credentials : credentials.slice(colon + 1);
      if (!isPlaceholder(secretPart)) {
        addSpan(
          spans,
          match.index + schemeEnd,
          match.index + at,
          'credential-url',
          PRIORITY.credentialUrl,
        );
      }
    }
    if (match[0].length === 0) URL_PATTERN.lastIndex++;
  }

  QUERY_PARAMETER_PATTERN.lastIndex = 0;
  while ((match = QUERY_PARAMETER_PATTERN.exec(text)) !== null) {
    const key = normalizedKey(match[1]);
    const value = match[2];
    if (QUERY_SECRET_KEYS.has(key) && !isPlaceholder(value)) {
      const valueOffset = match[0].length - value.length;
      addSpan(
        spans,
        match.index + valueOffset,
        match.index + match[0].length,
        'query-signature',
        PRIORITY.querySignature,
      );
    }
    if (match[0].length === 0) QUERY_PARAMETER_PATTERN.lastIndex++;
  }
}

function insertIfNonOverlapping(
  accepted: CandidateSpan[],
  candidate: CandidateSpan,
): void {
  let low = 0;
  let high = accepted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (accepted[middle].start < candidate.start) low = middle + 1;
    else high = middle;
  }

  const previous = accepted[low - 1];
  const next = accepted[low];
  if (
    (previous && previous.end > candidate.start)
    || (next && next.start < candidate.end)
  ) {
    return;
  }
  accepted.splice(low, 0, candidate);
}

function resolveOverlaps(spans: CandidateSpan[]): CandidateSpan[] {
  const byPriority = [...spans].sort((left, right) =>
    right.priority - left.priority
    || (right.end - right.start) - (left.end - left.start)
    || left.start - right.start,
  );
  const accepted: CandidateSpan[] = [];
  for (const candidate of byPriority) {
    insertIfNonOverlapping(accepted, candidate);
  }
  return accepted;
}

function redactText(text: string, knownSecrets: readonly string[]): RedactedText {
  const spans: CandidateSpan[] = [];
  collectPrivateKeySpans(text, spans);
  collectHeaderAndAssignmentSpans(text, spans);
  collectUrlSpans(text, spans);
  collectKnownSecretSpans(text, knownSecrets, spans);
  for (const pattern of FIXED_PREFIX_PATTERNS) {
    collectPatternSpans(
      text,
      pattern,
      spans,
      'fixed-prefix-token',
      PRIORITY.fixedPrefix,
    );
  }
  collectPatternSpans(text, JWT_PATTERN, spans, 'jwt', PRIORITY.jwt);

  const accepted = resolveOverlaps(spans);
  if (accepted.length === 0) {
    return { text, counts: new Map() };
  }

  const pieces: string[] = [];
  const counts = new Map<OutboundCredentialCategory, number>();
  let cursor = 0;
  for (const span of accepted) {
    pieces.push(text.slice(cursor, span.start));
    pieces.push(`[REDACTED:${span.category}]`);
    cursor = span.end;
    counts.set(span.category, (counts.get(span.category) ?? 0) + (span.count ?? 1));
  }
  pieces.push(text.slice(cursor));
  return { text: pieces.join(''), counts };
}

/**
 * Redact credential-shaped values from one text value without tying the call to
 * a transport provider. Analysis prompt construction and parsed model output
 * use this shared primitive before either value reaches a runner or durable
 * derived-data store.
 */
export function redactCredentialText(
  text: string,
  knownSecrets: readonly string[] = [],
): string {
  return redactText(text, knownSecrets).text;
}

/**
 * Clone JSON-compatible data while redacting every string value. This is used
 * for parsed model output and non-rollback derived snapshots; callers retain
 * their original value and receive a safe derived copy.
 */
export function redactCredentialValues<T>(
  value: T,
  knownSecrets: readonly string[] = [],
): T {
  const visit = (candidate: unknown): unknown => {
    if (typeof candidate === 'string') {
      return redactCredentialText(candidate, knownSecrets);
    }
    if (Array.isArray(candidate)) {
      return candidate.map(visit);
    }
    if (candidate !== null && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.entries(candidate).map(([key, entry]) => [key, visit(entry)]),
      );
    }
    return candidate;
  };

  return visit(value) as T;
}

function appendReport(
  report: RedactionReportEntry[],
  counts: Map<OutboundCredentialCategory, number>,
  messageIndex: number,
  blockIndex?: number,
): void {
  for (const [category, count] of counts) {
    report.push({
      category,
      count,
      messageIndex,
      ...(blockIndex !== undefined && { blockIndex }),
    });
  }
}

/**
 * Guard messages immediately before an LLM provider adapter receives them.
 */
export function guardOutboundCredentials<T extends GuardableOutboundMessage>(
  messages: T[],
  options: OutboundCredentialGuardOptions,
): OutboundCredentialGuardResult<T> {
  if (!SUPPORTED_PROVIDERS.has(options.provider)) {
    throw new Error('Unknown outbound provider');
  }

  const knownSecrets = options.knownSecrets ?? [];
  const report: RedactionReportEntry[] = [];
  const guardedMessages = messages.map((message, messageIndex) => {
    if (typeof message.content === 'string') {
      const guarded = redactText(message.content, knownSecrets);
      appendReport(report, guarded.counts, messageIndex);
      return { ...message, content: guarded.text } as T;
    }

    const content = message.content.map((block, blockIndex) => {
      const guarded = redactText(block.text, knownSecrets);
      appendReport(report, guarded.counts, messageIndex, blockIndex);
      return {
        ...block,
        text: guarded.text,
        ...(block.cache_control && {
          cache_control: { ...block.cache_control },
        }),
      };
    });
    return { ...message, content } as T;
  });

  return { messages: guardedMessages, report };
}
