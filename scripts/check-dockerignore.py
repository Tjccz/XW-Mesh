"""忠实移植 moby/patternmatcher 的匹配语义，用来验证 .dockerignore
是否会误排除 web/dist。（本机没有 Docker，用算法仿真代替实际 build-context 计算。）

参考：github.com/moby/patternmatcher
"""
import os
import re
import sys


def should_escape(ch):
    return ch in '.\\+()|{}^$'


def compile_pattern(pattern, sep='/'):
    """对应 patternmatcher.Pattern.compile"""
    reg = '^'
    i, n = 0, len(pattern)
    while i < n:
        ch = pattern[i]
        i += 1
        if ch == '*':
            if i < n and pattern[i] == '*':
                i += 1
                # 把 "**/" 当成 "**"
                if i < n and pattern[i] == sep:
                    i += 1
                if i >= n:
                    reg += '.*'                      # "**EOF" -> 匹配一切
                else:
                    reg += '((.*' + sep + ')|([^' + sep + ']*))'
                reg += '(.*' + sep + ')?'
            else:
                reg += '[^' + sep + ']*'
        elif ch == '?':
            reg += '[^' + sep + ']'
        elif should_escape(ch):
            reg += '\\' + ch
        else:
            reg += ch
    reg += '$'
    return re.compile(reg)


class Pattern:
    def __init__(self, line):
        self.exclusion = line.startswith('!')
        pat = line[1:] if self.exclusion else line
        self.cleaned = os.path.normpath(pat).replace('\\', '/')
        if self.cleaned == '.':
            self.cleaned = ''
        self.re = compile_pattern(self.cleaned)

    def match(self, path):
        return bool(self.re.match(path))


def load(path):
    pats = []
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            pats.append(Pattern(line))
    return pats


def matches_or_parent_matches(pats, file):
    """对应 patternmatcher.MatchesOrParentMatches —— 后匹配者胜出"""
    matched = False
    parent = os.path.dirname(file)
    parents = []
    while parent and parent not in ('.', '/'):
        parents.append(parent)
        parent = os.path.dirname(parent)
    parents.reverse()          # 从最浅到最深

    for p in pats:
        if p.exclusion != matched:
            continue
        m = p.match(file)
        if not m:
            for pp in parents:
                if p.match(pp):
                    m = True
                    break
        if m:
            matched = not p.exclusion
    return matched


def build_context(root, pats):
    """返回会进入构建上下文的文件列表"""
    kept = []
    for dirpath, dirnames, filenames in os.walk(root):
        if os.sep + '.git' in dirpath or dirpath.endswith(os.sep + '.git'):
            dirnames[:] = []
            continue
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace('\\', '/')
            if not matches_or_parent_matches(pats, rel):
                kept.append(rel)
    return sorted(kept)


if __name__ == '__main__':
    root = sys.argv[1]
    pats = load(os.path.join(root, '.dockerignore'))

    print('=== 生效规则解析 ===')
    for p in pats:
        print(f'  {"!" if p.exclusion else " "} {p.cleaned!r}')

    print()
    print('=== 单元自检（验证仿真本身可信） ===')
    checks = [
        ('web/node_modules/express/index.js', True,  '**/node_modules 应排除'),
        ('server/node_modules/a.js',           True,  '**/node_modules 应排除'),
        ('server/data/app.db',                 True,  'data 应排除（任意层级）'),
        ('data/app.db',                        True,  '根 data 也应排除'),
        ('deploy/dockge/data/xiangwang.db',    True,  '★ 部署目录下的库必须排除'),
        ('deploy/dockge/node-state/tok.json',  True,  '★ 节点状态必须排除'),
        ('deploy/dockge/.env',                 True,  '★ .env 必须排除（任意层级）'),
        ('.env',                               True,  '根 .env 也应排除'),
        ('docs/DESIGN.md',                     True,  'docs 应排除'),
        ('deploy/dockge/README.md',            True,  '*.md 应排除（任意层级）'),
        ('README.md',                          True,  '根 md 也应排除'),
        ('web/dist/index.html',                False, '★★ web/dist 必须保留！'),
        ('web/dist/assets/Alerts-abc.js',      False, '★★ web/dist 子文件必须保留！'),
        ('deploy/dockge/Dockerfile.slim',      False, '部署文件必须保留'),
        ('deploy/dockge/.env.example',         False, '★ .env.example 必须保留（无密钥）'),
        ('server/src/index.js',                False, '后端源码必须保留'),
        ('web/package.json',                   False, '前端清单必须保留'),
    ]
    ok = True
    for path, expect_excluded, desc in checks:
        got = matches_or_parent_matches(pats, path)
        flag = '✔' if got == expect_excluded else '✘'
        if got != expect_excluded:
            ok = False
        print(f'  {flag} {path:42s} 排除={got!s:5s} {desc}')
    print(f'  自检结果：{"全部符合预期" if ok else "存在不符，仿真或规则有问题"}')

    print()
    print('=== 实际会进入构建上下文的文件（节选） ===')
    kept = build_context(root, pats)
    dist = [f for f in kept if f.startswith('web/dist/')]
    print(f'  语境总文件数：{len(kept)}')
    print(f'  其中 web/dist/ ：{len(dist)} 个')
    for f in dist[:5]:
        print(f'    {f}')
    print()
    if 'web/dist/index.html' in kept:
        print('  ✔ web/dist/index.html 在构建上下文中 —— COPY web/dist 不会失败')
    else:
        print('  ✘ web/dist/index.html 被排除 —— docker build 会失败！')
        sys.exit(1)
    sys.exit(0 if ok else 2)
