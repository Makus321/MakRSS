// CSRF: браузерные POST с чужого сайта отбиваются, скрипты и Fever — нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isCrossSiteRequest } from '../lib/csrf.mjs';

const req = (method, headers) => ({ method, headers });

test('csrf: чужой Origin и cross-site отбиваются', () => {
  assert.equal(isCrossSiteRequest(req('POST', { origin: 'https://evil.example', host: 'rss.letsplay.today' })), true);
  assert.equal(isCrossSiteRequest(req('POST', { 'sec-fetch-site': 'cross-site', host: 'rss.letsplay.today' })), true);
  assert.equal(isCrossSiteRequest(req('POST', { origin: 'null', host: 'rss.letsplay.today' })), true);
});

test('csrf: свои запросы проходят', () => {
  assert.equal(isCrossSiteRequest(req('POST', { origin: 'https://rss.letsplay.today', host: 'rss.letsplay.today' })), false);
  assert.equal(isCrossSiteRequest(req('POST', { 'sec-fetch-site': 'same-origin', host: 'rss.letsplay.today' })), false);
  // curl, скрипты и клиенты Fever: ни Origin, ни Sec-Fetch-Site
  assert.equal(isCrossSiteRequest(req('POST', { host: 'rss.letsplay.today' })), false);
  assert.equal(isCrossSiteRequest(req('GET', { origin: 'https://evil.example' })), false);
});
