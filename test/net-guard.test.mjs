// Тесты сетевого фильтра: приватные адреса не должны проходить, публичные — проходить.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, assertPublicUrl, SsrfError } from '../lib/net-guard.mjs';

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

test('отклонение адреса даёт SsrfError, а не общую ошибку', async () => {
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'ftp://example.com/']) {
    await assert.rejects(
      () => assertPublicUrl(url),
      (err) => err instanceof SsrfError && err.name === "SsrfError",
      `ожидали SsrfError для ${url}`,
    );
  }
  const parsed = await assertPublicUrl("http://8.8.8.8/");
  assert.equal(parsed.hostname, "8.8.8.8");
});

test('IPv6: IPv4-mapped в канонической форме и другие обходы блокируются', () => {
  // Регрессия: new URL("http://[::ffff:127.0.0.1]/") нормализует адрес в
  // ::ffff:7f00:1, а регулярка ждала точечную запись — loopback проходил.
  const blocked = [
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',      // mapped, в т.ч. 169.254.169.254
    '::7f00:1', '::a9fe:a9fe',                                     // IPv4-compatible
    '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001',  // неканонический loopback
    '64:ff9b::7f00:1', '64:ff9b:1::a9fe:a9fe',                     // NAT64
    '2002:7f00:1::', '2002:a9fe:a9fe::',                           // 6to4
    '2001::1',                                                     // Teredo
    '100::1',                                                      // discard-only
    'ff02::1',                                                     // multicast
    'fc00::1', 'fd12:3456::1', 'fe80::1', '2001:db8::1',
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedAddress(ip), true, 'должен блокироваться: ' + ip);
  }
});

test('IPv6: публичные адреса пропускаются', () => {
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4010:c05::64', '2001:4860:4860::8888']) {
    assert.equal(isBlockedAddress(ip), false, 'должен пропускаться: ' + ip);
  }
});

test('IPv6-обходы не проходят и через assertPublicUrl', async () => {
  for (const url of ['http://[::ffff:7f00:1]/', 'http://[::7f00:1]/', 'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/', 'http://[0:0:0:0:0:0:0:1]/']) {
    await assert.rejects(() => assertPublicUrl(url), SsrfError, 'должен отклоняться: ' + url);
  }
});
