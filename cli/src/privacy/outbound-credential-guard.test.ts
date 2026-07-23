import { describe, expect, it } from 'vitest';
import {
  guardOutboundCredentials,
  type RedactionReportEntry,
} from './outbound-credential-guard.js';

interface TestContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface TestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | TestContentBlock[];
  metadata?: { traceId: string };
}

function guardText(
  content: string,
  knownSecrets: string[] = [],
): { content: string; report: RedactionReportEntry[] } {
  const result = guardOutboundCredentials<TestMessage>(
    [{ role: 'user', content }],
    { provider: 'openai', knownSecrets },
  );
  return {
    content: result.messages[0].content as string,
    report: result.report,
  };
}

/** Keep credential-shaped fixtures out of static secret-scanner signatures. */
function runtimeFixture(...parts: string[]): string {
  return parts.join('');
}

describe('guardOutboundCredentials provider policy', () => {
  it.each(['ollama', 'llamacpp'])(
    'guards local-compatible provider %s because its endpoint may be remote',
    (provider) => {
      const messages: TestMessage[] = [{
        role: 'user',
        content: 'Authorization: Bearer local-development-token-value',
      }];

      const result = guardOutboundCredentials(messages, { provider });

      expect(result.messages).not.toBe(messages);
      expect(result.messages[0]).not.toBe(messages[0]);
      expect(result.messages[0].content).toBe(
        'Authorization: Bearer [REDACTED:authorization]',
      );
      expect(result.report).toEqual([{
        category: 'authorization',
        count: 1,
        messageIndex: 0,
      }]);
      expect(messages[0].content).toContain('local-development-token-value');
    },
  );

  it.each(['anthropic', 'openai', 'gemini'])(
    'clones and guards cloud provider %s',
    (provider) => {
      const messages: TestMessage[] = [{
        role: 'user',
        content: 'secret=exact-config-secret',
        metadata: { traceId: 'trace-1' },
      }];

      const result = guardOutboundCredentials(messages, {
        provider,
        knownSecrets: ['exact-config-secret'],
      });

      expect(result.messages).not.toBe(messages);
      expect(result.messages[0]).not.toBe(messages[0]);
      expect(result.messages[0]).toEqual({
        role: 'user',
        content: 'secret=[REDACTED:credential-assignment]',
        metadata: { traceId: 'trace-1' },
      });
      expect(messages[0].content).toBe('secret=exact-config-secret');
    },
  );

  it('clones Anthropic content blocks while preserving type and cache_control', () => {
    const cacheControl = { type: 'ephemeral' as const };
    const messages: TestMessage[] = [{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Authorization: Bearer bearer-secret-value-123456',
        cache_control: cacheControl,
      }],
    }];

    const result = guardOutboundCredentials(messages, { provider: 'anthropic' });
    const blocks = result.messages[0].content as TestContentBlock[];

    expect(blocks).not.toBe(messages[0].content);
    expect(blocks[0]).not.toBe((messages[0].content as TestContentBlock[])[0]);
    expect(blocks[0]).toEqual({
      type: 'text',
      text: 'Authorization: Bearer [REDACTED:authorization]',
      cache_control: { type: 'ephemeral' },
    });
    expect(result.report).toEqual([{
      category: 'authorization',
      count: 1,
      messageIndex: 0,
      blockIndex: 0,
    }]);
  });

  it('rejects an unknown provider at runtime', () => {
    expect(() => guardOutboundCredentials<TestMessage>(
      [{ role: 'user', content: 'hello' }],
      { provider: 'future-cloud' },
    )).toThrow('Unknown outbound provider');
  });
});

