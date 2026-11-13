# 魔法少女的审判前夜（manosaba · The Night Before the Trial）

> 一款 2–4 人的浏览器桌游改编作品。纯静态前端 + 公共 MQTT broker 实现联机，**没有后端**，
> 丢到任何静态托管（自建 nginx、GitHub Pages、对象存储）都能直接跑。

- 13 位可选角色，人机对战（2–4 人）或联机对战（房主权威制）
- 棋盘探索 + 证据收集 + 魔女化 + 交锋抢证据 + 处刑票选
- 单体 HTML5 应用，无构建步骤，无第三方运行时依赖（MQTT 客户端已内置于 `vendor/`）

---

## 目录

- [在线地址](#在线地址)
- [快速开始（本地）](#快速开始本地)
- [部署到服务器](#部署到服务器)
- [部署到 GitHub Pages](#部署到-github-pages)
- [联机说明](#联机说明)
- [目录结构](#目录结构)
- [更新流程](#更新流程)
- [常见问题](#常见问题)
- [文档索引](#文档索引)
- [素材与致谢](#素材与致谢)

---

## 在线地址

| 环境 | 地址 | 状态 |
| --- | --- | --- |
| 自建服务器 | `http://100.82.238.106/manosaba/` | 部署命令见下文 |
| GitHub Pages | `https://dzycd.github.io/manosaba_TheNightBeforetheTrial/` | 需在仓库 Settings → Pages 开启一次 |

> 两条路径都要求通过 **http(s)** 访问，不能直接双击 `index.html`：
> 页面用 `fetch` 预加载 `music/` 下的音频，`file://` 协议会被浏览器安全策略拦截。

---

## 快速开始（本地）

### Windows 一键启动

```bat
start_server.bat
```

脚本会自动挑 Node 或 Python 起一个本地静态服务器，并打印访问地址
（默认 `http://localhost:8392`）。

### 手动启动

```bash
# 方式一：仓库自带的零依赖服务器（推荐）
node serve.js 8392

# 方式二：任何静态服务器都行
python -m http.server 8392
npx serve .
```

然后浏览器打开 `http://localhost:8392`。

### 桌面版（可选）

`package.json` 里保留了 Electron 打包配置：

```bash
npm install
npm start            # 本地以桌面应用运行
npm run build        # 打包 Windows portable 版到 dist/
```

---

## 部署到服务器

### 目标

```
服务器：100.82.238.106
路径  ：/var/www/manosaba          ← 子目录名 = URL 子路径
访问  ：http://100.82.238.106/manosaba/
```

> **为什么直接放子目录就能跑**：项目内所有资源都用**相对路径**引用
> （`icon/…`、`Background/…`、`music/…`、`main.js` …），没有一处以 `/` 开头的绝对路径，
> 所以放在任意层级子目录下都不需要改代码，也不需要 `<base>` 标签。

### 第 1 步：把文件放到 www

```bash
# 在 100.82.238.106 上执行（任选一种）

# A. 从 GitHub 拉取（推荐，之后更新只需 fetch）
sudo git clone --depth 1 https://github.com/DZYCD/manosaba_TheNightBeforetheTrial.git /var/www/manosaba

# B. 用仓库里的部署脚本（幂等，重复执行会更新到最新 main）
curl -fsSL https://raw.githubusercontent.com/DZYCD/manosaba_TheNightBeforetheTrial/main/deploy/deploy.sh -o /tmp/deploy.sh
sudo WWW_ROOT=/var/www SUBPATH=manosaba bash /tmp/deploy.sh
```

**你的 www 目录如果不是 `/var/www`**，先用任一命令确认：

```bash
nginx -T 2>/dev/null | grep -E '^\s*(root|server_name)'   # nginx
# 宝塔面板：/www/wwwroot/<站点名>/
# 或看进程：ps aux | grep -E 'nginx|httpd'
```

常见对应关系：

| 环境 | www 目录 | 部署后路径 | URL |
| --- | --- | --- | --- |
| Debian/Ubuntu + nginx | `/var/www` | `/var/www/manosaba` | `http://100.82.238.106/manosaba/` |
| 宝塔面板 | `/www/wwwroot` | `/www/wwwroot/manosaba` | `http://100.82.238.106/manosaba/` |
| CentOS + nginx | `/usr/share/nginx/html` | `/usr/share/nginx/html/manosaba` | `http://100.82.238.106/manosaba/` |
| Apache | `/var/www/html` | `/var/www/html/manosaba` | `http://100.82.238.106/manosaba/` |

### 第 2 步：配置 web server

nginx 片段在 [`deploy/nginx-manosaba.conf`](deploy/nginx-manosaba.conf)，核心就这一段：

```nginx
location /manosaba/ {
    root /var/www;          # 与第 1 步的 WWW_ROOT 保持一致
    index index.html;
    try_files $uri $uri/ /manosaba/index.html;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Apache 等价配置：

```apache
Alias /manosaba /var/www/manosaba
<Directory /var/www/manosaba>
    Options -Indexes +FollowSymLinks
    AllowOverride None
    Require all granted
</Directory>
```

### 第 3 步：权限

```bash
sudo chown -R www-data:www-data /var/www/manosaba   # nginx 用户可能是 nginx/apache
sudo find /var/www/manosaba -type d -exec chmod 755 {} +
sudo find /var/www/manosaba -type f -exec chmod 644 {} +
```

### 第 4 步：验证

```bash
curl -I http://100.82.238.106/manosaba/            # 期望 200
curl -I http://100.82.238.106/manosaba/main.js     # 期望 200
```

浏览器打开 `http://100.82.238.106/manosaba/`，能进大厅即为成功。

> 该服务器 80 端口从开发机所在网络访问不通（22 端口可达），所以部署脚本能在服务器上跑，
> 但无法在开发机上直接 `curl` 验证页面，请在服务器本机或同网段验证。

### 服务器上不需要装的东西

- ❌ Node.js（`serve.js` 只是本地预览用；生产用 nginx/apache 即可）
- ❌ 数据库、后端服务、WebSocket 服务（联机走公共 broker）
- ❌ SSL 证书（纯 http 也能玩；若加 https，见[常见问题](#常见问题)）

---

## 部署到 GitHub Pages

仓库已放 `.nojekyll`，避免 Pages 走 Jekyll 处理二进制资源。

### 方式一：网页点两下（最快）

1. 打开 <https://github.com/DZYCD/manosaba_TheNightBeforetheTrial/settings/pages>
2. **Source** 选 `Deploy from a branch`
3. **Branch** 选 `main`，目录选 `/ (root)`，保存
4. 约 1 分钟后访问 `https://dzycd.github.io/manosaba_TheNightBeforetheTrial/`

### 方式二：脚本开启（需要 token）

```bash
# 生成 Fine-grained token：Settings → Developer settings → Personal access tokens
#   仓库选 manosaba_TheNightBeforetheTrial，权限勾 "Pages: Read and write"
GITHUB_TOKEN=ghp_xxx node deploy/enable-pages.mjs
```

脚本是幂等的：已启用会直接打印现有 URL，不会重复创建。

> 仓库是 public，Pages 免费可用；页面在 https 下运行，联机是 `wss://`，不存在混合内容问题。

---

## 联机说明

### 架构：房主权威 + 状态广播

- 进房后由**房主**（创建房间的人）唯一负责结算：移动、格子效果、交锋、偷牌、回合推进
- 客机把操作**上报**给房主（出牌、放技能、选方向、按交锋灯…），房主执行后广播结果
- 需要“本人决定”的界面（选卡、偷哪张、走哪个方向、是否发动被动）通过
  `passive_request` 请求 / `passive_response` 应答成对完成，**不会把界面画在别人屏幕上**
- 房主每 5 秒还会做一次**全量状态同步**兜底，个别消息丢失也能自愈

### 通信

- MQTT over WebSocket Secure，公共 broker（按顺序尝试）：
  - `wss://broker.emqx.io:8084/mqtt`
  - `wss://broker.hivemq.com:8884/mqtt`
- 使用 **QoS 1** + 稳定 `clientId` + 序号去重，断线按 `2s × 1.5^n`（上限 30s，±20% 抖动）重连
- 房号是 6 位字符码，通过 broker 的 topic 隔离开

### 网络要求

- 客机与房机都要能访问外网 `broker.emqx.io` / `broker.hivemq.com` 的 8084 端口
- 服务器本身**不参与**联机转发，所以部署的机器负载极小
- 若公司/校园网屏蔽公共 broker，可把 `network.js` 顶部 `brokers` 数组换成自建 MQTT
  （需支持 WebSocket，例如 EMQX 的 8084 wss 或 mosquitto + websockets）

---

## 目录结构

```
witch-night/
├── index.html              # 单页入口（全部界面都在这里）
├── main.js                 # 启动引导
├── game.js                 # 游戏主逻辑（回合、棋盘、技能、交锋、结算…）
├── network.js              # 联机层：MQTT、房间、状态同步、消息路由
├── audio.js                # BGM / SFX / 语音管理
├── particles.js            # 粒子特效
├── loading_tips.js         # 加载提示文案
├── serve.js                # 零依赖本地静态服务器（仅本地预览用）
├── start_server.bat        # Windows 一键本地启动
├── styles/                 # 界面样式（ui-components.css 等）
├── icon/                   # 角色头像、UI 图标（含 character_cover / pin / battle）
├── character_image/        # 角色立绘（normal / stress / witch）
├── Background/             # 背景图
├── music/                  # BGM（Hub / Common / Battle / Witch）
├── fonts/ , Font/          # 字体（woff/woff2）
├── vendor/                 # 第三方库：mqtt.min.js（本地内置，不依赖 CDN）
├── deploy/                 # 部署脚本与 nginx 配置
│   ├── deploy.sh
│   ├── nginx-manosaba.conf
│   ├── enable-pages.mjs
│   └── README.md
├── 游戏介绍/                # 玩法说明与截图
├── 设计文档.md              # 系统设计
├── 角色介绍.md / 格子介绍.md # 角色与棋盘格说明
├── request.md              # 需求记录
├── UI-QOL-修复记录.md       # 问题修复记录（含根因与实测数据）
└── 借物表.md                # 素材来源与致谢
```

体积：约 **78 MB / 315 文件**，单文件最大 4 MB（音乐），符合 GitHub 与常规虚拟主机限制。

---

## 更新流程

```bash
# 本地提交并推送到新仓库
git push manosaba main

# 服务器：对齐到远端最新（不依赖仓库内脚本，避免脚本自我改写）
cd /var/www/manosaba && git fetch --depth 1 origin main && git reset --hard origin/main
```

GitHub Pages 会在推送后自动重新发布，无需操作。

### 仓库配置

```
manosaba  https://github.com/DZYCD/manosaba_TheNightBeforetheTrial.git   ← main 跟踪这个
origin    https://github.com/DZYCD/SortingVoice.git                      ← 原始上游（保留历史）
```

> 说明：新仓库是「当前状态」的单次初始提交。本地分支 `DZYCD-WitchNight` 保留了完整历史
> （上游基线 + 本次全部改动），需要时可随时推送过去。

---

## 常见问题

**Q：打开是一片黑屏 / 一直卡在加载？**
先确认是通过 `http://` 访问而不是双击文件；再打开浏览器控制台看是否 404
（部署在子目录时最容易漏的是 `location` 配错导致资源 404）。

**Q：没有声音 / BGM 不切换？**
浏览器要求用户交互后才允许播放音频。点一下页面任意位置即可解除；
项目内已针对自动播放被拒做了“首次点击重试”兜底。

**Q：联机进不去房间 / 提示连接失败？**
检查能否访问 `broker.emqx.io:8084`。公共 broker 偶尔限流，重试或换网络即可；
必要时按上文换成自建 MQTT。

**Q：加了 https 之后联机异常？**
BGM 与页面资源都是同源相对路径，联机是 `wss://`，正常不会混合内容报错。
若用自签证书，注意别让证书错误阻断 `wss` 连接。

**Q：更新后页面还是旧的？**
`html/js/css` 缓存策略已在 nginx 示例里设为不缓存/短缓存；
若仍不生效，强制刷新（Ctrl+F5）或清一次站点缓存。

**Q：最多几人？**
2–4 人；单人流程下其余位置由 AI 填充。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`游戏介绍/游戏介绍.md`](游戏介绍/游戏介绍.md) | 背景、目标、流程与截图 |
| [`设计文档.md`](设计文档.md) | 系统设计与实现说明 |
| [`角色介绍.md`](角色介绍.md) | 13 位角色的能力 |
| [`格子介绍.md`](格子介绍.md) | 棋盘格类型与效果 |
| [`UI-QOL-修复记录.md`](UI-QOL-修复记录.md) | 逐条问题根因、修复方式与实测数据 |
| [`request.md`](request.md) | 需求记录 |
| [`借物表.md`](借物表.md) | 素材来源与致谢 |

---

## 素材与致谢

素材来源详见 [`借物表.md`](借物表.md)。本项目为爱好者二次创作改编，
原游戏版权归原作者所有；角色立绘、语音、音乐等素材版权归各自权利人，
仅供学习交流，请勿商用。

代码部分作者：**DZYCD**
