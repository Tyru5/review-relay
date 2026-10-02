import { createHmac } from 'node:crypto';
import { expect, test } from 'bun:test';
import { parseConfig } from '../src/config.ts';
import { verifySignature } from '../src/server.ts';

test('verifySignature accepts GitHub HMAC-SHA256 and rejects anything else', () => {
  const body = '{"zen":"Keep it logically awesome."}';
  const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  expect(verifySignature('s3cret', body, sig)).toBe(true);
  expect(verifySignature('other', body, sig)).toBe(false);
  expect(verifySignature('s3cret', `${body} `, sig)).toBe(false);
  expect(verifySignature('s3cret', body, null)).toBe(false);
});

test('parseConfig applies defaults and validates trigger modes', () => {
  const config = parseConfig({ repos: [{ fullName: 'Tyru5/Agendex', localPath: '/tmp/x' }] });
  expect(config.repos[0]).toEqual({
    fullName: 'Tyru5/Agendex',
    localPath: '/tmp/x',
    trigger: 'auto',
    postToPr: false,
    github: { onPush: false, mention: '@review-relay' },
  });
  expect(config.graceMs).toBe(120_000);
  expect(() => parseConfig({ repos: [{ fullName: 'Tyru5/Agendex', localPath: '/tmp/x', trigger: 'nope' }] })).toThrow();
  expect(() => parseConfig({ repos: [] })).toThrow();
});
