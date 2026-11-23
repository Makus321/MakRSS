// Тесты сетевого фильтра: приватные адреса не должны проходить, публичные — проходить.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, assertPublicUrl } from '../lib/net-guard.mjs';

test('приватные и служебные IPv4 блокируются', () => {
  for (const ip of ['127.0.0.1', '127.10.20.30', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1']) {
    assert.equal(isBlockedAddress(ip), true, `должен блокироваться: ${ip}`);
  }
});

test('публичные IPv4 пропускаются', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.158.134.3', '172.32.0.1']) {
    assert.equal(isBlockedAddress(ip), false, `должен пропускаться: ${ip}`);
  }
});

test('IPv6: loopback, link-local, ULA и IPv4-в-IPv6 блокируются', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isBlockedAddress(ip), true, `должен блокироваться: ${ip}`);
  }
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4010:c05::64']) {
    assert.equal(isBlockedAddress(ip), false, `должен пропускаться: ${ip}`);
  }
});

test('локальные имена и недопустимые схемы отклоняются', async () => {
  const bad = ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://2130706433/',
    'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)'];
  for (const url of bad) {
    await assert.rejects(() => assertPublicUrl(url), `должен отклоняться: ${url}`);
  }
});

test('публичный IP пропускается', async () => {
  const parsed = await assertPublicUrl('http://8.8.8.8/');
  assert.equal(parsed.hostname, '8.8.8.8');
});
