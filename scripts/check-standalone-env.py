"""端到端验证单文件版 compose 的环境变量是否真的生效。

做法：把 deploy/dockge/compose.standalone.yaml 里 services.console.environment
原样解析出来，喂给后端进程跑起来，然后：
  1. 调 /api/health 确认起来了
  2. 用 ADMIN_USER / ADMIN_PASSWORD 调 /api/auth/login 确认管理员账号真被创建
  3. 检查 CONSOLE_URL 未设时会不会回退成请求 Host（拿设备接入脚本验证）

变量名写错一个字母（如 ADMIN_PASSWD）就会在这里暴露 ——
否则要等用户部署完登录不进去才发现。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import yaml

ROOT = r'C:\Users\Tjc\WorkBuddy\2026-09-28-12-43-45\xiangwang-mesh'
NODE = r'C:\Users\Tjc\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
COMPOSE = os.path.join(ROOT, 'deploy', 'dockge', 'compose.standalone.yaml')
PORT = 6099

with open(COMPOSE, encoding='utf-8') as fh:
    doc = yaml.safe_load(fh)

svc = doc['services']['console']
env = {str(k): str(v) for k, v in (svc.get('environment') or {}).items()}

print('从 compose 解析出的 environment：')
for k, v in env.items():
    shown = v if k != 'ADMIN_PASSWORD' else f'{v[:3]}***（{len(v)} 字符）'
    print(f'  {k} = {shown}')

failures = []


def check(desc, cond, detail=''):
    mark = '\u2713' if cond else '\u2717'
    print(f'  {mark} {desc}' + (f'   {detail}' if detail and not cond else ''))
    if not cond:
        failures.append(desc)


# 用 compose 里的原始值，只把端口与数据目录换成本地临时值
env['PORT'] = str(PORT)
data_dir = tempfile.mkdtemp(prefix='xw-envcheck-')
env['DATA_DIR'] = data_dir
env['NODE_ENV'] = 'production'

# compose 里没有 CONSOLE_URL —— 这正是我们要验证的「留空能回退」
print()
print(f'CONSOLE_URL 是否出现在 compose 里：{"CONSOLE_URL" in env}（预期 False，靠代码回退）')

proc = subprocess.Popen(
    [NODE, '--experimental-sqlite', 'server/src/index.js'],
    cwd=ROOT, env={**os.environ, **env},
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
)

base = f'http://127.0.0.1:{PORT}'


def req_text(method, path, headers=None):
    """取纯文本响应（接入脚本是 text/plain）"""
    r = urllib.request.Request(base + path, method=method)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.read().decode('utf-8', 'replace')


def req(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method)
    r.add_header('Content-Type', 'application/json')
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}')


try:
    print()
    print('1. 拉起服务（用 compose 里的环境变量）')
    up = False
    for _ in range(40):
        if proc.poll() is not None:
            break
        try:
            st, _b = req('GET', '/api/health')
            if st == 200:
                up = True
                break
        except Exception:
            pass
        time.sleep(0.5)
    check('服务在 compose 的环境变量下成功启动', up,
          '进程已退出' if proc.poll() is not None else '健康检查超时')

    if up:
        print()
        print('2. 管理员账号是否按 compose 里的值创建')
        st, body = req('POST', '/api/auth/login', {
            'username': env.get('ADMIN_USER', 'admin'),
            'password': env.get('ADMIN_PASSWORD', ''),
        })
        check('用 ADMIN_USER / ADMIN_PASSWORD 能登录成功', st == 200 and bool(body.get('token')),
              f'HTTP {st} {body}')
        token = body.get('token', '')

        print()
        print('3. CONSOLE_URL 未设时是否回退成「请求用的地址」')
        hdr = {'Authorization': f'Bearer {token}'}
        st, keys = req('GET', '/api/access-keys', headers=hdr)
        check('带令牌能调通受保护接口', st == 200, f'HTTP {st}')

        st, net = req('POST', '/api/networks', {
            'name': 'envcheck-net',
            'secret': 'envcheck-secret-1234',
            'cidr': '10.233.233.0/24',
        }, headers=hdr)
        net_id = (net.get('item') or {}).get('id') or net.get('id')
        check('能建网络（为下一步取网络 ID）', bool(net_id), f'HTTP {st} {net}')

        if net_id:
            st, made = req('POST', '/api/access-keys', {
                'networkId': net_id, 'name': 'envcheck',
                'expiresInDays': 1, 'maxNodes': 1,
            }, headers=hdr)
            ek = (made.get('item') or {}).get('key', '')
            check('能建接入密钥', bool(ek), f'HTTP {st} {made}')

            if ek:
                text = req_text('GET', f'/api/agent/install.sh?key={ek}')
                check(
                    f'接入脚本内嵌的控制台地址 = 请求用的 127.0.0.1:{PORT}'
                    '（CONSOLE_URL 未设时靠代码回退）',
                    f'127.0.0.1:{PORT}' in text,
                    text[:300].replace(chr(10), ' | '),
                )

        print()
        print('4. compose 里的容器约定')
        check('compose 暴露 6088:8080', svc['ports'][0] == '6088:8080', str(svc['ports']))
        check('compose 有 data 卷', './data:/data' in svc['volumes'], str(svc['volumes']))
        check('compose 有 healthcheck', 'healthcheck' in svc, '')
        check('镜像名与运行中的版本一致', svc['image'].endswith(':1.1.0'), svc['image'])
        check('单文件版没有引用未定义的变量',
              '${' not in json.dumps(doc), 'compose 里仍残留 ${...} 占位符')
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(data_dir, ignore_errors=True)
    if failures:
        try:
            out = proc.stdout.read() if proc.stdout else ''
        except Exception:
            out = ''
        if out.strip():
            print()
            print('── 服务端输出（用于定位 500 等异常） ──')
            print('\n'.join(out.strip().splitlines()[-25:]))

print()
print('\u2500' * 60)
if failures:
    print(f'有 {len(failures)} 项未通过：')
    for f in failures:
        print(f'  · {f}')
    sys.exit(1)
print('单文件版 compose 的环境变量全部有效')