describe('guardOutboundCredentials credential families', () => {
  it('redacts known secrets exactly, including values without a recognizable shape', () => {
    const secret = 'company-internal-credential';
    const result = guardText(
      `before ${secret} middle ${secret}ish after`,
      [secret],
    );

    expect(result.content).toBe(
      'before [REDACTED:known-secret] middle [REDACTED:known-secret]ish after',
    );
    expect(result.report).toEqual([{
      category: 'known-secret',
      count: 2,
      messageIndex: 0,
    }]);
  });

  it('redacts fixed-prefix provider and service tokens', () => {
    const result = guardText([
      runtimeFixture('sk', '-proj-abcdefghijklmnopqrstuvwxyz012345'),
      runtimeFixture('sk', '-ant-api03-abcdefghijklmnopqrstuvwxyz012345'),
      runtimeFixture('gh', 'p_abcdefghijklmnopqrstuvwxyz0123456789'),
      runtimeFixture('github_', 'pat_abcdefghijklmnopqrstuvwxyz0123456789'),
      runtimeFixture('AI', 'zaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234567'),
      runtimeFixture('xox', 'b-123456789012-abcdefghijklmnopqrstuvwx'),
      runtimeFixture('np', 'm_abcdefghijklmnopqrstuvwxyz0123456789'),
      runtimeFixture('h', 'f_abcdefghijklmnopqrstuvwxyz0123456789'),
      runtimeFixture('gl', 'pat-abcdefghijklmnopqrstuvwxyz0123456789'),
      runtimeFixture('AK', 'IAABCDEFGHIJKLMNOP'),
      runtimeFixture('sk', '_live_abcdefghijklmnopqrstuvwxyz012345'),
    ].join(' '));

    expect(result.content).not.toMatch(/sk-proj-|sk-ant-|ghp_|github_pat_|AIza|xoxb-|npm_|hf_|glpat-|AKIA|sk_live_/);
    expect(result.report).toEqual([{
      category: 'fixed-prefix-token',
      count: 11,
      messageIndex: 0,
    }]);
  });

  it('redacts JWTs', () => {
    const jwt = [
      runtimeFixture('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'),
      runtimeFixture('eyJ', 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkphbmUifQ'),
      runtimeFixture('abcdefghijklmnop', 'qrstuvwxyz0123456789_-'),
    ].join('.');

    const result = guardText(`token ${jwt}`);

    expect(result.content).toBe('token [REDACTED:jwt]');
    expect(result.report[0]).toMatchObject({ category: 'jwt', count: 1 });
  });

  it('redacts Bearer and Basic authorization values', () => {
    const result = guardText([
      'Authorization: Bearer bearer-secret-value-123456',
      'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==',
      '"Authorization": "Bearer json-bearer-secret-value-123456"',
      'curl uses Bearer standalone-bearer-secret-value-123456',
    ].join('\n'));

    expect(result.content).toBe([
      'Authorization: Bearer [REDACTED:authorization]',
      'Proxy-Authorization: Basic [REDACTED:authorization]',
      '"Authorization": "Bearer [REDACTED:authorization]"',
      'curl uses Bearer [REDACTED:authorization]',
    ].join('\n'));
    expect(result.report[0]).toMatchObject({ category: 'authorization', count: 4 });
  });

  it('redacts Token and other valid token authorization schemes', () => {
    const result = guardText([
      'Authorization: Token token-auth-secret-SENTINEL-1',
      'Proxy-Authorization: ApiKey api-key-auth-secret-SENTINEL-2',
      '"Authorization": "DPoP dpop-auth-secret-SENTINEL-3"',
    ].join('\n'));

    expect(result.content).toBe([
      'Authorization: Token [REDACTED:authorization]',
      'Proxy-Authorization: ApiKey [REDACTED:authorization]',
      '"Authorization": "DPoP [REDACTED:authorization]"',
    ].join('\n'));
    expect(result.report).toEqual([{
      category: 'authorization',
      count: 3,
      messageIndex: 0,
    }]);
  });

  it('redacts the complete Digest credential parameter segment in headers and YAML', () => {
    const result = guardText([
      'Authorization: Digest username="alice", realm="members", nonce="digest-nonce-SENTINEL", uri="/private", response="digest-response-SENTINEL"',
      'X-Safe: visible',
      'request:',
      '  Authorization: Digest username="bob", nonce="yaml-nonce-SENTINEL", response="yaml-response-SENTINEL"',
      '  safe: visible',
    ].join('\n'));

    expect(result.content).toBe([
      'Authorization: Digest [REDACTED:authorization]',
      'X-Safe: visible',
      'request:',
      '  Authorization: Digest [REDACTED:authorization]',
      '  safe: visible',
    ].join('\n'));
    expect(result.content).not.toContain('SENTINEL');
    expect(result.report).toEqual([{
      category: 'authorization',
      count: 2,
      messageIndex: 0,
    }]);
  });

  it('redacts the complete AWS SigV4 credential segment in JSON without swallowing safe fields', () => {
    const awsAccessKey = runtimeFixture('AK', 'IAABCDEFGHIJKLMNOP');
    const result = guardText(
      `{"headers":{"Authorization":"AWS4-HMAC-SHA256 Credential=${awsAccessKey}/20260718/cn-north-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=aws-signature-SENTINEL"},"safe":"visible"}`,
    );

    expect(result.content).toBe(
      '{"headers":{"Authorization":"AWS4-HMAC-SHA256 [REDACTED:authorization]"},"safe":"visible"}',
    );
    expect(result.content).not.toMatch(new RegExp(
      `Credential|SignedHeaders|Signature|SENTINEL|${awsAccessKey}`,
    ));
    expect(result.report).toEqual([{
      category: 'authorization',
      count: 1,
      messageIndex: 0,
    }]);
  });

  it('redacts an arbitrary valid authorization scheme in curl without swallowing adjacent arguments', () => {
    const result = guardText(
      'curl --header \'Authorization: Custom+Scheme token="curl-token-SENTINEL", nonce="curl-nonce-SENTINEL", response="curl-response-SENTINEL"\' --header \'X-Safe: visible\' https://example.com',
    );

    expect(result.content).toBe(
      'curl --header \'Authorization: Custom+Scheme [REDACTED:authorization]\' --header \'X-Safe: visible\' https://example.com',
    );
    expect(result.content).not.toContain('SENTINEL');
    expect(result.content).toContain('--header \'X-Safe: visible\'');
    expect(result.report).toEqual([{
      category: 'authorization',
      count: 1,
      messageIndex: 0,
    }]);
  });

  it('redacts an arbitrary valid scheme in YAML flow without swallowing the next field', () => {
    const result = guardText(
      'request: { Authorization: Fancy~Auth nonce="flow-nonce-SENTINEL", response="flow-response-SENTINEL", safe: visible }',
    );

    expect(result.content).toBe(
      'request: { Authorization: Fancy~Auth [REDACTED:authorization], safe: visible }',
    );
    expect(result.content).not.toContain('SENTINEL');
    expect(result.content).toContain('safe: visible');
    expect(result.report).toEqual([{
      category: 'authorization',
      count: 1,
      messageIndex: 0,
    }]);
  });

  it('redacts API key and auth token header values', () => {
    const result = guardText([
      'x-api-key: header-secret-value-123456',
      'api-key = another-header-secret-123456',
      'x-auth-token: auth-token-secret-value-123456',
      '"x-api-key": "json-header-secret-value-123456"',
    ].join('\n'));

    expect(result.content).not.toContain('header-secret');
    expect(result.content).not.toContain('auth-token-secret');
    expect(result.report[0]).toMatchObject({ category: 'api-key-header', count: 4 });
  });

  it('redacts env, JSON, YAML, and shell credential assignments', () => {
    const result = guardText([
      'OPENAI_API_KEY=env-secret-value-123456',
      'export DATABASE_PASSWORD="shell-secret-value-123456"',
      '"accessToken": "json-secret-value-123456",',
      "client_secret: 'yaml-secret-value-123456'",
      'AWS_SECRET_ACCESS_KEY=aws-secret-value-123456',
      'PRIVATE_TOKEN=generic-token-value-123456',
      'authorization=authorization-assignment-value-123456',
      '{"safe":"visible","apiKey":"inline-json-secret-value-123456"}',
      'flow: { client_secret: inline-yaml-secret-value-123456 }',
    ].join('\n'));

    expect(result.content).not.toMatch(
      /env-secret|shell-secret|json-secret|yaml-secret|aws-secret|generic-token|authorization-assignment|inline-json-secret|inline-yaml-secret/,
    );
    expect(result.content).toContain(
      '{"safe":"visible","apiKey":"[REDACTED:credential-assignment]"}',
    );
    expect(result.content).toContain(
      'flow: { client_secret: [REDACTED:credential-assignment] }',
    );
    expect(result.report[0]).toMatchObject({ category: 'credential-assignment', count: 9 });
  });

  it('redacts PEM, OpenSSH, and PGP private material as whole blocks', () => {
    const result = guardText([
      runtimeFixture('-----BEGIN ', 'PRIVATE KEY-----'),
      'cHJpdmF0ZS1rZXktbWF0ZXJpYWw=',
      runtimeFixture('-----END ', 'PRIVATE KEY-----'),
      runtimeFixture('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'),
      'b3BlbnNzaC1wcml2YXRlLWtleQ==',
      runtimeFixture('-----END OPENSSH ', 'PRIVATE KEY-----'),
      runtimeFixture('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----'),
      'cGdwLXByaXZhdGUta2V5',
      runtimeFixture('-----END PGP ', 'PRIVATE KEY BLOCK-----'),
    ].join('\n'));

    expect(result.content).toBe([
      '[REDACTED:private-key]',
      '[REDACTED:private-key]',
      '[REDACTED:private-key]',
    ].join('\n'));
    expect(result.report[0]).toMatchObject({ category: 'private-key', count: 3 });
  });

  it('redacts a truncated private key from its BEGIN marker to the message end', () => {
    const result = guardText([
      'safe prefix',
      runtimeFixture('-----BEGIN ', 'PRIVATE KEY-----'),
      'c2Vuc2l0aXZlLWtleS1tYXRlcmlhbA==',
      'truncated private material',
    ].join('\n'));

    expect(result.content).toBe('safe prefix\n[REDACTED:private-key]');
    expect(result.report).toEqual([{
      category: 'private-key',
      count: 1,
      messageIndex: 0,
    }]);
  });

  it('recognizes a truncated encrypted private key', () => {
    const result = guardText([
      runtimeFixture('-----BEGIN ENCRYPTED ', 'PRIVATE KEY-----'),
      'ZW5jcnlwdGVkLXByaXZhdGUta2V5',
    ].join('\n'));

    expect(result.content).toBe('[REDACTED:private-key]');
    expect(result.report[0]).toMatchObject({
      category: 'private-key',
      count: 1,
    });
  });

  it('keeps safe text after a complete encrypted private-key block', () => {
    const result = guardText([
      runtimeFixture('-----BEGIN ENCRYPTED ', 'PRIVATE KEY-----'),
      'ZW5jcnlwdGVkLXByaXZhdGUta2V5',
      runtimeFixture('-----END ENCRYPTED ', 'PRIVATE KEY-----'),
      'safe suffix',
    ].join('\n'));

    expect(result.content).toBe(
      '[REDACTED:private-key]\nsafe suffix',
    );
    expect(result.report[0]).toMatchObject({
      category: 'private-key',
      count: 1,
    });
  });

  it('limits a truncated key to its content block and preserves block metadata', () => {
    const messages: TestMessage[] = [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            'safe prefix',
            runtimeFixture('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'),
            'dHJ1bmNhdGVkLWtleQ==',
          ].join('\n'),
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: 'safe next block',
        },
      ],
    }];

    const result = guardOutboundCredentials(messages, { provider: 'anthropic' });

    expect(result.messages[0].content).toEqual([
      {
        type: 'text',
        text: 'safe prefix\n[REDACTED:private-key]',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: 'safe next block',
      },
    ]);
    expect(result.report).toEqual([{
      category: 'private-key',
      count: 1,
      messageIndex: 0,
      blockIndex: 0,
    }]);
  });

  it('redacts credentials embedded in HTTP and database URLs', () => {
    const result = guardText([
      'https://alice:super-secret-password@example.com/path',
      'postgresql://dbuser:db-password@db.example.com:5432/app',
      'mongodb+srv://mongo-user:mongo-password@cluster.example.com/app',
      'https://single-userinfo-token-value-123456@example.com/path',
    ].join('\n'));

    expect(result.content).toBe([
      'https://[REDACTED:credential-url]@example.com/path',
      'postgresql://[REDACTED:credential-url]@db.example.com:5432/app',
      'mongodb+srv://[REDACTED:credential-url]@cluster.example.com/app',
      'https://[REDACTED:credential-url]@example.com/path',
    ].join('\n'));
    expect(result.report[0]).toMatchObject({ category: 'credential-url', count: 4 });
  });

  it('redacts signed and credential query parameter values', () => {
    const result = guardText(
      'https://example.com/file?X-Amz-Signature=abcdef0123456789&access_token=query-token-value-123456&safe=visible',
    );

    expect(result.content).toBe(
      'https://example.com/file?X-Amz-Signature=[REDACTED:query-signature]&access_token=[REDACTED:query-signature]&safe=visible',
    );
    expect(result.report[0]).toMatchObject({ category: 'query-signature', count: 2 });
  });

  it('redacts Cookie and Set-Cookie header values', () => {
    const result = guardText([
      'Cookie: session=secret-session-value; theme=dark',
      'Set-Cookie: auth=secret-auth-value; HttpOnly; Secure',
    ].join('\n'));

    expect(result.content).toBe([
      'Cookie: [REDACTED:cookie]',
      'Set-Cookie: [REDACTED:cookie]',
    ].join('\n'));
    expect(result.report[0]).toMatchObject({ category: 'cookie', count: 2 });
  });

  it('redacts JSON and flow Cookie values that are not at the start of a line', () => {
    const result = guardText([
      '{"headers":{"Cookie":"session=json-cookie-SENTINEL-4; theme=dark"},"safe":"visible"}',
      'request: { Cookie: session=flow-cookie-SENTINEL-5; theme=dark, safe: visible }',
      '{"headers":{"Set-Cookie":"auth=json-set-cookie-SENTINEL-6; HttpOnly; Secure"}}',
      'response: { Set-Cookie: auth=flow-set-cookie-SENTINEL-7; HttpOnly, safe: visible }',
    ].join('\n'));

    expect(result.content).toBe([
      '{"headers":{"Cookie":"[REDACTED:cookie]"},"safe":"visible"}',
      'request: { Cookie: [REDACTED:cookie], safe: visible }',
      '{"headers":{"Set-Cookie":"[REDACTED:cookie]"}}',
      'response: { Set-Cookie: [REDACTED:cookie], safe: visible }',
    ].join('\n'));
    expect(result.report).toEqual([{
      category: 'cookie',
      count: 4,
      messageIndex: 0,
    }]);
  });

  it('redacts npmrc authentication assignments', () => {
    const result = guardText([
      '//registry.npmjs.org/:_authToken=npmrc-token-value-123456',
      '_auth=dXNlcjpwYXNzd29yZA==',
      '//registry.npmjs.org/:_password=cGFzc3dvcmQ=',
    ].join('\n'));

    expect(result.content).toBe([
      '//registry.npmjs.org/:_authToken=[REDACTED:npmrc]',
      '_auth=[REDACTED:npmrc]',
      '//registry.npmjs.org/:_password=[REDACTED:npmrc]',
    ].join('\n'));
    expect(result.report[0]).toMatchObject({ category: 'npmrc', count: 3 });
  });
});

