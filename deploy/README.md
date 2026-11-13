# 部署说明

## 目标地址

| 环境 | 地址 |
| --- | --- |
| 服务器（100.82.238.106） | `http://100.82.238.106/manosaba/` |
| GitHub Pages | `https://dzycd.github.io/manosaba_TheNightBeforetheTrial/` |

## 技术前提（已核实）

- **全部资源用相对路径**引用（`icon/…`、`Background/…`、`music/…`、`main.js` …），
  没有任何以 `/` 开头的绝对路径 → 放在任意子目录下都能直接工作，无需 `<base>`。
- 联机走公共 broker 的 **wss** 连接（`wss://broker.emqx.io:8084/mqtt`、
  `wss://broker.hivemq.com:8884/mqtt`）→ 纯静态托管即可，服务器**不需要**任何后端。
- 仓库体积约 78 MB / 315 文件，单文件最大 4 MB，符合 GitHub 与常规主机限制。

## 服务器部署

```bash
# 在 100.82.238.106 上执行（需要该机器的 SSH 访问）
curl -fsSL https://raw.githubusercontent.com/DZYCD/manosaba_TheNightBeforetheTrial/main/deploy/deploy.sh -o deploy.sh
bash deploy.sh
```

脚本会把仓库放到 `/var/www/manosaba`（可用 `WWW_ROOT` / `SUBPATH` 覆盖），
修正权限，并在重复执行时安全地更新到最新 `main`。

然后按 `deploy/nginx-manosaba.conf` 里的片段加到 nginx 的 server 块：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

访问 `http://100.82.238.106/manosaba/` 即可。

> 若机器上没有 nginx，临时验证可以用：
> `cd /var/www/manosaba && python3 -m http.server 8080 --bind 0.0.0.0`
> 再访问 `http://100.82.238.106:8080/`。

## GitHub Pages

1. 仓库 → Settings → Pages
2. Source 选 **Deploy from a branch**，Branch 选 **`main`**，目录选 **`/ (root)`**
3. 保存，约 1 分钟后可访问
   `https://dzycd.github.io/manosaba_TheNightBeforetheTrial/`

仓库根目录已放 `.nojekyll`，避免 Pages 走 Jekyll 处理二进制资源。

> 仓库是 public，所以 Pages 免费可用。
> 页面在 https 下运行，MQTT 是 wss，不存在混合内容问题。

## 更新流程

```bash
# 本地
git push manosaba main
# 服务器：直接对齐到远端（不依赖仓库内脚本，避免脚本自我改写）
cd /var/www/manosaba && git fetch --depth 1 origin main && git reset --hard origin/main
```

GitHub Pages 会在推送后自动重新发布。
