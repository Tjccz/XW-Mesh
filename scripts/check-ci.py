"""校验 CI 流水线与部署配置的一致性。

本机既没有 Docker、也不会真的跑 GitHub Actions，
所以「workflow 与 compose 对不上」这类错误只能在推送后由用户发现。
这个脚本把这些检查搬到本地，推之前就能拦住。

检查项：
  1. 所有 YAML 文件语法可解析
  2. workflow 里引用的 Dockerfile 路径真实存在
  3. compose 的镜像标签 == server/package.json 的版本号
  4. compose 的镜像名 == workflow 实际推送的镜像名
  5. workflow 具备推送镜像所需的 permissions / 关键步骤齐全

用法：
    python scripts/check-ci.py
退出码 0 = 全部通过，1 = 有 FAIL。
"""

import json
import os
import re
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ok_count = 0
failures = []


def check(desc, cond, detail=''):
    global ok_count
    if cond:
        ok_count += 1
        print(f'  \u2713 {desc}')
    else:
        failures.append(desc)
        print(f'  \u2717 {desc}' + (f'   {detail}' if detail else ''))


def rel(p):
    return os.path.join(ROOT, p)


def read_yaml(p):
    with open(rel(p), encoding='utf-8') as fh:
        return yaml.safe_load(fh)


def read_text(p):
    with open(rel(p), encoding='utf-8') as fh:
        return fh.read()


# ── 1. YAML 语法 ────────────────────────────────────────────────
print('1. YAML 语法')

yaml_files = []
for base, dirs, files in os.walk(ROOT):
    if '.git' in base or 'node_modules' in base:
        continue
    for f in files:
        if f.endswith(('.yml', '.yaml')):
            yaml_files.append(os.path.relpath(os.path.join(base, f), ROOT))
yaml_files.sort()

parsed = {}
for p in yaml_files:
    try:
        parsed[p] = read_yaml(p)
        check(p, True)
    except Exception as exc:                       # noqa: BLE001
        check(p, False, str(exc).replace('\n', ' ')[:120])

# ── 2. workflow 引用的 Dockerfile 是否存在 ──────────────────────
print()
print('2. workflow 引用的文件')

workflow_path = '.github/workflows/docker-publish.yml'
check(f'{workflow_path} 存在', os.path.isfile(rel(workflow_path)))

if os.path.isfile(rel(workflow_path)):
    wf_text = read_text(workflow_path)
    dockerfiles = re.findall(r'file:\s*([^\s#]+)', wf_text)
    check('能从 workflow 中解析出 Dockerfile 路径', len(dockerfiles) > 0)
    for df in dockerfiles:
        check(f'Dockerfile 存在：{df}', os.path.isfile(rel(df)))

    # workflow 里用到的、本仓库内的其它路径
    for extra in ('server/package.json', 'web/package-lock.json',
                  'scripts/check-dockerignore.py'):
        check(f'依赖文件存在：{extra}', os.path.isfile(rel(extra)))

# ── 3. 版本号一致性 ────────────────────────────────────────────
print()
print('3. 版本号一致性')

with open(rel('server/package.json'), encoding='utf-8') as fh:
    server_pkg = json.load(fh)
version = server_pkg.get('version', '')
print(f'  · server/package.json 版本：{version}')
check('版本号非空', bool(version))

with open(rel('web/package.json'), encoding='utf-8') as fh:
    web_version = json.load(fh).get('version', '')
check('web 与 server 版本号一致', web_version == version,
      f'web={web_version} server={version}')

# Dockerfile.slim 里的 XW_VERSION 默认值
slim = read_text('deploy/dockge/Dockerfile.slim')
m = re.search(r'XW_VERSION=([0-9]+\.[0-9]+\.[0-9]+)', slim)
check('Dockerfile.slim 的 XW_VERSION 与 package.json 一致',
      bool(m) and m.group(1) == version,
      f'Dockerfile={m.group(1) if m else "未找到"} package={version}')

# ── 4. compose 镜像名与标签 ────────────────────────────────────
print()
print('4. compose 镜像引用')

# workflow 实际推送的镜像名（`计算镜像名` 步骤里拼出来的）
wf_images = set()
if os.path.isfile(rel(workflow_path)):
    wf_images = set(re.findall(r'/(xw-mesh-[a-z0-9-]+)"', wf_text))
check('workflow 中能识别出镜像名', len(wf_images) > 0, str(wf_images))

for comp in ('deploy/dockge/compose.yaml', 'deploy/dockge/compose.full.yaml'):
    if not os.path.isfile(rel(comp)):
        check(f'{comp} 存在', False)
        continue
    text = read_text(comp)
    images = re.findall(r'image:\s*\$\{[A-Z_]+:-([^}]+)\}', text)
    check(f'{comp} 使用了可覆盖的镜像变量', len(images) > 0)
    for img in images:
        name, _, tag = img.rpartition(':')
        check(f'{comp} 镜像标签 {tag} == package.json 版本 {version}',
              tag == version, f'镜像={tag} package={version}')
        check(f'{comp} 镜像名 {name} 在 workflow 的推送名单内',
              name.rsplit('/', 1)[-1] in wf_images,
              f'{name.rsplit("/", 1)[-1]} not in {wf_images}')

# ── 5. workflow 关键结构 ───────────────────────────────────────
print()
print('5. workflow 关键结构')

if os.path.isfile(rel(workflow_path)):
    check('声明了 packages: write 权限', 'packages: write' in wf_text)
    check('声明了 workflow_dispatch（可手动触发）',
          'workflow_dispatch' in wf_text)
    check('登录 GHCR 用的是 GITHUB_TOKEN，无需用户配 secret',
          'secrets.GITHUB_TOKEN' in wf_text)
    check('输出了可匿名拉取的镜像地址',
          'ghcr.io' in wf_text and 'docker pull' in wf_text)

# ── 汇总 ───────────────────────────────────────────────────────
print()
print('─' * 60)
if failures:
    print(f'有 {len(failures)} 项未通过：')
    for f in failures:
        print(f'  · {f}')
    sys.exit(1)
print(f'全部通过  {ok_count} 项检查')