describe('guardOutboundCredentials precision and reporting', () => {
  it('does not redact UUIDs, hashes, SRI values, email addresses, or placeholders', () => {
    const safe = [
      '550e8400-e29b-41d4-a716-446655440000',
      '0123456789abcdef0123456789abcdef01234567',
      'sha384-YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo0123456789',
      'person@example.com',
      'OPENAI_API_KEY=${OPENAI_API_KEY}',
      'token: <TOKEN>',
      'password=your-password',
      '"secret": "[REDACTED]"',
      'api_key: changeme',
      'token: [REDACTED:known-secret]',
    ].join('\n');

    const result = guardText(safe);

    expect(result.content).toBe(safe);
    expect(result.report).toEqual([]);
  });

  it('does not treat public material or inexact prose as a private-key marker', () => {
    const safe = [
      '-----BEGIN PUBLIC KEY-----',
      'cHVibGljLWtleQ==',
      '-----END PUBLIC KEY-----',
      '-----BEGIN CERTIFICATE-----',
      'Y2VydGlmaWNhdGU=',
      '-----END CERTIFICATE-----',
      runtimeFixture('Example text: ----BEGIN ', 'PRIVATE KEY----'),
    ].join('\n');

    const result = guardText(safe);

    expect(result.content).toBe(safe);
    expect(result.report).toEqual([]);
  });

  it('chooses the contextual authorization span over an overlapping token span', () => {
    const result = guardText(
      runtimeFixture('Authorization: Bearer sk', '-proj-abcdefghijklmnopqrstuvwxyz012345'),
    );

    expect(result.content).toBe(
      'Authorization: Bearer [REDACTED:authorization]',
    );
    expect(result.report).toEqual([{
      category: 'authorization',
      count: 1,
      messageIndex: 0,
    }]);
  });

  it('reports only category, count, messageIndex, and optional blockIndex', () => {
    const secret = 'do-not-copy-this-secret';
    const result = guardText(secret, [secret]);

    expect(Object.keys(result.report[0]).sort()).toEqual([
      'category',
      'count',
      'messageIndex',
    ]);
    expect(JSON.stringify(result.report)).not.toContain(secret);
    expect(JSON.stringify(result.report)).not.toMatch(/[a-f0-9]{32,}/);
  });

  it('does not expose sentinel credentials in reports or errors', () => {
    const authorizationSentinel = 'authorization-report-SENTINEL-8';
    const cookieSentinel = 'cookie-report-SENTINEL-9';
    const providerSentinel = 'provider-error-SENTINEL-10';
    const result = guardText([
      `Authorization: Token ${authorizationSentinel}`,
      `headers: { Cookie: session=${cookieSentinel} }`,
    ].join('\n'));

    let thrown: unknown;
    try {
      guardOutboundCredentials<TestMessage>(
        [{
          role: 'user',
          content: `Authorization: Token ${authorizationSentinel}`,
        }],
        {
          provider: providerSentinel,
          knownSecrets: [authorizationSentinel, cookieSentinel],
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const observableMetadata = `${JSON.stringify(result.report)} ${String(thrown)}`;
    for (const sentinel of [
      authorizationSentinel,
      cookieSentinel,
      providerSentinel,
    ]) {
      expect(observableMetadata).not.toContain(sentinel);
    }
  });

  it('keeps its own replacement stable when the same known secret is guarded again', () => {
    const secret = 'stable-known-secret-value';
    const first = guardText(`token=${secret}`, [secret]);
    const second = guardText(first.content, [secret]);

    expect(second.content).toBe(first.content);
    expect(second.report).toEqual([]);
  });

  it('conservatively redacts the whole message when a short known secret would create excessive spans', () => {
    const result = guardText('x'.repeat(10_000), ['x']);

    expect(result.content).toBe('[REDACTED:known-secret]');
    expect(result.report).toEqual([{
      category: 'known-secret',
      count: 10_000,
      messageIndex: 0,
    }]);
  });

  it('handles very large safe input without pathological regex backtracking', () => {
    const safe = `${'a'.repeat(750_000)} UUID 550e8400-e29b-41d4-a716-446655440000`;

    const result = guardText(safe);

    expect(result.content).toBe(safe);
    expect(result.report).toEqual([]);
  });
});
