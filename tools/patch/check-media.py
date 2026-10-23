import json
import re
import subprocess
import sys
import time

BASE = 'http://127.0.0.1:8787'
USER = 'traffic'
PASSWORD = 'Traf-test-2026'
POST = '/16426'


def curl(args):
    return subprocess.run(['curl'] + args, capture_output=True, text=True).stdout


def api(path, payload=None):
    args = ['-s', '-b', '/tmp/jopA.txt', BASE + path]
    if payload is not None:
        args += ['-H', 'content-type: application/json', '-d', json.dumps(payload)]
    return curl(args)


subprocess.run([
    'curl', '-s', '-c', '/tmp/jopA.txt', '-H', 'content-type: application/json',
    '-d', json.dumps({'user': USER, 'password': PASSWORD}), BASE + '/api/login',
], capture_output=True, text=True)

data = json.loads(api('/api/data'))
data = data.get('data') or data
target = None
for item in data.get('items') or []:
    if (item.get('link') or '').endswith(POST):
        target = item
        break
if not target:
    print('CHECK_FAIL: post not found for test user')
    sys.exit(1)

content = ''
for attempt in range(1, 5):
    body = json.loads(api('/api/bodies', {'ids': [target['id']]}))
    content = ((body.get('bodies') or {}).get(target['id']) or {}).get('content') or ''
    if '<img' in content:
        print('CHECK0 attempt', attempt, 'content_len', len(content))
        break
    print('CHECK0 attempt', attempt, 'no images yet, waiting')
    time.sleep(4)

links = re.findall(r'src="(/api/media[^"]+)"', content)
print('CHECK1 links', len(links), 'imgs', content.count('<img'),
      'own_paragraphs', len(re.findall(r'<p>\s*<img', content)))
if not links:
    print('CHECK_FAIL: no short links in body')
    sys.exit(1)

ok = 0
sizes = []
for link in links:
    out = curl(['-s', '-o', '/dev/null', '-w', '%{http_code} %{size_download} %{content_type}',
                '-b', '/tmp/jopA.txt', BASE + link])
    parts = out.split(' ')
    code = parts[0]
    size = int(parts[1]) if len(parts) > 1 else 0
    sizes.append(size)
    if code == '200' and size > 1000:
        ok += 1
    print('  ', link[:44], '->', out)
print('CHECK2 ok', ok, 'of', len(links), 'min_size', min(sizes) if sizes else 0)
print('RESULT:', 'PASS' if ok == len(links) and len(links) >= 3 else 'FAIL')
