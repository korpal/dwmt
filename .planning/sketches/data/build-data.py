"""Builds sketch data from a dwmt product dir (throwaway, for sketches only).

Usage: python build-data.py [project-root] [out.js]
project-root defaults to this repo (dwmt's own docs/product), out.js to data.js here.
Writes window.DWMT = {...} with roadmap, sprint files, archive, backlog,
decisions, estimates and vision. Generated data stays out of git (.gitignore).
"""
import json, os, re, sys, glob, datetime

here = os.path.dirname(os.path.abspath(__file__))
root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', '..', '..')
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, 'data.js')
P = os.path.join(root, 'docs', 'product')


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def table(text):
    rows = []
    for line in text.splitlines():
        if not line.startswith('|') or line.startswith('|---'):
            continue
        rows.append([c.strip() for c in line.strip().strip('|').split('|')])
    return rows[1:]  # skip header


def spec(path):
    text = read(path)
    head, body = {}, text
    m = re.match(r'---\n(.*?)\n---\n(.*)', text, re.S)
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            k, _, v = line.partition(':')
            v = v.strip()
            try:
                head[k.strip()] = json.loads(v)
            except ValueError:
                head[k.strip()] = v
    sections, cur = {}, None
    for line in body.splitlines():
        if line.startswith('## '):
            cur = line[3:].strip()
            sections[cur] = []
        elif cur:
            sections[cur].append(line)
    return {'header': head, 'sections': {k: '\n'.join(v).strip() for k, v in sections.items()}}


def split_after(v):
    return [a.strip() for a in v.split(',') if a.strip()] if v else []


roadmap = []
for r in table(read(os.path.join(P, 'roadmap.md'))):
    cur, id_, state, goal, after, detail, alias = (r + [''] * 7)[:7]
    roadmap.append({'id': id_, 'state': state, 'goal': goal, 'after': split_after(after),
                    'detail': detail, 'alias': alias or None, 'current': cur == '▶'})

sprints = {}
for f in glob.glob(os.path.join(P, 'sprints', '*.md')):
    sprints[os.path.basename(f)[:-3]] = spec(f)

archive = []
for r in table(read(os.path.join(P, 'archive', 'index.md'))):
    id_, goal, merged, run, files, tok = (r + [''] * 6)[:6]
    num = lambda s: None if s in ('', '-') else float(s)
    a = {'id': id_, 'goal': goal, 'merged': None if merged in ('', '-') else merged,
         'run': None if run in ('', '-') else run, 'files': num(files), 'tokensM': num(tok)}
    f = os.path.join(P, 'archive', id_ + '.md')
    if os.path.exists(f):
        s = spec(f)
        a['spec'] = s
        h = s['header']
        a['kind'] = h.get('kind')
        a['est'] = h.get('est')
        a['mode'] = h.get('mode')
        a['uat'] = (h.get('actual') or {}).get('uat')
    archive.append(a)


def jsonl(name):
    p = os.path.join(P, name)
    return [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()] if os.path.exists(p) else []


decisions = []
text = read(os.path.join(P, 'decisions.md'))
for block in re.split(r'\n(?=### PD-)', text)[1:]:
    lines = block.strip().splitlines()
    m = re.match(r'### (PD-\d+) (.*)', lines[0])
    meta = dict((k.strip(), v.strip()) for k, _, v in
                (p.partition(':') for p in lines[1].split(';')) if k.strip())
    fields = {}
    for line in lines[2:]:
        k, _, v = line.partition(':')
        if k in ('Decision', 'Why', 'Rejected', 'Against recommendation', 'Options'):
            fields[k] = v.strip()
        elif fields:
            last = list(fields)[-1]
            fields[last] += ' ' + line.strip()
    decisions.append({'id': m.group(1), 'title': m.group(2), 'area': meta.get('area'),
                      'at': meta.get('at'), 'by': meta.get('by'), **fields})

cfg = {}
cp = os.path.join(root, '.claude', 'dwmt.json')
if os.path.exists(cp):
    m = re.search(r'"language"\s*:\s*"(\w+)"', read(cp))  # config may carry comments
    cfg = {'language': m.group(1)} if m else {}

vision = read(os.path.join(P, 'vision.md')) if os.path.exists(os.path.join(P, 'vision.md')) else ''

data = {
    'project': os.path.basename(os.path.abspath(root)),
    'root': os.path.abspath(root).replace(os.sep, '/'),
    'generatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
    'language': cfg.get('language', 'en'),
    'vision': vision,
    'roadmap': roadmap,
    'sprints': sprints,
    'archive': archive,
    'backlog': jsonl('backlog.jsonl'),
    'backlogArchive': jsonl('backlog-archive.jsonl'),
    'decisions': decisions,
    'estimates': jsonl('estimates.jsonl'),
}
with open(out, 'w', encoding='utf-8') as f:
    f.write('window.DWMT = ' + json.dumps(data, ensure_ascii=False) + ';\n')
print(out, os.path.getsize(out), 'bytes;', len(roadmap), 'roadmap,', len(sprints), 'sprints,',
      len(archive), 'archive,', len(data['backlog']), 'open items,', len(decisions), 'decisions')
