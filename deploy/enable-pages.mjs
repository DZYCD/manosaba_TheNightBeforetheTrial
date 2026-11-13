#!/usr/bin/env node
// ============================================================
// 一键开启 GitHub Pages（需要 token）
// ------------------------------------------------------------
// 1) 生成 token：GitHub → Settings → Developer settings →
//    Personal access tokens → Fine-grained tokens
//    仓库选 manosaba_TheNightBeforetheTrial，
//    权限勾 "Pages: Read and write"（经典 token 则勾 repo）
// 2) 执行：
//    GITHUB_TOKEN=ghp_xxx node enable-pages.mjs
//    或  PowerShell:  $env:GITHUB_TOKEN='ghp_xxx'; node enable-pages.mjs
// 3) 约 1 分钟后访问：
//    https://dzycd.github.io/manosaba_TheNightBeforetheTrial/
//
// 说明：仓库是 public，Pages 免费；源为 main 分支根目录。
// 已启用时会自动跳过（幂等）。
// ============================================================

const OWNER = 'DZYCD';
const REPO = 'manosaba_TheNightBeforetheTrial';
const BRANCH = 'main';
const PATH = '/';

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  console.error('缺少 GITHUB_TOKEN 环境变量。');
  console.error('用法: GITHUB_TOKEN=ghp_xxx node enable-pages.mjs');
  process.exit(2);
}

const API = `https://api.github.com/repos/${OWNER}/${REPO}/pages`;
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'manosaba-enable-pages'
};

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data };
}

(async () => {
  console.log(`==> 仓库 ${OWNER}/${REPO}`);

  const repoInfo = await call('GET', `https://api.github.com/repos/${OWNER}/${REPO}`);
  if (repoInfo.status !== 200) {
    console.error(`读取仓库失败: HTTP ${repoInfo.status} ${JSON.stringify(repoInfo.data).slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`    可见性: ${repoInfo.data.visibility}  默认分支: ${repoInfo.data.default_branch}`);
  if (repoInfo.data.visibility === 'private') {
    console.log('    注意：私有仓库的 Pages 需要付费计划，且访客需登录。');
  }

  const current = await call('GET', API);
  if (current.status === 200) {
    console.log(`==> Pages 已启用: ${current.data.html_url}`);
    console.log(`    源: ${current.data.source && current.data.source.branch} ${current.data.source && current.data.source.path}  状态: ${current.data.status}`);
    console.log('    如需重建，可在 Settings → Pages 里点 Re-run，或再推送一次提交。');
    process.exit(0);
  }
  if (current.status !== 404) {
    console.error(`查询 Pages 状态失败: HTTP ${current.status} ${JSON.stringify(current.data).slice(0, 300)}`);
    process.exit(1);
  }

  console.log('==> 未启用，正在创建 Pages（源 = main 根目录）');
  const created = await call('POST', API, { source: { branch: BRANCH, path: PATH } });
  if (created.status === 201 || created.status === 204) {
    console.log(`==> 创建成功: ${created.data && created.data.html_url}`);
  } else if (created.status === 409) {
    console.log('==> Pages 已存在（409），无需重复创建');
  } else {
    console.error(`创建失败: HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 400)}`);
    console.error('若提示权限不足，请确认 token 带 Pages 写权限（或经典 token 的 repo 权限）。');
    process.exit(1);
  }

  // 触发一次发布（有些情况创建后需要显式 build）
  const build = await call('POST', `${API}/builds`);
  if (build.status === 201 || build.status === 204) {
    console.log('==> 已触发首次构建');
  } else {
    console.log(`    （构建触发返回 HTTP ${build.status}，通常推送一次提交也会触发）`);
  }

  console.log(`\n==> 约 1 分钟后访问：https://${OWNER.toLowerCase()}.github.io/${REPO}/`);
})();
