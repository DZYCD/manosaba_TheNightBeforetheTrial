# UI / QOL 修复记录

本文件记录本轮针对界面与交互问题的修复内容、验证方式和遗留待办。

- 服务启动：`node serve.js 8392`（或 `start_server.bat`），浏览器打开 `http://127.0.0.1:8392/`
- 验证脚本：`.dev/b_dual_client.mjs`（联机）、`.dev/verify_assets.mjs`（资源）、`.dev/wiring.py`（事件接线）、`.dev/check_css_urls.mjs`（样式内资源引用）、`.dev/verify_css_migration.py`（样式合并等价性）

---

## 一、交互修复

### 1. 格子信息面板（触摸 / 键盘可达）

原来只绑定 `onmouseenter` / `onmouseleave`，触摸设备完全看不到格子效果与线索卡。

- 格子补 `onclick` 切换显示、`onfocus` / `onblur`、`tabindex`、`role="button"`、`aria-label`
- 面板右上角加 32px 关闭按钮
- 点击面板外部自动收起；`ESC` 也可关闭
- 触摸端面板改为左右贴边（原 `right: 20px` 会被手指挡住）
- 面板本身设 `pointer-events: none`，只让关闭按钮可点 —— 否则它会盖住右侧两列格子并吃掉点击

### 2. 防连点锁（三处）

| 位置 | 问题 | 修复 |
| --- | --- | --- |
| 角色确认（单人 / 多人） | 动画期间重复点击会让同一玩家选两个角色 | `gameState.charSelectLock`，重绘时释放 |
| 出牌 | 连点会重复出牌、回合跳两次 | `gameState.cardSubmitting` + `lockCardSubmit()/unlockCardSubmit()`，20 秒安全阀，`nextTurn()` 与房主状态同步时解锁 |
| 创建 / 加入房间 | 重复点击会建多个 MQTT client 互相覆盖 | `roomActionBusy` 标志 + 按钮 `disabled`，失败时状态行出现「⟳ 重试」 |

### 3. 全局键盘

原来全工程没有任何业务键盘处理。

- `Space` / `Enter`：交锋抢灯（判定条件是反应面板可见且处于"点击屏幕"状态）
- `ESC`：关闭音乐面板 / 格子信息面板
- 房间码输入框 `Enter` 直接加入，进联机页自动聚焦
- 玩家昵称输入框 `Enter` 保存并失焦

> 说明：`ESC` 没有接到魔法弹窗、分叉弹窗这类**必选流程**上 —— 它们有 10 秒倒计时且超时自动放弃，给 ESC 等于偷偷帮玩家放弃魔法，风险大于收益。

### 4. 音频

- 静音现在覆盖**角色语音**（原来只暂停 BGM，`playSFX` 有 `isMuted` 判断但 5 个 `play*Voice` 都漏了）
- 音乐面板新增「🔇 停止语音」按钮（`stopCharacterVoice()` 早就有实现，但没有任何 UI 调用它）

### 5. 房间码输入

- 输入即过滤为合法字符集 `[A-HJ-NP-Z2-9]`（与 `network.js` 的 `generateRoomCode` 一致，排除易混的 I O 0 1）
- 非法房间码立即提示，不再白等 5 秒网络超时

### 6. 复制房间码降级

`navigator.clipboard` 在局域网 `http://` 下不存在（非安全上下文）。现依次尝试
`clipboard.writeText` → `execCommand('copy')` → 自动选中房间码并提示手动复制。

### 7. 转场期导航

原来转场（约 2 秒黑幕）期间的导航点击会被**静默丢弃**，玩家以为卡死。
现记录最后一次请求并在转场结束后补执行；设置 / 规则 / 制作人员这类纯本地界面直接跳过黑幕。

---

## 二、联机协议与回合推进

### 2.0 联机完全不可用（已定位并修复）

**现象**：第二个客户端加入房间后显示"加入成功"，但 `localPlayerId = 1`、玩家列表仍只有 1 人 ——
等于把自己当成了房主，两名玩家都不会真正进入同一局，联机表现为"不可用"。

**根因**：上一轮加的「按 `clientUid` 去重」把 uid 存在 **localStorage**，
而同源的两个标签页共享 localStorage → 两个客户端拿到**同一个 uid** →
房主的 `handleJoinRequest` 匹配到"已存在同 uid 玩家"（其实是房主自己，id=1），
于是复用房主座位并回 `playerId: 1`。

**修复**：
1. `getClientUid()` 改用 `sessionStorage`（按标签页隔离、刷新后保留），另存一份到 `networkState.sessionUid`；
2. `handleJoinRequest` 的去重**永不匹配房主席位**（`!p.isHost && p.id !== localPlayerId`），
   恢复"同 uid 重复 join = 幂等复用座位"的正确语义；
3. 新座位号改为 `最大 id + 1`（原来用 `玩家数 + 1`，有人离开后会撞号）；
4. 同名去重：两个标签页会读到同一个 localStorage 昵称，出现两个"玩家"分不清，现在自动追加 `(2)`。

**另外补上首连故障转移**：原来 `createRoom`/`joinRoom` 只试当前 broker，
EMQX 抽风就直接失败（切换逻辑只存在于"断线重连"路径）。
新增 `connectWithFailover()`：逐个尝试所有 broker，每个 12 秒超时，全失败才报错并给出原因。

**真实浏览器验证**（`.dev/cdp_two_clients.mjs`，headless Chrome 157 + CDP 驱动两个独立标签页 +
真实 `vendor/mqtt.min.js` + 真实公共 broker）：

```
PASS  A 创建房间成功
PASS  B 加入房间成功            [localPlayerId=2, playerKeys=["1","2"]]
PASS  A 侧看到 2 名玩家          [玩家#1, 玩家(2)#2]
PASS  A 能开始游戏（进入选角）
PASS  B 收到 game_start 并进入对局状态
PASS  B 发出的 action 消息 A 能收到（双向投递）
PASS  首个 broker 不可用时自动切换到备用并建房成功
7/7 通过
```

排查过程中确认的两件事（都不是故障原因，可排除）：
- `vendor/mqtt.min.js` 在真实 Chrome 中加载正常，两个公共 broker 均可连接（约 1.3 秒 CONNACK=0）
- broker 网络层可达性正常（原始 MQTT CONNECT 探测与 mqtt.js 两条路径都通）

### 2.1 回合推进相关

均为对局中有人退出 / 掉线时的卡死问题。

| 修复 | 说明 |
| --- | --- |
| `exitRoom()` 按模式分流 | 联机时先广播 `player_left` 再 `disconnectMQTT()`，房主额外广播 `game_abort`；原来只清本地状态，其他玩家的回合会永久停在离开者身上 |
| 新增 `case 'player_offline'` | 该消息一直在广播，但接收端**没有任何分支**，是条死消息 |
| `handlePlayerLeft` 同步 `gameState` | 原来只删 `networkState.players`，对局状态里那个人还在 |
| `nextTurn()` 跳过离线玩家 | 寻找下一个玩家时同时跳过 `isEliminated` 和 `offline`；活跃玩家判定也排除离线，避免全员掉线时这局永久挂起 |
| 加入房间按 `clientUid` 去重 | 新增 `getClientUid()`（localStorage 持久化），手抖双击或断线重连不再占两个座位 |
| 房主开始游戏加锁 | `gameState.starting` + 按钮禁用 + **显式 ready 校验**（原来只靠按钮置灰，可绕过） |
| 超时与重试 | `createRoom` 连接包 12 秒超时；`joinRoom` 原已有 5 秒超时 |
| 附带修复 | `disconnectMQTT()` 不清 `mode`/`localPlayerId`，离房后下一局会被误判为联机；结算页「返回大厅」不走离房协议会留僵尸座位 |

**验证**：`.dev/b_dual_client.mjs` —— 内存 MQTT broker + 两个独立沙箱各加载一份真实
`game.js`/`audio.js`/`network.js`，驱动真实函数，16 条断言全通过：

```
PASS  对局内退出会广播 player_left
PASS  对局内退出会断开自己的 MQTT
PASS  host 侧把离开的玩家标记为离线
PASS  player_offline 后回合自动跳到在线玩家（3 人局）
PASS  nextTurn 跳过离线玩家（0 -> 2，跳过 1）
PASS  同一 uid 重复加入只占一个座位
PASS  房主连点开始游戏只广播一次 game_start
PASS  有玩家未准备时不开局
...
16/16 通过
```

---

## 三、依赖本地化

| 依赖 | 处理 |
| --- | --- |
| `mqtt.min.js` | 从 `unpkg.com` 下载到 `vendor/mqtt.min.js`（319 KB），不再依赖公网 CDN |
| 加载失败 | 新增 `checkMqttAvailable()`：库缺失时两处状态行显示「联机组件加载失败」并禁用联机按钮 |
| Web 字体 | Google Fonts 的 `@import`（阻塞式请求）改为**自托管子集**：`fonts/NotoSerifSC-{400,600,700,900}.woff`，按游戏实际用到的 1470 个字符子集化，四档合计约 1.1 MB |
| 字体兜底 | 字符集外的生僻字（如玩家自起名字）回退到 `Source Han Serif SC → Songti SC → SimSun → serif` |

字体为 Noto Serif SC，SIL Open Font License 1.1，可自由再分发（Windows 自带宋体不可再分发，故未采用）。

---

## 四、结构清理

- 删除第二套 `id="settings-screen"` 死 DOM（`getElementById` 永远只拿到第一个，旧的那套永不显示，内部三个控件无任何 JS 引用）
- 删除 `pauseGame()` 死代码（零调用，且联机时不会通知他人离房，功能已被 `exitRoom` 覆盖）
- `renderOpponentsMagicPanel` 两份定义合并为一份（原先真实实现被空壳覆盖，且依赖的 `#opponents-magic-list` 元素不存在）
- 删除 `.count-btn` 被覆盖的 50px 死规则、旧设置界面的 `.settings-content`/`.setting-item` 死 CSS
- `.cell-info-panel` 红黑旧样式与金色新装饰混用 → 统一走金色设计（`right: -280px` 会把面板推到可视区外，一并修正）
- 重复 `connection-status` id → 拆为 `connection-status-inline`，`setRoomStatus()` 同时更新两处
- 结算页新增「🔄 再来一局」（沿用上一局人数直接回选角）

### 样式合并（重要）

`index.html` 原有 8 个内联 `<style>` 块（其中 7 个位于 `</html>` 之后，靠 HTML 容错被塞回 body），
加载顺序在外部样式表之后 → 同选择器静默覆盖外部文件，这是「改样式不生效」的根源。

现已按**原顺序**并入 `styles/ui-components.css` 末尾：

- `index.html`：6253 → 856 行（样式标签 0 个）
- `ui-components.css`：7670 → 13100 行
- **等价性验证**：合并前 830 条外部规则 + 760 条内联规则 = 1590 条；合并后 1590 条，
  逐条比对仅 2 条有意修正（`#menu-screen` 的 `url()` 相对路径需从文档相对改为文件相对）

---

## 五、布局修复

| 问题 | 修复 |
| --- | --- |
| ≤1140px 时棋盘被挤出屏幕、右侧格子点不到（`overflow-x: hidden` 静默裁掉） | 原 `@media(max-width:1024px)` 把对手卡**反向放大**到 420px；现新增 ≤1140px 档：卡片 `clamp(200px,26vw,320px)`、格子 `clamp(36px,5.2vw,64px)`、`.game-main` 三列改 `minmax(0,…)` |
| 1280×720（Electron 默认窗口）高度溢出约 250px | 新增 `@media(min-width:769px) and (max-height:820px)` 紧凑档 |
| 设置页 / 制作人员页三张卡不换行，窄屏第三张被裁 | 补 `flex-wrap: wrap` |
| 棋子恒 88px，永远大于格子（最大 80px）且格子 `overflow:hidden` | 改 `clamp(26px,3.2vw,56px)` |
| 移动端棋盘缩放指向不存在的 `.game-board-container` | 规则从未生效，改为直接缩小 `.grid-cell` |
| 角色选择列表 13 张 `position:fixed` 卡共约 756px，720p 下首尾被切 | 补 `max-height:100vh; overflow-y:auto` |
| 弹窗 `align-items:center` 且无 `overflow-y`，超高时顶部永远滚不到 | 改 `flex-start` + `overflow-y:auto` + 内容 `max-height` |
| 长昵称溢出卡片、格子内「已被 XXX 触发」字号 8.8px | 补 `nowrap+ellipsis`、字号提到 0.7rem |
| 小热区（规则页圆点 12px、颜色块 24px、音量条 6px 高） | `::after inset:-10px` 扩命中区、按钮 32px、滑块视觉 6px 命中 26px |
| 51 个无限动画无 `prefers-reduced-motion` 支持 | 加全局 reduce 兜底 |

---

## 六、Logo 遮挡与规则界面排版

### 6.1 大厅标题压住按钮

**现象**：窗口变窄后，「魔法少女的审判前夜」标题图会盖住左上角的社交按钮，再窄一些还会压住「单人游戏 / 多人游戏」。

**实测数据**（headless Chrome 量 `getBoundingClientRect` + `elementFromPoint` 命中测试）：

| 窗口宽度 | 标题图左边缘 | 社交按钮区 | 结果 |
| --- | --- | --- | --- |
| 1280 | 770 | 200–359 | 正常 |
| 800 | 290 | 200–359 | **压住 3 个社交按钮**（中心点命中的顶层元素就是 logo） |
| 640 | 280 | — | 同时压住「单人游戏」 |

**根因**：`.game-logo` 是 `position: absolute; right: 60px`，图片写死 `max-width: 450px`。
窗口一窄，绝对定位的容器只会往左滑，没有收缩逻辑；
更隐蔽的是**容器本身**（宽度被 `width: 400px` 的名字输入框撑开）会成为吞掉点击的顶层元素。

**修复**：
1. 装饰性 logo 图一律 `pointer-events: none`；`.game-logo` 容器也设为不接收指针事件，
   只在真正需要交互的子元素（输入框、颜色按钮、颜色面板）上重新开启；
2. `.game-logo-img` 改为 `clamp(200px, 34vw, 450px)`，`.player-name-input-wrapper` 改 `clamp(200px, 30vw, 400px)`、
   `.player-name-input` 改 `min(200px, 46vw)` —— 输入框的固定宽度是把容器撑破的间接原因；
3. ≤700px 时放弃「右上标题 + 左下按钮」这个构图，改为标准竖向流式排版（标题居中在上、按钮依次在下）；
   同时背板图改 `height: 100%`，避免它溢出 64px 高的容器去压按钮；
4. 该样式块必须放在 `ui-components.css` **最末尾** —— 迁移进来的旧规则（`.game-logo { position: absolute }`）
   在文件靠后位置，同特异性下后出现者胜，放前面会被覆盖（这轮实际踩过一次）。

**验证**：`.dev/verify_logo_geometry.mjs` —— 12 种窗口尺寸 × 6 个界面（含滚动容器裁剪计算）：

```
1920x1080 / 1600x900 / 1440x810 / 1280x720 / 1280x690 / 1152x648
1024x640 / 960x600 / 900x600 / 800x600 / 768x700 / 640x560
全部 OK 无遮挡      合计: 几何重叠 0 处, 中心被挡 0 处
```

### 6.2 规则界面页码圆点点不到

**实测**：1280×720 下 8 个 `.rules-page-dot` 的 y 坐标为 759（视口只有 720），整排出界，翻页完全不可用。

**修复**：不用「留多少像素」的魔法数字，改成结构化解法 ——
`#rules-screen` 改为 `height: 100vh` 的竖向 flex 列（注意是 height 不是 min-height，
后者会跟着内容长高把页码顶出去），标题与页码固定高度，中间 `.rules-book` 吸收剩余空间并内部滚动。

**验证**：`.dev/verify_rules_dots.mjs` —— 6 种尺寸下圆点均在视口内且 `elementFromPoint` 可命中：

```
1920x1080 圆点 y=1054/1080   1440x810 y=784/810   1280x720 y=694/720
1280x690  y=664/690          1024x640 y=614/640    900x600 y=574/600
6/6 通过
```

### 6.3 房间大厅：「准备 / 开始游戏」按钮既被 logo 压住、又掉在屏幕外

**现象**：多人房间大厅底部的「准备」和「开始游戏」两个按钮，既被底部装饰 logo 压住，在 720p 窗口下还根本点不到。

**实测**（1280×720，量每一层容器的 `getBoundingClientRect`）：

```
#room-screen        h=883  bottom=883   overflowY=visible   ← 内容比视口高 163px
  .decorated-title  y=0..153
  .room-container   y=193..883  h=690
    .room-code      y=213..343  h=130
    #room-players   y=373..771  h=398      ← 4 个槽位 × 84px
    .room-actions   y=801..863             ← 按钮在这里，视口只有 720
  .footer-logo      y=759..865  h=106      ← 装饰 logo 正好盖在这两个按钮上
```

两个独立问题叠在一起：
1. `.footer-logo` 是 `absolute bottom:30px` 居中，正好落在按钮所在的底部条带上；
   1600×900 下 `elementFromPoint` 命中的顶层元素就是 `div.footer-logo`，两个按钮都点不动；
2. 更根本的是**按钮本来就在屏幕外** —— 房间界面内容固定 883px 高（4 个玩家槽位各 84px + 房间码 130px），
   比 720p 视口高出 163px。

**修复**：
- 房间界面顶部已有「房间大厅」标题，底部 logo 纯属重复装饰 → `#room-screen .footer-logo { display: none }`；
- `#room-screen` 改为竖向 flex，**`height: 100vh` + `overflow: hidden`**
  （注意必须是 `height` 不是 `min-height`：第一版用 `min-height` 时容器照样被内容撑到 883px，按钮仍在屏幕外，实测验证后才发现）；
  标题固定高度、`.room-container` 吸收剩余空间、玩家槽位区内部滚动、`.room-actions` 常驻底部。

**验证**：`.dev/verify_room_and_cards.mjs`，8 种窗口尺寸 × （准备 + 开始游戏）：

```
1920x1080 按钮 y=994..1056 /1080    1600x900 y=814..876 /900
1440x810  y=724..786 /810           1280x720 y=634..696 /720   ← 修复前是 801..863，整块在屏幕外
1280x690  y=604..666 /690           1024x640 y=554..616 /640
 900x600  y=514..576 /600            800x600 y=514..576 /600
16/16 按钮断言通过（均 inView 且 elementFromPoint 命中自身）
```

### 6.4 角色卡：键盘用户看不到角色名

角色卡是「默认滑出 140px、只露 60px 头像，`:hover` 才滑出」的设计，键盘用户和触屏用户没有等价入口。

**没有改成常驻全展开**，因为量过：1920 宽下展示区右边缘在 1843，卡片列表从 1720 起，
全展开会压掉展示区 123px；13 张卡竖排 756px 高，横向展开也没有空间。

**改成**：
- 卡片加 `tabindex="0"` + `role="button"` + `aria-label` + Enter/Space 键处理 → 键盘可达；
- `:focus-visible` / `:focus-within` 时同样展开（`translateX(0)`）、名字与左侧色条显形；
- 收起状态下给一点半透明箭头提示"可展开"。

**验证**（同脚本，8 种尺寸）：`tabindex=0`、聚焦成功、`transform` 从 `tx=140` → `tx=0`、名字 `opacity=1`、
失焦后回到 `tx=140`，24/24 断言通过。

> 调试提示：transform 有 0.3s 过渡，测试里聚焦后必须等约 500ms 再读计算样式，
> 否则读到的是起始值，会误判成"聚焦没生效"（这轮实际踩过一次）。

### 6.5 顺带：底部装饰 logo 在矮窗口隐藏

`settings / online / credits / result / room` 页面的 `.footer-logo` 是 `absolute bottom`，
内容在矮窗口溢出时它会被推到视口外（实测 900×600 时在 y=845）并与底部按钮撞在一起。
它纯属装饰，`max-height: 760px` 以下直接隐藏。

---

## 七、角色卡重做与对局界面遮挡

### 7.1 角色卡：底部横向滑块的真正来源

**现象**：角色选择界面右侧的 13 张角色卡列表底部出现横向滚动条。

**根因**：上一轮我给 `.char-card-list` 加了 `max-height: 100vh; overflow-y: auto`，想让它内部滚动。
但卡片收起时是 `translateX(140px)` **横向溢出**，而 CSS 规定：一个轴设成 `auto`/`scroll` 时，
另一个轴的 `visible` 会被计算成 `auto` —— 于是横向溢出也变成可滚动。实测 `scrollWidth=340` / `clientWidth=200`。

**重做**（不再依赖任何滚动条）：让卡片尺寸跟随视口高度，13 张卡在 600px 高的窗口里也能完整放下。

```css
.char-card-list {
    overflow: visible;               /* 关键：不能再用 overflow-y:auto */
    max-height: none;
    gap: clamp(2px, 0.5vh, 5px);
}
.char-card-list .char-card {
    width: clamp(140px, 13vw, 200px);
    height: clamp(32px, 4.2vh, 52px);          /* 13 × 32~52 + gap ≤ 视口高 */
    transform: translateX(calc(100% - 46px));  /* 收起只露 46px，滑出距离随宽度联动 */
}
```

头像与名字同步自适应：`.char-card-avatar { height: 76%; aspect-ratio: 1 }`、
`.char-card-name { font-size: clamp(0.68rem, 1.5vh, 0.9rem) }`。

**验证**（9 种尺寸）：卡片总高从 756px 降到 464~671px，`scrollH == clientH`、`overflow: visible`，
13 张卡 0 张越界；识图确认「没有滚动条、13 张卡完整显示」。

### 7.2 「确认选择」按钮被展开的角色卡压住

**实测**（1280×720）：按钮原在展示区右上角 `absolute; top:25px; right:25px` → 位于 x≈1054~1204；
角色卡展开后从 `translateX(140px)` 回到 `translateX(0)`，占据 x≈1080~1280 —— **重叠 124px**。

**修复**：按钮移到展示区**底部居中**（`left:50%; bottom:46px; transform:translateX(-50%)`），
既远离右侧卡片列，也符合"看完信息再确认"的操作顺序；`max-height:700px` 时进一步上移并缩小。

**验证**（9 种尺寸）：按钮矩形与任何卡片都不相交，且按钮中心 `elementFromPoint` 命中自身，9/9 通过。

### 7.3 格子信息面板遮住格子

**实测**：面板原本 `position: absolute; right: 20px`，落在棋盘容器内 ——
1440×810 下与 **6 个格子**矩形相交，1280×720 下与 **5 个**相交。

**修复**：新增 `positionCellInfoPanel()`，按棋盘实际位置依次尝试
「棋盘右侧 → 棋盘左侧 → 棋盘下方 → 棋盘上方 → 视口右缘 → 视口左缘」，
用 `.grid-cell` 的真实矩形做相交测试，挑第一个**四周放得下且不与任何格子相交**的位置；
都不行时先切 `.cell-info-compact` 紧凑样式（200px 宽、隐藏描述）再试一轮，最后一手才隐藏。

**验证**（9 种尺寸）：与面板相交的格子数全部为 **0/36**；800×600 这种极小窗口也能显示（紧凑模式）。

### 7.4 角色信息浮窗里不再显示卡牌

证据浮窗 `evidence-tooltip` 原来渲染 `.clue-card-item`（卡牌图 + 名称 + 标签），
在棋盘旁又大又挡视线。改为**纯文字清单**（`.evidence-tooltip-item`），
并删掉随之失效的 `.clue-card-item` / `.clue-info` 样式（各少 2 条规则）。

**验证**：9 种尺寸下浮窗内 `.clue-card-item` / `.mini-card` / `img` 的数量均为 0。

---

## 八、对局界面布局重构

前面几节都是"哪里压住了就挪一下"，这一节是把手电筒换成设计：重排对局界面的空间分配。

### 8.1 重构前实测到的结构性问题

| 现象 | 实测数据 |
| --- | --- |
| 布局比视口还大，整页滚动 | 800×600 窗口下 `.game-layout` 被撑成 **931×711** |
| 棋盘被压 | 1024×640 下棋盘只有 **133px**，800×600 下 **106px** |
| 玩家卡浮在棋盘上 | `.console-collapsible` 是 `absolute; bottom:100%`，默认就悬在棋盘上方 |
| 左右不均衡 | 三列 `auto 1fr auto`，没人的一侧塌成 0，有人的一侧撑到 518px |

硬最小宽度的来源（三处叠加）：
`.game-main` 的 `padding: 30px 40px` + `gap: 30px`、侧列玩家卡的 `clamp(320px, 27vw, 520px)`、
格子的 `clamp(48px, 4.2vw, 80px)` —— 而且**格子只看宽度（vw）不看高度**，矮窗口必然溢出。

### 8.2 新的布局系统

```
#game-screen   height:100vh; overflow:hidden          ← 锁定视口，永不整页滚动
└ .game-layout grid-rows: auto | minmax(0,1fr) | auto | auto
  ├ .game-navbar       顶栏（单行、可压缩）
  ├ .game-main         主区：三列对称 minmax(0,var(--side)) | 1fr | minmax(0,var(--side))
  │  ├ .player-slot ×4 四个玩家槽（min-width/min-height 归零，允许收缩）
  │  └ .game-board-wrapper  容器查询上下文
  ├ #user-console      控制台（按内容自然高度，折叠区自分滚动）
  └ .action-prompt-bar 提示条
```

四个关键手法：

1. **所有栅格/弹性子项 `min-width: 0; min-height: 0`** —— 这是布局能被压缩的前提，
   `auto` 尺寸的最小内容宽度才是撑破布局的真凶。
2. **棋盘取"能放下的最大正方形"**：`.game-board-wrapper { container-type: size }` +
   `.board-grid { width: min(100cqw, 100cqh); aspect-ratio: 1/1 }`，
   格子改 `repeat(6, minmax(0, 1fr))` 由网格均分，彻底摆脱 `clamp(48px, 4.2vw, 80px)` 的宽度依赖。
3. **玩家卡面板回到文档流**（`position: static`），靠栅格挤压主区，而不是浮在棋盘上。
4. **≤1100 切换成"棋盘占满宽度 + 顶部横向玩家条"**，与既有手机端方案统一。

### 8.3 对手角色卡：内容密度重构

卡片自然尺寸原是 **269×327**，而侧列槽位只有 282×151；更要紧的是卡片内 3 行证据进度
**横向溢出到 x=391~569**，直接压住棋盘格子。所以问题不是"卡片太宽"，而是密度太低：
头像 72px、魔女化条 16px、证据三行独占一行、点数牌单独一行。

DOM 不变、只改视觉排布：头像与名字/魔法并排、证据三行压扁成一行、侧列里去掉点数牌行。
**卡片高度 327 → 130px**，两张也能并排塞进侧列，且不再有任何元素溢出卡框（实测 0 个）。

### 8.4 竖向空间预算

重构中又发现一个我的验收脚本没覆盖的问题：`#user-console` 设了 `max-height` + `overflow: hidden`，
而折叠区 + 主行 + 进度条在中等宽度下会换行变高，**主行被静默裁掉 21~41px**。
我的断言只查了"控制台不压提示条"，查不出"控制台内部被裁"。
补上「`#user-console` 的直接子元素是否都落在控制台内」这条断言后，改为**不设硬上限**，
竖向空间由折叠区 `max-height` 兜住，极矮窗口（≤560）直接收起折叠区。

### 8.5 验收结果

`.dev/verify_game_layout.mjs` —— **12 种尺寸 × 6 条断言 = 72/72 通过**：

| 断言 | 说明 |
| --- | --- |
| 布局不超出视口 | 无整页滚动（原 931×711 问题已消除） |
| 棋盘正方形且完整可见 | 长宽差 ≤2px，四边在视口内 |
| 36 个格子全部可点 | 无越界、无被挡，含 `elementFromPoint` 命中自身 |
| 格子浮窗不遮格子 | 与面板相交的格子数恒为 0 |
| 四段互不重叠 | 顶栏底 ≤ 棋盘顶 ≤ 棋盘底 ≤ 控制台顶 ≤ 提示条顶 |
| 控制台内容不被裁切 | 新增断言，防静默裁剪 |

棋盘尺寸（重构前 → 后）：

```
1920x1080  510 → 644        1280x720  306 → 371        1024x640  133 → 254
1600x900   438 → 505        1152x648  303 → 319         900x600  303 → 220
1440x810   369 → 440         960x600  303 → 219         800x600  106 → 204*
```

\* 800×600 属于远低于游戏正常使用范围的窗口，此时棋盘约 204px（格子 32px）仍完整可用，
但已到可用性下限。

### 8.6 角色卡"揉成一团"的返工（按槽位高度重排）

第八节初版把对手卡从 327px 压到 130px，属于矫枉过正 —— 实测反馈是"元素都揉到一起"。
量清数据后发现压错了方向：

| 尺寸 | 槽位可用高度 | 初版实际卡片高度 | 浪费 | 最小字号 |
| --- | --- | --- | --- | --- |
| 1920×1080 | 319px | 159px | **160px** | 11.3px |
| 1440×810 | 218px | 134px | 84px | **8.8px** |
| 1280×720 | 184px | 130px | 54px | **8.8px** |
| 1152×648 | 158px | 127px | 31px | 8.8px |

问题在于**字号用 `clamp(..., vh, ...)` 按视口高度算，与卡片的真实可用高度无关**：
窗口一矮字号就被压到 8.8px，而卡片上方还空着 54~160px。

**返工做法**：

1. `.player-slot { container-type: size }` —— 把槽位变成尺寸查询容器，
   卡片 `height: 100%` 填满槽位，不再留大片空白。
2. 字号改用 **`cqw`（卡片宽度）**驱动，宽度稳定 → 字号不再随窗口高度忽大忽小：
   玩家名 `clamp(13px, 5.2cqw, 18px)`、角色名 `4.6cqw`、魔法名 `4cqw`、状态行 `3.5cqw`。
3. 侧列从 `22vw` 加宽到 `26vw`（上限 340px）：1280 下棋盘是受**高度**限制（371px），
   横向还有约 280px 富余，加宽侧列不会缩小棋盘，却能显著减少文字换行。
4. 证据区从"压成一行的小圆点"恢复成**三行竖排**，圆点从 5px 放大到 7~9px。
5. 但槽位矮到一定程度内容仍会超出，于是按槽位高度分四级用容器查询收敛：

| 槽位高度 | 收敛动作 |
| --- | --- |
| ≤240px | 魔法名收成一行（省略号） |
| ≤190px | 隐藏静态的"主动/被动"标签（**保留冷却 CD**）、头像 51→40px、圆点微缩 |
| ≤172px | 字号小幅下调（玩家名 13~15px、魔法名 11~13px） |
| ≤165px | 内边距与间距收紧，消除 2px 的块间重叠 |

> 中途踩过一个坑：第一版在 ≤190 直接隐藏了整行状态，把**冷却 CD 也一起藏了** ——
> 那是判断能不能放技能的关键信息。改成只隐藏静态类型标签。

**返工后数据**（同一套量测）：

| 尺寸 | 卡片 | 玩家名 | 角色名 | 魔法名 | 状态行 | 圆点 | 块间重叠 | 文字溢出 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1920×1080 | 340×319 | 17.7px | 15.6px | 13.6px | 11.9px | 9px | 无 | 0 |
| 1440×810 | 340×218 | 17.7px | 15.6px | 13.6px | 11.9px | 9px | 无 | 0 |
| 1280×720 | 333×184 | 17.3px | 15.3px | 13.3px | 11.6px | 7px | 无 | 0 |
| 1152×648 | 300×158 | 14.4px | 13.2px | 11.7px | 11px | 7px | 无 | 0 |

识图复核（1280×720）：「文字清晰可读，无明显重叠，未压到边框，整体不显拥挤」。

新增验收脚本：`.dev/diag_card_cram.mjs`（槽位/字号/内部尺寸）、
`.dev/diag_card_inner.mjs`（块间重叠与文字溢出，**这是"挤"的可量化判据**）。

---

## 九、对手信息面板（替代四角角色卡）

### 9.1 为什么要换

四角角色卡无论怎么调尺寸都在"挤"和"占地方"之间二选一：
13 张卡的信息硬塞进侧列，字号只能压到 8.8~11px。
改成**分层显示**：简单信息常驻、详细信息按需展开。

### 9.2 新结构（四列）

```
[对手简易列表] [棋盘] [立绘竖列] [详情面板]
   190~270px    1fr    150~250px   210~330px
```

**左侧简易列表**（每个对手一条，悬停/点击/键盘聚焦切换）：
魔女化进度条 · 魔女化百分比 · 三组线索记录灯 · 手牌数 · 魔女化/出局标签 · 当前回合标识

**立绘竖列**（独立一列，占满主区高度）：
整列展示当前聚焦对手的立绘，随魔女化切换 `normal → stress → witch` 三档素材
（`character_image/normal|stress|witch/*.webp`，13 个角色 × 3 档全部齐备），
魔女化时列边框转红并显示「魔女化」角标。

**右侧详情面板**：
玩家名 · 角色名 · 魔女化（进度条 + 百分比 + 是否魔女化）· 技能（类型/名称/说明/消耗/冷却/限制/强化）·
手牌详细（逐张点数）· 三组线索记录灯 + 持有的线索卡名称

### 9.3 过程中修掉的三个坑

1. **时钟精灵字体缩放算错**：`CLOCK_FONT.charWidth = 128`，我最初用 `scale 0.82` 渲染百分比，
   结果单个元素 **351×108px** 塞进 228px 宽的条目里，整张卡 5~6 个元素溢出。
   按目标字号重算：列表百分比 `0.12`（≈15px）、详情百分比 `0.14`、手牌 `0.16`、消耗 `0.11`。
2. **立绘被 flex 挤成 16×35px**：`.od-portrait` 原本是 `flex: 0 1 auto`，被下方信息块压到几乎没有高度 ——
   识图因此直接判定"没有详情面板"。这也正是拆出独立竖列的直接原因。
3. **`renderClockDecimal` 输出的数字是背景图**，`textContent` 只有 `".%"`。
   验收脚本不能靠文本断言，改成数 `.clock-font-char` 精灵字符。

### 9.4 验收

`.dev/verify_opponent_panels.mjs` —— **49/49 通过**（7 种尺寸 × 7 条断言）：

| 断言 | 说明 |
| --- | --- |
| 左侧显示 3 个对手简易卡 | 2/3/4 人局下的对手数正确 |
| 简易卡含所需信息 | 进度条 + 百分比 + 三组灯 + 手牌数都存在 |
| 简易卡内无元素溢出 | 修好字体缩放后为 0 |
| 默认聚焦第一个对手 | 有且仅有一个 focused |
| 详情面板含全部要求项 | 名字/技能/三行灯/魔女化百分比 |
| 立绘独立成列且尺寸足够 | 已加载且 ≥120×150 |
| 左右面板不压棋盘 | 三块面板与棋盘网格均不相交 |
| 切换后详情随之更新 | 切到魔女化玩家后立绘变 `witch/*` 且出现「魔女化」角标 |

立绘列实际尺寸：1920→246×653，1440→219×446，1280→194×376，1152→175×323。
布局验收 72/72 保持；识图复核（1280 与 1920，4 人局）四项全部确认。

窄屏（≤1100）仍沿用原有的横向玩家条，三块新面板隐藏 —— 这也是待办里的一条。

### 9.5 魔女化数值：显示原始值（可以超过上限）

**问题**：新面板里我把数值写成了 `min(100, 百分比)`，导致超过上限的值永远显示 100%，
而原版显示的是**原始魔女化值**（`renderClockDecimal(player.witchification, …)`），
会出现 105%、120% 这种超上限数字。

**修正**：拆成三个函数，各自语义明确：

| 函数 | 用途 |
| --- | --- |
| `getWitchBarPercent()` | 进度条宽度：按上限换算并夹紧到 0~100 |
| `getWitchValue()` | 界面显示的数值：**原始值，不夹紧** |
| `isWitchOverLimit()` | 是否达到/超过上限（用于高亮） |

超上限时数值转红色并加光晕，详情面板额外显示「上限 100」（梅露露为 150），
数值元素带 `data-witch-value` 便于精确断言。

### 9.6 进度条恢复流光效果

原版流光来自 `.player-card-witch-fill`：

```css
background-image: linear-gradient(90deg, #9b59b6, #e94560, #9b59b6, #e94560);
background-size: 200% 100%;
animation: witchBarFlow 3s linear infinite;   /* background-position 0% → 200% */
```

我在新面板里用了内联纯色渐变，把流光弄丢了。修正方式：用 CSS 变量把角色配色传给新进度条，
再套上原版同款「双段渐变 + 200% 宽度 + 位移动画」，同时保留每个角色的 `barColors`：

```css
.op-witch-fill, .od-witch-fill {
    background-image: linear-gradient(90deg, var(--wc1), var(--wc2), var(--wc1), var(--wc2));
    background-size: 200% 100%;
    animation: witchBarFlow 3s linear infinite;
}
```

### 9.7 移除控制台里可折叠的角色卡

自己的信息既然已在左侧列表（带「你」标记）与右侧详情面板完整呈现，
控制台里那张可折叠的角色卡就是重复内容，已删除：

- `index.html`：移除 `#console-toggle-btn`、`#console-collapsible`、`#user-player-card-wrapper`
- `game.js`：移除 `renderUserPlayerCard()`（约 110 行）、`toggleUserConsole()`、`openUserConsole()`、
  `isConsoleCollapsed` 状态，以及"轮到用户时自动展开控制台"的逻辑
- 受击/治愈闪动原本打在卡片上，改为按 `data-index` 命中新的列表条目，效果不丢
- 保留：魔女化进度条、手牌区（`#user-hand-cards`）、发动魔法按钮 —— 这些是操作区，不受影响

**顺带的收益**：控制台从 194~263px 降到约 120px，竖向空间还给棋盘：

| 尺寸 | 棋盘（移除前 → 后） |
| --- | --- |
| 1920×1080 | 644 → **759** |
| 1440×810 | 440 → **540** |
| 1280×720 | 371 → **469** |
| 1024×640 | 254 → **350** |
| 800×600 | 204 → **298** |

**顺手修的一个层叠陷阱**：第九节的四列定义写在 `≤1100px` 单列断点之后，
把窄屏的单列规则覆盖了，导致 1024×640 下棋盘被挤到 182px。
已在文件末尾重新声明窄屏单列，棋盘恢复到 350px。

> 清理死代码时踩的坑：`game.js` 里有两种空行（纯空行 / 带 4 个缩进空格），
> 用带 `\n\n` 的字面量替换会匹配失败；正则里必须写 `[ \t]*\r?\n[ \t]*\r?\n`。
> 还有一次正则吃多了，留下悬空的 `});` 导致 `node --check` 报错 —— 是语法检查抓出来的。

### 9.8 本阶段验收

`.dev/verify_opponent_panels.mjs` **61/61 通过**（7 尺寸 × 8~9 条断言），新增三条针对本轮问题的断言：

| 断言 | 判据 |
| --- | --- |
| 魔女化显示原始值且超上限高亮、进度条夹紧 | `data-witch-value === 120`、`over` 类存在、条宽 100%、上限文案含 100 |
| 进度条保留流光动画 | 计算样式 `background-size === '200% 100%'` 且 `animation-name` 含 `witchBarFlow` |
| 左侧显示自己的卡 + 3 个对手 | 条目数 4、首条 `is-self`、自己条数 1 |

布局 72/72、几何遮挡 0/0、房间与角色卡 24/24、本轮四项 45/45、规则页码 6/6、
JS 7/7、CSS 2197/2197、HTML 206/206、事件接线 43/0、联机 16/16、资源 180 全 200。

### 9.9 三处修正（线索灯 / 诺亚进度条 / 梅露露上限）

**① 自己的线索记录灯显示到手牌区中间**

`index.html` 在 `.user-console-main` 里新增 `#user-clue-lights` 容器，
`renderUserConsole()` 调用新增的 `renderUserClueLights(player)` 渲染三组灯（图标 + 圆点 + 数字）。

居中方式踩了个坑：flex 下给中间元素 `margin: 0 auto` 只能占用两侧**剩余**空间，
手牌区与操作按钮宽度不等时会偏心（实测 1920 偏差 351px）。
改成三列网格 `minmax(0,1fr) auto minmax(0,1fr)`，中间列天然居中 —— 实测偏差 1px。

**② 诺亚的魔女化进度条看不见**

根因：诺亚的 `barColors[0]` 不是颜色，而是**一整串渐变**：

```js
barColors: ['linear-gradient(90deg,#e94560,#f39c12,#27ae60,#3498db)', '#000']
```

我之前把它塞进 `--wc1` → `linear-gradient(90deg, linear-gradient(...), …)` 语法非法，
整个 `background-image` 失效，进度条**完全不可见**。

修正：改用 `game.js` 里早已存在、能区分"颜色对/整串渐变"的 `getWitchBarGradient(char)`，
把结果放进 `--wc-grad`；流光改由 `::after` 白色高光层叠加实现 ——
底色是角色原配色（诺亚的彩虹条完整保留），高光在其上流动，
任何配色都不会因语法问题失效。

**③ 梅露露魔女化上限 150 → 120**

`'meruru' ? 150 : 100` 共 **7 处**全部改为 `120`，相关注释 5 处同步更新（已确认无残留）。

### 9.10 本阶段验收

`.dev/verify_three_fixes.mjs` —— **15/15 通过**（5 种尺寸 × 3 条断言）：

| 断言 | 判据 |
| --- | --- |
| 线索灯在手牌区中间 | 3 行、圆点 > 0、计数非全 0、夹在手牌区与按钮之间、**行居中偏差 ≤8px** |
| 诺亚进度条可见且有流光 | `background-image` 含 `gradient`（非 `none`）、`::after` 的 `animation-name = witchBarFlow`、有实际宽度 |
| 梅露露上限 120 | `getWitchLimit()` 返回 120、详情显示「上限 120」、120 时进度条夹紧 100% 且标红 |

> 断言里踩的坑：`getComputedStyle(fill)` 读的是底色层（`100% 100%`），
> 流光在 `::after` 伪元素上，必须用 `getComputedStyle(fill, '::after')` 才能读到 `200% 100%`。

全量：对手面板 61/61、布局 72/72、几何遮挡 0/0、房间与角色卡 24/24、本轮四项 45/45、
规则页码 6/6、JS 7/7、CSS 2213/2213、事件接线 43/0、联机 16/16。

### 9.11 胜利/处刑混淆 + 离场后技能仍可操作

**① 胜利被显示成「出局」**

根因在数据模型：`playerWins()` 和 `playerLoses()` **都设 `isEliminated = true`**
（语义是"已离场"），界面却用 `isEliminated` 判断"出局"——于是胜利者必然被标成出局并变灰。

旧的 `renderPlayerCard` 用 `isEliminated && rank === 1` 猜胜负，同样不成立：
名次只表示离场顺序，**第 2 个胜利者的 rank 就是 2**，会被判成"失败"。

修正：新增显式结果字段，由结算函数写入：

| 字段值 | 来源 | 界面表现 |
| --- | --- | --- |
| `outcome = 'win'` | `playerWins()` | 金色「胜利」标签 + `.won` 描边，不置灰 |
| `outcome = 'executed'` | `playerLoses()` | 灰色「出局」标签 + `.defeated` 置灰 |
| `outcome = 'last'` | `checkGameEnd()` 最后一名 | 灰色「最后一名」 |

所有基于 `isEliminated` 的显示判断都改为基于 `outcome`
（对手面板、旧角色卡、顶部玩家条里那个从未存在的 `isDefeated` 字段）。

**② 音效不是胜利音效**

`playVictoryVoice()` / `playDefeatVoice()` / `playWitchVoice()` / `playMagicVoice()`
**共用同一个 `characterVoicePlayer`**，每个函数开头都会 `pause()` 前一个实例。
胜利语音刚响起，若同回合有人被处刑（`endRound` 里连续处理多个玩家），
失败语音就把胜利语音掐断了 —— 听感就是"播的不是胜利音效"。

修正：四类语音各用独立播放器（`victoryVoicePlayer` / `defeatVoicePlayer` /
`witchVoicePlayer` / `magicVoicePlayer`），互不打断；`stopCharacterVoice()` 统一停止全部。

**③ 胜利后被动技能还能操作**

`.btn-passive-toggle` 是无状态按钮，`togglePassive()` 也不检查回合/离场，
所以整局都能点。修正：

- `renderSpecialButtons()`：玩家已离场或 `gameState.status === 'ended'` 时直接不渲染开关
- `togglePassive()` / `toggleShadowWorld()` / `castMagic()` / `playCard()`：补离场防护
- `updateMagicButton()`：离场时 `disabled = true` 且徽章显示「已胜利 / 已离场」
- `renderConsoleEliminatedState()`：控制台进入只读态（`.console-locked` 置灰 + 顶部提示
  「🏆 你已胜利（第 1 名）」/「⚰️ 你已被处刑（第 4 名）」）
- 另外发现 `gameState.status = 'ended'` **从未被设置**，已在 `checkGameEnd()` 补上

### 9.12 本阶段验收

`.dev/verify_win_state.mjs` —— **17/17 通过**（4 种尺寸 × 4 条断言 + 1 条加载检查）：

| 断言 | 判据 |
| --- | --- |
| 胜利显示「胜利」 | `outcome='win'`、存在 `.op-tag.win`、**不存在** `.op-tag.defeated`、有 `.won` 类 |
| 胜利播胜利语音 | 日志含 `playVictoryVoice` 与「胜利」弹窗，且**不含** `playDefeatVoice` |
| 胜利后控制台只读 | 魔法按钮 `disabled=true`、被动按钮数 0、`.console-locked`、提示含「胜利」 |
| 处刑显示「出局」 | `outcome='executed'`、`.op-tag.defeated` 文本为「出局」、无胜利标签、播失败语音 |

诊断脚本 `.dev/diag_win_lose.mjs` 用于对比修复前后（修复前：`op-tag defeated">出局<`；
修复后：`op-tag win">胜利<`，被动按钮从"存在且可点"变为 0 个）。

全量：对手面板 61/61、布局 72/72、几何遮挡 0/0、三处修正 15/15、房间与角色卡 24/24、
本轮四项 45/45、规则页码 6/6、JS 7/7、CSS 2225/2225、HTML 208/208、事件接线 43/0、
联机 16/16、资源 180 全 200。

### 9.13 窄屏双标签溢出

「出局 + 魔女化」两个标签同时出现时，1152×648 下 head 行内容超出条目约 20px
（名字已能省略号收缩，溢出源是固定宽度的标签本身）。

修正：`≤1260px` 收起次要的「魔女化」标签（状态仍由进度条颜色、立绘切换、条目边框表达），
并缩小标签字号；`≤1180px` 把「你」压缩成「我」。

> 测量口径的坑：`display:none` 的元素 `getBoundingClientRect()` 返回 0×0 且在 (0,0)，
> 会被误判成"溢出条目左边界"。几何断言必须过滤宽高 ≤0.5px 的元素。

`.dev/diag_tag_overlap.mjs` —— 4 尺寸 × 4 条目 **16/16 无重叠、无溢出**。

> 顺带：识图模型 `deepseek-v4-flash-vision` 已于 2026-11-13 下线，
> `.dev/vision.mjs` 已切换到官方推荐的 `deepseek-v4.1-flash-1017`。

### 9.14 黑部奈叶香：里世界按钮与棋盘显示

收拾这套机制时发现它有三份互相冲突的实现：

1. `renderSpecialButtons()` 里的旧按钮：读写 `player.inShadowWorld`，调 `toggleShadowWorld(currentPlayer)`
2. 另一份 `toggleShadowWorld()`（无参）：读写 `gameState.showingShadowWorld`，是真正管视图的那个
3. `renderNayekaShadowButton()` **定义了两遍** —— 后面的那份把按钮
   `appendChild` 到 **`#board-container`** 里，还绑了 `mouseenter/mouseleave` 悬停切换
4. `renderBoardShadowView()` 是**第二套棋盘渲染器**，与 `renderBoard()` 重复
   （`renderBoard()` 第 4387 行本来就会读 `showingShadowWorld` 渲染里世界）

**由此产生的实际问题**：
- 两个同名 `toggleShadowWorld` → 后定义覆盖前定义，旧按钮点下去切换的是视图，
  但按钮文案读的是 `player.inShadowWorld`（永不变）→ 文案永远显示「里世界」
- 按钮被塞进 `#board-container`（`display:grid; place-items:center`）→ **棋盘被挤偏**，
  这就是"棋盘的正常显示问题"
- 悬停即切换，鼠标移开立刻还原，完全不可用

**整理后的结构**：

| 项目 | 处理 |
| --- | --- |
| 控制台按钮 | 只留一个 `.btn-shadow-world`，文案由 `gameState.showingShadowWorld` 驱动：「查看里世界」/「回到现实世界」 |
| 被动开关 | 奈叶香不显示（`char.id !== 'nayeka'`），这个位置让给里世界按钮；其他被动角色不受影响 |
| `toggleShadowWorld` | 只保留无参版本；删除重名的那份 |
| `renderNayekaShadowButton` | 只保留空壳兼容（原调用点仍在，调用即无操作） |
| `renderBoardShadowView` | 整个删除，改为 `renderBoard()` + `refreshShadowButtonLabel()` |
| `#board-container` | 不再塞入任何按钮，容器内只有棋盘和格子信息面板 |

**还有一个隐蔽的布局耦合**：按钮文案从 5 字变 6 字后变宽 9px，把「发动魔法」按钮
挤到换行，`#user-controls` 从 98px 涨到 **150px**，控制台挤掉 52px → 棋盘 447 缩到 395。
修法是让按钮宽度与魔法按钮换行都不受文案影响（`flex: 0 0 auto` + `min-width` +
`white-space: nowrap`），现在两种视图下控制台恒为 77px、棋盘尺寸**逐像素一致**。

### 9.15 本阶段验收

`.dev/verify_nayeka.mjs` —— **41/41 通过**（4 尺寸 × 10 条断言 + 1 条其他角色回归）：

| 断言 | 判据 |
| --- | --- |
| 只有一个里世界按钮、没有被动按钮 | `.btn-shadow-world`=1、`.btn-passive-toggle`=0、文案正确 |
| 现实世界棋盘正常 | 无杂物子元素、宽高差 ≤1、36 格、36/36 中心命中、棋子全在棋盘内 |
| 棋盘不被切出视口 | 棋盘矩形完全落在视口内 |
| 切换后按钮状态生效 | `showingShadowWorld=true`、文案「回到现实世界」、`active` 类 |
| 里世界棋盘正常 | 里世界格 = 真实格数（27/27，其余 9 个是装饰/空格）、36/36 命中 |
| **切换视图不改变棋盘尺寸** | 两种视图的棋盘矩形**逐像素相同**（729/536/468/390） |
| 每格都渲染了效果名与图标 | 27/27 有名称、有图标、有点数 |
| 格子信息面板不遮挡格子 | 面板出现且遮挡格子数 = 0 |
| 重渲染后仍保持里世界 | `renderGame()` 后仍是里世界视图、棋盘尺寸不变 |
| 切回复原 | 文案/视图/棋盘全部复原 |
| 其他被动角色不受影响 | 安安（`magicType=passive`）仍有被动开关、无里世界按钮 |

> 顺带确认：`.moving-token`（移动动画棋子）是 `position:absolute`，临时插入
> `#board-container` 不影响网格布局，无需处理。

全量：奈叶香 41/41、胜负 17/17、三处修正 15/15、对手面板 61/61、布局 72/72、
几何遮挡 0/0、房间 24/24、四项 45/45、规则 6/6、JS 7/7、CSS 2236/2236、
HTML 208/208、事件接线 43/0、联机 16/16、资源 180 全 200。

### 9.16 联机选角：小图全碎 + 选完进不了游戏

**① 角色小图全部加载失败**

`getCharIcon(char, size)` 返回的是**完整的 `<img>` 标签字符串**，而联机选角把它塞进了 `src`：

```js
<img src="${getCharIcon(char, 'small')}" ...>   // → src="<img src=icon/...>" 非法地址
```

单人选角用的是 `src="${char.icon}"`，所以只有联机界面是全碎的。
修正：直接嵌入 `getCharIcon()` 的返回值（它自带 `<img>`）。

**② 选完角色永远进不了游戏**

`handleMQTTMessage` 会过滤自己发的消息（`senderId === localPlayerId`），
而 `handleCharacterSelected()` **只由消息路由调用** —— 于是**本地玩家自己的选择永远不会被应用**：
选角序号停在原地、`selectedCharacters` 一直为空，所有人都卡在选角界面。

修正：
- `confirmOnlineCharacterSelect()` 发送消息后**本地立即应用一次**这次的选角
- 给 `handleCharacterSelected()` 加幂等（`seat.character === message.characterId` 直接返回），
  这样 broker 回声回来时不会重复推进、也不会把游戏初始化两次

### 9.17 本阶段验收

- `.dev/b_dual_client.mjs` —— **19/19**（新增 3 条：小图不再嵌套、房主确认后选角序号推进
  `0 → 1`、两端选完进入开局 `players=2`）
- `.dev/verify_online_select.mjs` —— **9/9**（3 尺寸）：13 张卡全部渲染、
  **13 张小图 `naturalWidth > 0`（512×512）**、不可用 5 个 / 可选 8 个

### 9.18 五个「多人暂不可用」角色的真实原因

| 角色 | 阻塞点 | 结论 |
| --- | --- | --- |
| 樱羽艾玛 | 魔法无需选择目标，`magicStates` 已在同步状态内 | 可直接验证开放 |
| 紫藤亚里沙 | 点火在主机侧删格子效果，状态同步即可 | 小改 + 验证 |
| 城崎诺亚 | 强化"只有诺亚能看见"**已按查看者判定**（`isNoah` 取自本地玩家） | 可直接验证开放 |
| 黑部奈叶香 | `nayekaVisionActive` 在同步状态里 → **她的私人视野会泄露给所有人** | 该 flag 需改为本地 |
| 冰上梅露露 | 治愈需选择目标 → 缺远程选择 UI（现有 7 种被动决策 UI 未覆盖） | 需新增 UI，工作量最大 |

7 个可用角色都依赖同一套 `passive_decision` 远程决策层
（`hiro_block` / `anan_brainwash` / `coco_clairvoyance` / `leiya_guidance` /
`milia_swap` / `marg_mimic` / `sherry_force`），这 5 个角色一个都没有接入。

### 9.19 开放艾玛 / 诺亚 / 亚里沙为多人可用（11/13）

逐个核对后开放三个（都**不需要**新的选择 UI）：

| 角色 | 依据 |
| --- | --- |
| 樱羽艾玛 | 魔法无目标选择；`magicStates` 在 `getSerializableGameState()` 的深拷贝里，天然同步 |
| 城崎诺亚 | 强化"只有诺亚能看见"本来就按查看者判定（`isNoah` 取自本地玩家），联机不泄露 |
| 紫藤亚里沙 | 点火在主机侧执行（`cast_magic` → `processRemoteCastMagic`），结果随状态同步 |

顺带修掉一个静默 bug：亚里沙有 `magicEnhanced`，魔女化后 `castMagic()` 会先路由到
`castEnhancedMagic()`，而那个 switch **没有 `case 'arisa'`** —— 点魔法完全没反应
（她原本写好的"自动触发"提示因此永远走不到）。已补上分支。

仍不可用的两个及其原因不变：奈叶香（`nayekaVisionActive` 在同步状态里，私人视野会泄露）、
梅露露（治愈需选目标，缺远程选择 UI）。

`.dev/verify_new_chars.mjs` —— **12/12**，用假 broker 走真实链路（guest 发起 → 消息 →
主机执行 → 广播 → 客机同步）：

| 断言 | 实测 |
| --- | --- |
| 艾玛：魔法生效记录 | 主机 `active=true owner=2`，客机同步一致 |
| 艾玛：魔女化 +95 | 两端均为 95 |
| 诺亚：格子重排 | 已重排，两端逐格一致，`noahUsedThisRound=1` |
| 亚里沙：烧毁周围格子 | 触发格 0 → 8，两端一致 |
| 亚里沙：魔女化后有提示 | 强化分派含 arisa 分支且无异常 |

`.dev/verify_online_select.mjs` —— **9/9**：13 张卡、小图全部 `naturalWidth > 0`、
**可选 11 个、不可用仅 2 个**（黑部奈叶香、冰上梅露露）。

### 9.20 开放奈叶香与梅露露（13/13 全部可用）

**① 先修掉一个影响所有人的查看者身份 bug**

```js
const humanPlayer = gameState.players.find(p => !p.isAI);
const isNoah = humanPlayer && humanPlayer.character.id === 'noah';
```

联机下**所有玩家的 `isAI` 都是 false**，这个写法永远拿到"玩家 1"，
于是诺亚的"只有诺亚能看见"和奈叶香的里世界判定全都按**玩家 1**算 ——
玩家 1 是诺亚时，**每个客户端都以为自己是诺亚**。

修正：`renderBoard()` 与 `showCellInfo()` 统一改用 `getLocalPlayer()`（按 `localPlayerId` 解析）。

**② 奈叶香：玩法效果全局同步，私有视野只有她本机**

这里必须分两层，混在一起就会泄露信息：

| 层 | 内容 | 归属 |
| --- | --- | --- |
| 玩法 | 格子**触发什么效果**（里世界效果） | 全局同步，必须所有人一致 |
| 视觉 | **看到全部格子的里世界名称** | 奈叶香的私有视野，只有她本机渲染 |

```js
// 改前：任何人都会看到
const showShadowWorld = nayekaVisionActive || gameState.showingShadowWorld;
// 改后：只有奈叶香本人
const showShadowWorld = isNayeka && (nayekaVisionActive || gameState.showingShadowWorld);
```

另外 `showingShadowWorld` 是纯视图开关，已从 `getSerializableGameState()` 中剔除，
避免同步给别人。

**③ 梅露露：治愈目标由本人远程选择**

治愈的弹窗逻辑本来就存在，但格子效果在**房主侧**结算 ——
弹窗会弹到房主屏幕上，本人反而看不到。现在接入了已有的远程决策通道：

1. 房主发现梅露露不是本机玩家 → `sendPassiveRequest('meruru_heal', herId, { targets, selfWitch }, cb, 15s)`
2. 她那台机器收到 `passive_request` → `showRemoteMeruruHealDecision()` 弹出目标列表
3. 选择后 `sendPassiveResponse(requestId, true, { targetId })`，选「不传递」则 `false`
4. 房主按回传的 id 执行 `executeMeruruHeal()`，超时/放弃则继续流程

远程界面复用单人那套 `.meruru-heal-*` 样式，没有新增 CSS。

### 9.21 本阶段验收

`.dev/verify_nayeka_meruru.mjs` —— **9/9**：

| 断言 | 实测 |
| --- | --- |
| 房主/客机各自解析到正确的本机玩家 | viewer=1 / viewer=2 |
| 奈叶香本机的查看开关不同步给别人 | 客机置 true 后 `host.showingShadowWorld` 仍为 false |
| 幻视玩法状态仍全局同步 | 两端 `nayekaVisionActive=true` |
| 梅露露收到远程目标选择请求 | 收到 requestId |
| 房主按远程选择结算 | 梅露露 20→15，目标 20→25 |
| 选「不传递」不改变任何人 | 目标 20→20、梅露露 20 |

定向回归：新角色 12/12、双端全流程 19/19、模式回退 12/12、
联机选角 **9/9（13 个角色全部可选、不可用 0 个）**。

### 9.22 联机稳定性升级（方案 A）

**诊断：不稳的主因不在 MQTT 协议，而在用法**

| 缺陷 | 代码事实 | 后果 |
| --- | --- | --- |
| QoS 0 全裸发 | `client.publish(topic, payload)` 无选项 | 每条动作都是"发了不管"，丢一条=丢一步操作 |
| 随机 clientId + `clean:true` | `'witch_' + random8` | 断线期间消息永久丢失，重连也留不住订阅 |
| 无序号、无周期同步 | `broadcastGameState()` 只在动作点调用 | 丢一次 state_sync，客机就一直停在旧状态 |
| 固定 2s × 5 次重连 | 10 秒后永久放弃 | 稍长的抖动就再也回不来 |

**采用的五项改动（只动网络层，架构不变）**

1. **QoS 1**：`publish(topic, msg, { qos: 1 })`；订阅也用 `{ qos: 1 }`
2. **稳定 clientId + 保留会话**：`getStableClientId()`（按标签页 `sessionUid`）+
   `clean: false`，重连可续上 broker 会话
3. **单调序号 + 接收端去重**：每条消息带 `seq`，接收端按发送者记录 `recvSeq`，
   重复序号丢弃、旧序号（乱序）丢弃 —— 避免用旧状态覆盖新状态
4. **房主每 5 秒周期全量同步**：`startPeriodicStateSync()` → `runPeriodicStateSyncOnce()`，
   丢包最多让客机落后 5 秒即可自愈，而不是"卡死到下一个动作"
5. **指数退避重连**：`computeReconnectDelay(attempt)` = `2s × 1.5^(n-1)`，封顶 30s，
   叠 ±20% 抖动；上限从 5 次放宽到 **15 次**（约可持续重试 5 分钟）；
   重连后**等订阅真正建立**再发 `reconnect` / 请求状态同步

顺带修：`subscribeToRoom(cb)` 现在会等四个主题全部订阅完成再回调（原来发消息可能抢在订阅之前）。

### 9.23 本阶段验收

`.dev/verify_plan_a.mjs` —— **9/9**，用假 broker 注入丢包/重复/乱序：

| 断言 | 实测 |
| --- | --- |
| 状态同步以 QoS 1 发布 | 捕获到 `qos=1` |
| 消息序号单调递增 | `seq=[3,4]` |
| 同序号重复消息只应用一次 | 首次 42 → 重复投递后仍 42（内容不同也不覆盖） |
| 旧序号被丢弃 | seq 99 晚于 100 到达，客机保持 100 的 50，未被 10 覆盖 |
| **丢包后周期同步自愈** | 用 `broker.dropNext` 丢掉一次 state_sync，客机停在 0；触发一次周期同步后 → 33 |
| 退避指数增长且封顶 | 1~10 次 = 1886/2858/4158/5796/16361/27351ms，25/40 次 ≈ 27~33s |
| 重连上限 15 次 | `maxAttempts=15` |
| clientId 稳定合法 | `witch_u_...`，两次调用一致、≤32 字符 |
| 断开后定时器清除、序号归零 | `stateSyncTimer=null`、`sendSeq=0` |

> 测试环境的一个坑：harness 把 `setInterval` 桩成 `() => 1`（避免进程不退出），
> 所以定时器本身测不到。因此把周期同步体抽成 `runPeriodicStateSyncOnce()`，
> 定时器与测试共用同一份逻辑，测试直接调用该函数 —— 逻辑只有一份，可测。

定向回归：双端全流程 19/19、模式回退 12/12、新角色 12/12、奈叶香+梅露露 9/9、JS 7/7。

**未做（可随时追加）**：房间码 6 位 → 8 位、连接诊断面板（显示 broker/延迟/seq 落后量）。
周期同步已预留诊断字段 `periodicTicks` / `periodicSkip` / `periodicLastAt`，接面板即可用。

### 9.24 联机进入游戏后 BGM 不切换

单人局在 `initGame()` 里会调用 `updateGameMusic()`，但联机的两个开局点都没有：

| 入口 | 位置 | 处理 |
| --- | --- | --- |
| 房主开局 | `initOnlineGame()`（`dealCards()` 之后） | 补 `updateGameMusic()` |
| 客机开局 | `startOnlineGame()` 的 `phase === 'game'` 分支（`syncGameState()` 之后） | 补 `updateGameMusic()` |

不放回大厅音乐的问题不存在：`resetAllGameState()`（L7140）与 `handleResultReturn()`（L7309）
本来就会 `playHubMusic()`。

**设计说明**：`updateGameMusic()` 按场上状态选曲 —— 有人魔女化则 `Witch`，否则 `common`；
交锋音乐由 `playBattleMusic()` 单独控制，互不干扰。

### 9.25 本阶段验收

`.dev/verify_online_bgm.mjs` —— **5/5**（断言 `audioState.currentCategory`，
该字段在静音/未加载 BGM 时同样会记录，因此无需真实音频）：

| 断言 | 实测 |
| --- | --- |
| 单人对局开局为 common（基线） | `common` |
| 房主联机开局切到 common | `common` |
| 客机收到开局后切到 common | `common` |
| 场上有人魔女化时切到 Witch | `Witch` |
| 回大厅能切回 Hub（未受影响） | `Hub` |

定向回归：双端全流程 19/19、方案 A 9/9、新角色 12/12、奈叶香+梅露露 9/9、JS 7/7。

### 9.26 联机移动过程只有房主看得见

**根因**：`executeMove()` 每走一步只做本地 `renderBoard()`，**从不广播**；
整段移动结束才由 `afterCellEffect` 广播一次。所以：

- 房主：看得到逐步移动（动画在本机执行）
- 其他所有人（包括移动者自己）：只看到棋子**瞬移**到最后位置

**修正**：`executeMove()` 里每走一步就 `broadcastGameState()`（仅房主，保持权威）。
客机收到状态后逐格重绘，移动过程对所有人可见。

**顺带修的分叉选方向**：`showDirectionArrows()` 无条件画在**当前执行端**，
而移动逻辑只在房主执行 —— 所以远程玩家移动遇到分叉时，箭头画在房主屏幕上，
房主替他选了方向。

改为：远程人类玩家遇到分叉时，房主发 `sendPassiveRequest('fork_direction', …)`
（复用已有的远程决策通道），由**本人**那台机器画箭头并回传方向；
20 秒超时或放弃则随机走一个方向，避免整局卡死。

### 9.27 本阶段验收

`.dev/verify_online_move.mjs` —— **5/5**：

| 断言 | 实测 |
| --- | --- |
| 房主每走一步都广播 | 单步移动触发 1 条 `state_sync` |
| 客机看得到这次移动 | 客机棋子位置 = 目标格 |
| 客机本地移动不越权广播 | 客机发出 0 条 `state_sync` |
| 远程玩家收到分叉选择请求 | 收到 `requestId` |
| 房主收到远程选的方向 | `activate=true direction=12` |

定向回归：双端全流程 19/19、方案 A 9/9、BGM 5/5、新角色 12/12、
奈叶香+梅露露 9/9、模式回退 12/12、JS 7/7。

> 已知限制：客机看到的是**逐格重绘**（每次跳一格），没有房主那种 300ms 的滑动动画 ——
> 因为动画依赖房主侧的 `animateMove()` 时序。要完全一致需要把每步作为独立事件广播
> 并在客机复现动画，属可选优化。

### 9.28 移动改为"逐格事件 + 两端同款动画"

9.26 的做法是每步广播整包状态，客机逐格**重绘**（跳格），与房主的 300ms 滑动不一致。
本次改为事件驱动：

1. **抽出 `createMovingToken(player, from, to)`** —— 房主 `animateMove()` 与客机复现
   共用同一份实现（同一个 `.moving-token` class、同一套定位算法、同样 300ms），
   这是"两端完全一致"的关键，避免两处各写一遍后漂移。
2. **`broadcastMoveStep()`** 在 `animateMove()` 开头发出 `move_step` 轻量事件
   （`{playerId, from, to, remaining}`），房主与客机**同时**开始滑动。
3. **客机 `handleMoveStepEvent()`** 进队列顺序播放，`playRemoteMoveStep()` 建 token →
   300ms 后落位 + 更新本机 `moveState`（最终仍以房主状态为准）。
4. **移除** 9.26 在 `executeMove()` 里的逐步整包广播 —— 每一步只发一条几十字节的事件，
   而不是一份完整的 `gameState`。

**边界处理**

| 情况 | 行为 |
| --- | --- |
| 整包状态先到（位置已是终点） | 不补动画、不回跳，直接对齐 |
| 多步连走 | 队列逐格播放，不会几条动画叠在一起 |
| DOM 缺格子（无法动画） | 直接落位 `renderBoard()` |

### 9.29 本阶段验收

`.dev/verify_online_move.mjs` —— **8/8**（用真实棋盘连接数据，非桩值）：

| 断言 | 实测 |
| --- | --- |
| 每步广播独立 `move_step` 事件 | `player=2 6→5 remaining=2` |
| 移动步骤不再整包同步 | 本次移动发出 **0** 条 `state_sync` |
| 客机创建 `.moving-token` | 1 个 |
| 动画中棋子仍在起点（滑动非瞬移） | 位置=6（起点） |
| 动画结束落在目标格 | 位置=5 |
| 连走两步按顺序落位 | 6→5→4，最终 4 |
| 队列排空无堆积 | `busy=false` |
| 状态先到不多播动画 | 位置=5 不变 |

定向回归：双端全流程 19/19、方案 A 9/9、BGM 5/5、新角色 12/12、
奈叶香+梅露露 9/9、模式回退 12/12、JS 7/7。

### 9.30 选择类操作全部显示在房主屏幕上

**审计结果（`.dev/audit_selection_ui.mjs`）**

扫了全部 19 个选择类界面，**没有一个**在函数体内做联机判断：

| 函数 | 行范围 | 触发者 |
| --- | --- | --- |
| `showResourceSelectModal` | 6117-6175 | `triggerCell`（地下室/娱乐室） |
| `showConfrontationModal` | 7745-7821 | `startConfrontation` |
| `showStealSelection` | 8529-8592 | `startStealPhase` |
| `showHannaStepSelection` | 3165-3218 | 汉娜魔法 |
| `showLeiyaEnhancedForkChoice` | 4140-4188 | `checkLeiyaMagicAtFork` |
| `showCocoBasementModal` / `showBasementModalForPlayer` | 5368/9612 | 可可/地下室 |
| `showNayekaCellSelection` / `showShadowSwapSelection` / `showShadowForceDeleteSelection` / `showShadowDeleteCardSelection` | 9184-9543 | 奈叶香里世界 |
| `showSherryTargetSelection` / `showSherryConfrontationChoice` | 2907/8075 | 雪莉 |
| `showMargPassiveChoice` | 9887 | 玛格模仿 |
| `showMeruruHealSelection` | 10132 | 治愈（9.20 已修） |
| `showDirectionArrows` | 5546 | 分叉（9.26 已修） |

关键发现：**远程消息通道其实大半已经写好了** ——
`confirmResourceSelect` / `confirmSteal` / `handleReactionPress` 里早就有
"非房主就 `sendMessage(...)`"的分支。真正缺的只有一环：
**客机从来没看到界面，所以永远不会触发那个分支**。

**修法：房主不再替远程玩家弹窗，改为"请求 → 本人 UI → 回传"**

| 流程 | 房主侧 | 客机侧 |
| --- | --- | --- |
| 地下室 / 娱乐室 | `requestRemoteResourceSelect()` → `sendPassiveRequest('resource_select')` | `showRemoteResourceSelect()` 复用单人 `#resource-modal` → 回传 `{selected}` |
| 交锋 | 广播 `confrontation_start`（参与者）/ `confrontation_light` / `confrontation_end` | `showRemoteConfrontation()` 重建本机交锋状态并显示 → `handleReactionPress` 回传 |
| 偷牌 | `requestRemoteSteal()` → `sendPassiveRequest('steal_select')` | `showRemoteStealSelect()` 渲染 `.steal-selection` → 回传 `{indexes}` |

**同时修掉两个隐患**

1. **时钟偏差导致排名失真**：`resolveNormalConfrontation` 按
   `pressTime`（各机器 `Date.now()`）排序。现在客机回传**相对耗时**
   `reactionMs = pressTime - 本地灯亮时刻`，房主换算成
   `房主灯亮时刻 + reactionMs`，大家回到同一时钟。
2. **`sendPassiveRequest` 字段被业务数据覆盖**：
   原来是 `{ requestId, skillType, targetPlayerId, ...data }`，
   业务数据若带 `type` 键会把消息类型 `type='passive_request'` 覆盖掉，
   接收端当成未知消息直接丢弃。已把 `...data` 移到最前，固定字段在后。

**防卡死兜底**

- 地下室/娱乐室、偷牌：`sendPassiveRequest` 自带 20 秒超时 → 按"放弃"继续流程
- 交锋：灯亮后 6 秒仍未收到远程玩家的按下，按"没来得及按"补位并继续

### 9.31 本阶段验收

`.dev/verify_remote_choice.mjs` —— **12/12**：

| 断言 | 实测 |
| --- | --- |
| 房主判定 P2 为远程玩家 | `isRemote=true` |
| 客机判定 P2 是自己 | `isRemote=false` |
| 客机收到地下室选择请求 | 收到 `requestId` |
| 客机选中的卡真的给了房主侧玩家 | 选 `evidence_x2_1`，P2 现有 `["evidence_x2_1"]` |
| 房主据此继续格子流程 | `continued=true` |
| 客机重建交锋状态 | `active=true`，人数 2 |
| 客机同步亮灯 | `lightOn=true` |
| 房主收到客机按下 | `tooEarly=false` |
| 按下时间换算到房主时钟 | 房主 `=1794563194250`，灯亮 `=1794563194045` |
| 客机收到偷牌请求 | 收到 `requestId` |
| 房主按远程选择执行抢夺 | 败者证据 2 → 1 |
| 不回应时不立即继续（挂起等本人） | `continued=false` |

定向回归：联机移动 8/8、双端全流程 19/19、方案 A 9/9、BGM 5/5、
新角色 12/12、奈叶香+梅露露 9/9、模式回退 12/12、JS 7/7。

**尚未接入远程界面的（下一批）**：汉娜浮空步数 / 蕾雅强化分叉 / 奈叶香四处里世界选择 /
雪莉目标与交锋选择 / 可可地下室 / 玛格模仿。它们的消息类型（`hanna_step_selected`、
`shadow_swap`、`shadow_delete`）部分已存在，可沿用本次同一套模式。

### 9.32 第二批：汉娜 / 蕾雅 / 奈叶香 / 雪莉 / 可可

沿用 9.30 的同一套模式（房主不弹窗 → 请求 → 本人 UI → 回传 → 房主结算）：

| 流程 | 房主侧 | 客机侧 | 超时兜底 |
| --- | --- | --- | --- |
| 汉娜浮空步数 | `requestHannaStep()` → `hanna_step` | `showRemoteHannaStep()` 复用单人弹窗 | 20s → 按取消（不消耗魔法） |
| 汉娜浮空方向 | `hanna_direction` + 箭头选项 | `showRemoteHannaDirection()` 复用箭头（加 `.hanna-float-arrow`） | 20s → 随机方向 |
| 蕾雅强化分叉 | `leiya_fork` | `showRemoteLeiyaFork()` 复用单人弹窗 | 20s → 随机方向 |
| 里世界·位置互换 | `shadow_swap_select` | `showRemoteShadowSwap()` | 20s → 不互换，继续流程 |
| 里世界·强制删除 | `shadow_force_delete` | `showRemoteShadowForceDelete()` | 20s → 不删除，继续流程 |
| 里世界·地下室 | 复用 `resource_select` | 复用 `#resource-modal` | 20s → 放弃 |
| 可可·千里眼地下室 | 复用 `resource_select` | 同上 | 20s → 放弃 |
| 雪莉·巨力化强化目标 | `sherry_target` | `showRemoteSherryTarget()` | 20s → 强化不生效 |
| 雪莉·交锋巨力化 | `sherry_confrontation` | `showRemoteSherryConfrontation()` | 20s → 走正常交锋 |

**实现要点**

1. 每个流程的 `confirm*` 函数都新增了「优先回传房主」分支（`remoteXxxRequestId` 存在时走
   `sendPassiveResponse`），避免与既有的「非房主 sendMessage」分支冲突。
2. 里世界互换/强制删除原本只有 `shadow_swap` / `shadow_delete` 单向上报，
   房主侧随之用请求-响应重写：房主收到选择后**直接结算并继续回调**，
   保证格子效果链不会停在半途。
3. 雪莉交锋那条必须在 `resolveConfrontation()` 里分流：远程雪莉先存
   `gameState.sherryConfrontationState`，收到回传后调用同一个
   `confirmSherryConfrontation(activate)`，逻辑只有一份。

**测试环境改进**：harness 里元素级 `querySelector()` 原来恒返回 `null`，
导致 `modal.querySelector('.confrontation-content')` 之类真实写法在桩下崩掉。
改成返回元素，更接近真实 DOM。

### 9.33 本阶段验收

`.dev/verify_remote_choice2.mjs` —— **11/11**：

| 断言 | 实测 |
| --- | --- |
| 汉娜被判为远程 | `isRemote=true` |
| 客机收到浮空步数请求 | 收到 `requestId` |
| 房主按远程选择执行 | 魔女化 20 → 35（+15，浮空已发动） |
| 客机收到蕾雅分叉请求 | 收到 `requestId` |
| 房主收到远程蕾雅指定方向 | `picked=20` |
| 客机收到里世界互换请求 | 收到 `requestId` |
| 房主完成互换 | 位置 1/6 → 6/1 |
| 客机收到强制删除请求 | 收到 `requestId` |
| 房主删除对方证据 | 2 → 1 张 |
| 客机收到雪莉巨力化询问 | 收到 `requestId` |
| 房主走正常交锋 | 排名 2 人 |

定向回归：地下室/交锋/偷牌 12/12、移动 8/8、双端 19/19、方案 A 9/9、
BGM 5/5、新角色 12/12、奈叶香+梅露露 9/9、模式回退 12/12、JS 7/7。

**目前选择类 UI 的联机覆盖**：地下室、娱乐室、交锋、偷牌、汉娜（步数/方向）、
蕾雅强化分叉、里世界（互换/强制删除/地下室）、可可地下室、雪莉（目标/交锋）、
梅露露治愈、玛格模仿、7 个被动技能 —— 均已归本人操作。
仅 `showNayekaCellSelection` 无调用点（死代码），不涉及。

### 9.34 主界面没有背景音乐（BGM 一旦被拦就永久静音）

**排查过程**：用 CDP 连真实 Chrome 逐层排除——

| 检查 | 结果 |
| --- | --- |
| Hub 曲目配置 | 6 首 ✓ |
| 文件是否存在 | 6 个都在，1.9~3.4 MB ✓ |
| HTTP 取回 | `200` / `audio/mpeg` / 2388428 字节 ✓ |
| `<audio>` 元素 | `readyState=4`（已加载）✓ |
| 启动时是否调用过播放 | `currentCategory === null` —— **从未调用过** |

再模拟一次点击触发首交互解锁，`currentCategory` 变成 `'Hub'`、曲目已设，
但 **`isPlaying: false`、`volume: 0`** —— 浏览器把 `play()` 拦了。

**根因（两处叠加，导致永久静音）**

```js
function playHubMusic() {
    if (audioState.currentCategory !== 'Hub') {   // ← 病根
        playRandomFromCategory('Hub');
    }
}
```

1. `startNewBGM()` **先**把 `currentCategory` 设成目标类别，再去 `play()`。
   一旦 `play()` 被自动播放策略拒绝，类别已经是 `'Hub'`、音频却没响，
   之后任何恢复调用都会被上面的判断挡掉 —— 再也回不来。
2. 淡入路径把音量置 0 后再 `play()`，被拦时 `.then()` 里才恢复音量，
   所以**音量永久停在 0**：即使之后播放成功也是静音。

**修复**

1. 四个 `playXxxMusic` 统一走 `playCategoryIfNeeded(category)`：
   除"类别不同"外，还要求**确实在播**（`!paused && isPlaying && !muted`）；
   类别相同但没在响时，恢复当前曲目而不是直接 return。
2. `startNewBGM()` 失败分支：还原音量到 `bgmVolume` 并标记 `isPlaying = false`。
3. 新增 `scheduleMusicRetry()`：播放失败后挂一次性监听，
   在**下一次用户交互**（`click`/`keydown`/`touchstart`）时恢复 AudioContext 并重试。
   监听用**捕获阶段**，避免按钮里的 `stopPropagation` 把解锁事件吃掉。
4. `connectBGMToWebAudio()`：`createMediaElementSource` 之后 BGM 只经 AudioContext 出声，
   上下文若仍 `suspended` 就会"在播但没声"，因此 resume 失败时也挂重试。

### 9.35 本阶段验收

`.dev/verify_bgm_stuck.mjs` —— **7/7**：

| 断言 | 实测 |
| --- | --- |
| 首次进入主界面会起播 Hub | `cat=Hub`，曲目已设 |
| 被拦后音量不会留在 0 | `volume=0.5` |
| 被拦后标记为未播放 | `isPlaying=false` |
| 类别已是 Hub 但未在播时仍会重起播 | `play` 调用 1 次 |
| 恢复成功后标记为播放中 | `isPlaying=true` |
| 正常播放中不重头再播（不打断） | `play` 调用 0 次 |
| common / Witch / Battle 都能切 | 三个都 ✓ |

真实浏览器（CDP，模拟点击）验证：拦截后 `vol` 保持 `0.5`、`retryArmed=true`，
再次点击时 `playAttempts` 1→2→3 持续重试 —— 已不再是"永久静音"。

定向回归：联机 BGM 5/5、远程选择 12/12、汉娜等 11/11、移动 8/8、双端 19/19、
方案 A 9/9、新角色 12/12、奈叶香+梅露露 9/9、模式回退 12/12、JS 7/7。

### 9.36 交锋：客机不显示 + 指示灯脉冲撑出滚动条

**① 客机不显示**

原来交锋只靠 `confrontation_start` 一条事件驱动。harness 里这条路是通的
（消息已发、客机 `active=true`、modal 取消隐藏），但只要那条消息在任何环节丢掉，
客机就一直空白，且**没有任何补救**。

改为**事件 + 状态双保险**：

- 房主在 `startConfrontation()` 里把交锋写进同步状态：
  `gameState.confrontation = { active, participantIds, lightOn, lightOnAt }`；
  `turnLightOn()` 同步 `lightOn/lightOnAt`；`endConfrontation()` 置 `null`。
- 客机在 `syncGameState()` 末尾调用 `reconcileRemoteConfrontation()` 幂等校正：
  状态说在交锋但本机没显示 → 补显示；状态说灯亮了但本机没亮 → 补亮；
  状态已清空但仍显示 → 收起。

这样即使事件全丢，下一次状态同步（含 9.22 的 5 秒周期同步）也能自愈。

**② 指示灯放大会出现滚动条**

实测（CDP，764×485）确认：`.modal-overlay` 是 `overflow-y: auto` 的可滚动容器，
而 `#confrontation-light` 用 `transform: scale(1.15)` 做 `lightPulse` 脉冲 ——
**变换后的盒子会撑大滚动区域**，灯一亮冒滚动条、灯灭又消失。

修复（`ui-components.css` 末尾第 16 节）：

| 处理 | 原因 |
| --- | --- |
| `#confrontation-modal { overflow: hidden }` | 全屏遮罩，视口边界裁切即可 |
| `.modal-overlay { overflow: hidden; align-items: center; padding: 0 }` | 交锋内容一屏必然放得下，不需要滚动 |
| `.confrontation-content { overflow: visible; gap/padding 用 clamp() }` | 该元素原本被别的规则设为 `overflow: auto` |
| `#confrontation-light { font-size: clamp(3rem, 12vh, 8rem); line-height: 1 }` | 矮窗口下灯自动缩小，不会溢出 |
| hint / 按钮同样 `clamp()` | 矮窗口不裁切 |

### 9.37 顺带修掉：6 个角色头像 404

`renderMobilePlayersBar()` 用**角色 id 拼文件名**：

```js
src="icon/Profile_${id[0].toUpperCase() + id.slice(1)}.webp"
```

但实际文件名并不都等于 id：`emma→Ema`、`leiya→Leia`、`milia→Miria`、
`nayeka→Nanoka`、`marg→Margo`、`arisa→Alisa` —— **13 个角色里 6 个头像 404**。
改为直接用 `player.character.icon`，真实浏览器验证 **13/13 全部 200**。

### 9.38 本阶段验收

`.dev/verify_conf_state.mjs` —— **6/6**：

| 断言 | 实测 |
| --- | --- |
| 丢了开始事件，状态同步仍能显示交锋 | `active=true`，人数 2 |
| 客机 modal 确实取消隐藏 | `hidden=false` |
| 丢了灯亮事件，状态同步仍能补亮 | `lightOn=true` |
| 状态清空后客机收起 | `active true→false`，`hidden=true` |
| 房主侧不受兜底影响（幂等） | 房主 `active=false` |
| 真实开局会写入同步状态 | `ids=[1,2]` |

`.dev/verify_conf_layout.mjs` —— **5/5**（真实浏览器，5 个尺寸，
采样 6 次覆盖脉冲峰值）：

| 尺寸 | 页面滚动 | 遮罩滚动 | 内容滚动 | 灯在屏内 | 灯尺寸 |
| --- | --- | --- | --- | --- | --- |
| 1920x1080 | 无 | 无 | 无 | ✓ | 128×128 |
| 1366x768 | 无 | 无 | 无 | ✓ | 92×92 |
| 1280x720 | 无 | 无 | 无 | ✓ | 86×86 |
| 1024x640 | 无 | 无 | 无 | ✓ | 78×78 |
| 800x600 | 无 | 无 | 无 | ✓ | 74×74 |

定向回归：远程选择 12/12、汉娜等 11/11、移动 8/8、双端 19/19、方案 A 9/9、
BGM 7/7、联机 BGM 5/5、新角色 12/12、奈叶香+梅露露 9/9、模式回退 12/12、JS 7/7。

### 9.39 等待他人发动技能：锁操作 + 蓝色"考虑中"高亮

**需求**：某人在考虑发动技能时，其他人既要知道**在等谁**，也不能继续乱点。

**关键设计：接在统一通道上，而不是逐个流程改**

所有"等某个玩家做决定"的流程（7 个被动技能、梅露露治愈、分叉方向、
汉娜步数/方向、蕾雅分叉、里世界互换/强制删除、雪莉两处、地下室/娱乐室）
**最终都走 `sendPassiveRequest()`**。所以在这一处收口：

```js
function sendPassiveRequest(skillType, targetPlayerId, data, onResponse, timeoutMs) {
    const requestId = generateRequestId();
    beginPlayerWaiting(targetPlayerId, skillType, requestId);   // 广播等待态
    const settled = (activate, payload) => {                     // 响应/超时都解除
        endPlayerWaiting(requestId);
        onResponse(activate, payload);
    };
    ...
}
```

这样一处改动覆盖全部流程，将来新增的决策也自动具备。

**状态**：`gameState.waitingFor = { playerId, skillType, requestId, since }`
随状态同步下发；`requestId` 用于并发请求时只清自己那一次。

**渲染**（`renderWaitingState()`，幂等，`renderGame()` 与 `syncGameState()` 都会调用）：

| 表现 | 实现 |
| --- | --- |
| 被等待者的角色卡蓝色呼吸高亮 | `.opponent-item.skill-thinking` + `skillThinkingPulse` 动画 |
| 卡上标「考虑中」 | `.op-tag.thinking`，蓝色底 + 闪烁 |
| 其他人禁止操作 | `#game-screen.waiting-other` → 手牌/控制区/棋盘 `pointer-events: none` |
| 视觉上"按不动" | 手牌与控制区 `grayscale(.55) brightness(.82)` |
| 明确在等谁 | `updatePrompt('XXX 正在考虑是否发动技能…')` + 蓝色提示文字 |
| 被等待者自己不受限 | `isWaitingForOther()` 排除 `playerId === localPlayerId` |

额外在 `playCard()` / `castMagic()` / `handleCellTap()` 加了守卫，
即使绕过 CSS（键盘、脚本）也会给出「请稍候」提示。

### 9.40 本阶段验收

`.dev/verify_waiting_ui.mjs` —— **10/10**（状态机层面）：

| 断言 | 实测 |
| --- | --- |
| 房主记录等待态 | `playerId=1 skill=marg_mimic` |
| 等待态随状态同步到客机 | `playerId=1` |
| 客机（P2）判定在等别人 → 应锁 | `isWaitingForOther=true` |
| 房主（被等待者 P1）不受限 | `isWaitingForOther=false` |
| 等待期间请求未完成 | `resolved=false` |
| 被等待的玩家自己不算"等别人" | `waiting=2 local=2` |
| 客机渲染等待态不抛错 | 无异常 |
| 响应后清除等待态 | `waitingFor=null` |
| 响应回到房主 | `resolved=true` |

`.dev/verify_waiting_visual.mjs` —— **18/18**（真实浏览器 3 尺寸 × 6 项）：

| 断言 | 实测（1280x720） |
| --- | --- |
| 只有被等待者卡被蓝色高亮 | 高亮 1 个、玩家 P1、边框 `rgb(74,163,255)`、动画 `skillThinkingPulse` |
| 「考虑中」标签 | 文本「考虑中」、底色 `rgb(43,108,176)` |
| 操作被锁 | `screen.waiting-other=true`、controls/hand 均 `pointer-events: none` |
| 提示说明在等谁 | 「P1 正在考虑是否发动技能…」 |
| 不产生额外滚动 | `docHasScroll=false` |
| 解除后全部撤销 | 高亮 0、`pointer-events: auto`、标签无残留 |

定向回归：交锋布局 5/5、交锋兜底 6/6、远程选择 12/12、汉娜等 11/11、
移动 8/8、双端 19/19、方案 A 9/9、BGM 7/7、新角色 12/12、
奈叶香+梅露露 9/9、模式回退 12/12、JS 7/7。

### 9.41 回合刷新时客机看不到动画（而且状态也拿不到）

排查时发现的问题比"动画"更严重：**`endRound()` 从头到尾没有一次 `broadcastGameState()`**。
也就是说回合切换（格子重 roll、回合号 +1、发牌、魔女化结算）在房主侧跑完，
客机**既看不到转场动画，也收不到新状态**，只能等下一次操作碰巧广播。

**修复三件事**

1. **客机复现转场动画**：`showRoundTransition(callback, options)` 增加可选参数：
   - `options.nextRound`：转场文案的回合号（客机此时状态可能还没同步，不能读
     `gameState.currentRound`）
   - `options.skipExecutionCheck`：客机跳过处刑检查，改由事件驱动，避免弹两次
   - `callback` 变可选（客机没有后续流程要跑）

2. **新事件 `round_transition`**：房主在转场起点广播
   `{ nextRound, witchChanges: [{playerId, amount, reason}], newlyWitchifiedIds }`，
   客机 `playRemoteRoundTransition()` 用**同一套延迟节奏**依次播：
   魔女化变化（`idx*300`）→ 新魔女化提示（`+idx*500`）→ 转场遮罩。
   同时触发 `updateGameMusic()`，让客机的音乐也跟着场上状态变。

3. **回合切换完成后广播状态**：转场回调里 `renderGame()` 之后补 `broadcastGameState()`，
   客机这才真正拿到"格子已刷新、回合已推进"的状态。

另外把处刑警告也接上：房主算出的 `playersToExecute` 通过
`execution_warning { playerIds }` 广播，客机 `playRemoteExecutionWarning()`
按 id 映射回本地玩家对象再显示 —— 客机不自己算，避免各端条件不一致。

### 9.42 本阶段验收

`.dev/verify_round_transition.mjs` —— **7/7**（状态机）：

| 断言 | 实测 |
| --- | --- |
| 回合刷新广播 round_transition | `nextRound=2` |
| 事件带魔女化变化与回合号 | 变化 1 条、`newlyWitchifiedIds` 存在 |
| 回合切换后广播新状态 | 广播状态 `currentRound=2` |
| 房主侧回合推进 | `currentRound=2` |
| 客机复现转场遮罩 | 遮罩数 1 |
| 客机按事件显示处刑警告 | 警告数 1 |
| 客机不自己弹处刑警告（等事件） | 警告数 0 |

`.dev/verify_round_visual.mjs` —— **8/8**（真实浏览器 2 尺寸 × 4 项）：

| 断言 | 实测（1920x1080） |
| --- | --- |
| 客机出现转场遮罩 | 存在、`show` 类、尺寸 1920×1080 覆盖全屏 |
| 转场文案 | 「回合结束 / 格子刷新中...」 |
| 不引起滚动 | `docScroll=false` |
| 动画结束自动移除 | 无残留 |

定向回归：等待态视觉 18/18、等待态状态机 10/10、交锋布局 5/5、交锋兜底 6/6、
远程选择 12/12、汉娜等 11/11、移动 8/8、双端 19/19、方案 A 9/9、BGM 7/7、
新角色 12/12、奈叶香+梅露露 9/9、模式回退 12/12、JS 7/7。

### 9.43 交锋：客机只剩一个按钮 + “你”标错人

**① 客机交锋界面几乎空白**

用 CDP 实测客机侧的交锋界面，四个元素全是 `visible:false`：

| 元素 | 实测结果 | 原因 |
| --- | --- | --- |
| `.vs-display`（参与者） | `display:none`，0×0 | CSS `#confrontation-modal .vs-display { display: none }` 把它整块隐藏了 |
| `#conf-player1/2` | 0×0 | 上一条的连带 |
| `#confrontation-light` | 可见但 `rgb(51,51,51)` | 灯灭态是深灰，深色遮罩上几乎看不出 |
| `#reaction-btn` | `display:none` | 设计上隐藏按钮、改为点屏幕任意处 |
| **音乐** | `audioState.currentCategory = null` | 客机完全没切交锋音乐 / 没播交锋音效 |

也就是说客机上**既没有参与者、也没有可见的灯、更没有音乐**，只剩一行提示。

**修复**

1. **客机切音乐与音效**：`showRemoteConfrontation()` 里补
   `playSFX(SFX.battleBurst)` + `playBattleMusic()`；
   `handleRemoteConfrontationEnd()` 里用 `updateGameMusic()` 还原。
2. **客机也播前奏动画**：包一层 `playConfrontationIntro(participants, reveal)`，
   与房主同一段 3.3 秒入场动画，动画结束再显示交锋界面。
3. **CSS 恢复参与者**（`ui-components.css` 第 18 节）：解除
   `.vs-display{display:none}`，补 `.conf-avatar img` / `.conf-avatar-small img`
   的自适应尺寸（原来按 emoji 设计的容器里塞 `<img>` 会撑开）。
4. **灯灭态改为可见**：`#7a2b33` + 微弱红光，明确"灯还没亮"；灯亮态加强外发光。

**顺手修掉的时序坑**：前奏动画要 3.3 秒，而灯亮事件可能先到；
`showConfrontationModal()` 会把灯重置成 `light-off`，导致灯"永远不亮"。
现在 `reveal()` 之后按 `confrontationState.lightOn` 补回灯亮状态。

另外给 `playConfrontationIntro` 加了兜底：`CHARACTER_IMAGES[charId] || {}`、
`char.barColors?.[0] || '#9b59b6'`、`char.name || '玩家'` ——
客机参与者数据不完整时不会整段崩掉。

**② 客机把房主的角色卡标成“你”**

```js
const humanIndex = gameState.players.findIndex(p => !p.isAI);   // ← 老问题
```

联机下**所有玩家的 `isAI` 都是 false**，所以永远取到玩家 0（房主），
客机就把房主的卡标成"你"。改为按 `localPlayerId` 定位自己，
取不到再退回 `!isAI` —— 与 9.20 修的 `renderBoard` / `showCellInfo` 同一类错误。

### 9.44 本阶段验收

`.dev/verify_guest_conf.mjs` —— **24/24**（真实浏览器 3 尺寸 × 8 项）：

| 断言 | 实测（1280x720） |
| --- | --- |
| 客机“你”标签在本地玩家身上 | 仅 `pid=2` 有「你」，P1/P3 无 |
| 交锋界面显示且覆盖全屏 | `hidden=false`，遮罩 1280×720 |
| 两位参与者头像与名字可见 | vsDisplay 284×117、p1/p2 各 90×117、头像 **2/2 已加载** |
| 灯与提示可见 | 灯 86×86、颜色 `rgb(122,43,51)`、提示 63×30 |
| 客机切到交锋音乐 | 类别 `Battle`，曲目已选 |
| 可直接点击屏幕 | `cursor=pointer` |
| 不引起滚动 | `docScroll=false` |
| 灯亮后变红并有脉冲 | `light-on`、`rgb(231,76,60)`、`animation=lightPulse` |

定向回归：交锋布局 5/5、交锋兜底 6/6、回合刷新 8/8 + 7/7、等待态 18/18 + 10/10、
远程选择 12/12、汉娜等 11/11、移动 8/8、双端 19/19、方案 A 9/9、BGM 7/7、
新角色 12/12、奈叶香+梅露露 9/9、JS 7/7。

### 9.45 切屏后方向箭头消失 + 别人回合不高亮

**① 切屏后方向选择按钮消失**

根因：`renderBoard()` 结尾是 `container.innerHTML = html` —— **整体重建棋盘**，
而方向箭头是运行时 `appendChild` 到格子上的，重建后自然全没了。
`showScreen()` 回游戏界面会触发 `renderGame()` → `renderBoard()`，
于是"切一下屏，箭头就没了"，而 `moveState` 还在等方向，玩家直接卡死。

修复：方向选择改为**状态驱动**，箭头可跨重绘恢复。

- 新增本机私有状态 `pendingDirectionChoice = { kind, currentPos, options, requestId, extraClass }`
  （不放 `gameState`，避免被房主状态同步覆盖成 `null`）
- `kind` 区分三种来源：`fork`（普通分叉）、`hanna`（浮空方向）、`remote`（房主请求远程选择）
- `renderBoard()` 末尾调用 `renderDirectionArrowsFromState()`，有待选方向就把箭头补回来
- `selectDirection` / `selectHannaDirection` / 远程箭头点击 / `nextTurn` / `resetAllGameState`
  都会清空该状态，不会残留

**② 别人回合时角色卡没有蓝色"正在思考"**

原来蓝色高亮只绑定 `gameState.waitingFor`（技能决策请求），
**正常轮次推进时完全不亮**。改为统一的"谁在思考"判定：

```js
function getThinkingPlayer() {
    const w = getWaitingFor();
    if (w) return { id: w.playerId, reason: 'skill', text: '考虑中' };   // 技能决策
    const turnPlayer = gameState.players[gameState.currentPlayerIndex];
    const me = getMyPlayer();
    if (!turnPlayer || !me || turnPlayer.id === me.id) return null;      // 自己回合不亮
    return { id: turnPlayer.id, reason: 'turn', text: '思考中' };         // 轮到别人
}
```

关键点：
- **单人局同样生效** —— `getMyPlayer()` 在单人是"人类玩家"，所以 AI 回合会高亮 AI 的卡
- **自己的回合不亮自己**，避免自己卡上还闪蓝光
- 标签文字区分原因：技能决策是「考虑中」，轮次是「思考中」
- 操作锁（`waiting-other`）仍然只跟随技能决策，不会因为"轮到别人"就锁住自己

### 9.46 本阶段验收

`.dev/verify_dir_thinking.mjs` —— **16/16**（真实浏览器 2 尺寸 × 8 项）：

| 断言 | 实测 |
| --- | --- |
| 单人：AI 回合高亮该 AI 的卡 | 高亮 true、标签「思考中」、边框 `rgb(74,163,255)` |
| 单人：自己的卡不高亮 | 高亮 false、无标签 |
| 多人：客机看到房主回合时高亮房主 | P1 高亮 true、标签「思考中」 |
| 多人：自己的卡不高亮 | P2 高亮 false |
| 自己回合时没有任何卡被标思考 | 被标记 0 个 |
| **切屏往返后方向箭头仍在** | 位置 1、选项 `[2,20]`、切换前 2 → 切换后 **2** |
| 切屏往返后高亮格仍在 | 切换前 2 → 切换后 2 |
| 选定方向后箭头与状态清空 | 箭头 0、待选 false |

另：等待态视觉用例同步更新语义 —— 技能等待解除后，高亮转交给"轮到的那位"
（标签由「考虑中」变「思考中」），18/18 通过。

最终定向回归（18 套）：箭头+思考 16/16、客机交锋 24/24、交锋布局 5/5、交锋兜底 6/6、
回合刷新 8/8 + 7/7、等待态 18/18 + 10/10、远程选择 12/12 + 11/11、移动 8/8、
双端 19/19、方案 A 9/9、BGM 7/7 + 5/5、新角色 12/12、奈叶香+梅露露 9/9、
模式回退 12/12、JS 7/7。

### 9.47 全局扫描：!isAI 误判本机玩家

`gameState.players.find(p => !p.isAI)` 在单人局是对的，但**联机下所有玩家的
`isAI` 都是 false**，于是永远返回玩家 0（房主）。这个坑已经咬了四次：
`renderBoard`、`showCellInfo`、`getOpponentEntries`、`renderPlayerSlots`。

**扫描结果**（game.js + network.js 共 20 处 `isAI` 相关判定）：

| 分类 | 数量 | 处理 |
| --- | --- | --- |
| 真正误判本机玩家 | 1 | `renderPlayerSlots` 已改按 `getLocalPlayer()` 定位 |
| 已有在线分支的合法兜底 | 11 | 保持（`if (online) {...} else { find(!isAI) }` / 三元兜底） |
| "是不是人类"语义（与"本机"无关） | 5 | 保持（`isRemoteHumanPlayer`、`humanInvolved`、AI 调度、音效） |
| 规范化助手内部 | 3 | 保持（`isLocalPlayer` / `getLocalPlayer` / `isMyTurn`，内部先判 `!isOnlineMode()`） |

**防回潮静态检查**：`.dev/check_local_player.mjs`

判定规则比行级白名单更稳（无需维护）：某行出现
`.find(p => !p.isAI)` / `.findIndex(p => !p.isAI)` 时，
**只有当它所在函数体里同时出现 `getLocalPlayer` / `localPlayerId` / `isOnlineMode` 才放行**
—— 否则说明该函数只考虑了单人局，联机必然取到玩家 0，直接报错。

另外强制校验 8 个关键渲染函数（`renderBoard`、`showCellInfo`、`getOpponentEntries`、
`renderPlayerSlots`、`renderUserConsole`、`renderHandCards`、`updateMagicButton`、
`refreshShadowButtonLabel`）必须处理在线分支。

**已实测它真的会拦住回潮**：故意注入
`function __badLocalPlayerProbe() { return gameState.players.find(p => !p.isAI); }`
→ 检查报错并返回退出码 1；移除后恢复通过。

### 9.48 技能动画 / 选卡片动画客机不显示

这类视觉反馈全部只在房主本地执行，客机完全没有反应：技能发动动画
（`showMagicCastEffect`）、技能提示（`showMagicAlert`）、魔女化飘字
（`showWitchPopup`）、魔女化警告（`showWitchifiedAlert`）。

**做法：特效广播层**

```js
let replayingRemoteFx = false;

function broadcastFx(kind, payload) {
    if (replayingRemoteFx) return;                       // 重放期间不再广播
    if (networkState.mode !== 'online' || !networkState.isHost) return;
    sendMessage('fx_event', Object.assign({ kind }, payload));
}

function handleRemoteFx(message) { /* 客机按 kind 调同一个函数重放 */ }
```

然后在四个特效函数里各加一行 `broadcastFx(...)`，客机收到 `fx_event`
后用**同一个函数**重放 —— 所以动画、音效、语音、样式全部天然一致，
不需要为客机单独写一套渲染。

三重守卫防止来回弹：`replayingRemoteFx` 抑制重放期广播、
`isHost` 抑制客机广播、单机模式直接不广播。

选卡片动画本身不需要改：客机的 `showRemoteResourceSelect()` 内部就是调用
`showResourceSelectModal()`，与房主同一套入场动画。

### 9.49 本阶段验收

`.dev/check_local_player.mjs` —— **通过**（注入违规时实测返回退出码 1）。

`.dev/verify_fx_broadcast.mjs` —— **11/11**：

| 断言 | 实测 |
| --- | --- |
| 技能动画广播 fx_event | `kind=castEffect playerId=1 name=幻视` |
| 客机重放动画 DOM | `magic-cast-effect` 1 个 |
| 动画内容与本机一致 | 文本含技能名与说明 |
| 技能提示广播 + 重放 | `技能发动 / 艾玛的魔法生效了` |
| 魔女化飘字广播 | `playerId=2 amount=5` |
| 魔女化警告广播 | `playerId=1` |
| 客机重放不二次广播 | 客机发出 fx_event = 0 |
| 单机模式不广播 | 广播数 0 |

`.dev/verify_fx_visual.mjs` —— **15/15**（真实浏览器 3 尺寸）：

| 断言 | 实测（1280×720） |
| --- | --- |
| 客机出现技能动画 | `show=true`，284×337，位于 498,191 |
| 内容可见完整 | 284×337，技能名「幻视」 |
| 在视口内 | `inViewport=true` |
| 不撑出滚动条 | `docScroll=false` |
| 播完自动移除 | 无残留 |

最终定向回归（21 套 + 静态检查）：特效广播 11/11、特效视觉 15/15、
箭头+思考 16/16、客机交锋 24/24、交锋布局 5/5、交锋兜底 6/6、
回合刷新 8/8 + 7/7、等待态 18/18 + 10/10、远程选择 12/12 + 11/11、
移动 8/8、双端 19/19、方案 A 9/9、BGM 7/7 + 5/5、新角色 12/12、
奈叶香+梅露露 9/9、模式回退 12/12、联机选人 9/9、JS 7/7。

### 9.50 四个客机侧问题

**① 交锋动画播两次、没有收尾动画、抢夺看不到线索**

- *播两次*：`confrontation_start` 事件和 `reconcileRemoteConfrontation()`（状态同步兜底）
  都会调 `showRemoteConfrontation()`，于是 3.3 秒入场动画跑两遍。
  修复：进入时判重 —— `confrontationState.active` 且（`introPlaying` 或参与者集合相同）就直接返回。
- *没有收尾动画*：房主 `endConfrontation()` 里播 `playConfrontationOutro()`（胜利立绘 + finish 标题），
  但只发了一条空的 `confrontation_end`（客机只能收起界面）。
  修复：新增 `confrontation_outro { winnerId, participantIds }`，客机
  `handleRemoteConfrontationOutro()` 用**同一个** `playConfrontationOutro()` 重放。
  同时给 `playConfrontationOutro` 加了 `CHARACTER_IMAGES[..] || {}` 兜底
  （客机参与者数据可能不含 `barColors`，原本会 `TypeError`）。
- *抢夺看不到线索*：客机 `showRemoteStealSelect()` 的卡片缺
  `<span class="card-label">${getClueLabel(cardId)}</span>`，所以只显示卡名、不显示 🔍/📜/💗。
  已补齐，与房主界面一致。

**② 已经选过的方向会再出现一次**

我自己引入的回归：`renderDirectionArrowsFromState()` 会在每次棋盘重绘后补画箭头，
但 `showRemoteDirectionChoice()` 里原来的箭头 `onclick` **只清了 DOM 箭头和 requestId，
没有清 `pendingDirectionChoice`** —— 于是移动事件/状态同步触发重绘时，箭头被原样画回来。

三重修复：
1. 该 `onclick` 补 `clearPendingDirection()`
2. `renderDirectionArrowsFromState()` 加保险：`kind === 'remote'` 且 `remoteForkRequestId` 已空 → 清状态不画
3. `showDirectionArrows()` 对"同一位置 + 同一选项"的重复请求不再重设

**③ 魔女化后客机没紫色蒙布、不改音乐**

`updateGameMusic()` 内部同时负责两件事：给 `#game-screen` 加 `witchified-atmosphere`
（紫色蒙布）和切 `Witch` 音乐。房主在魔女化/回合结束时会调，**客机从不调用**。
修复：`syncGameState()` 末尾调用 `updateGameMusic()`（交锋进行中跳过，避免覆盖交锋音乐）。

**④ 游戏结束后客机不进结算**

`playerWins()` / `playerLoses()` / `checkGameEnd()` **一次 `broadcastGameState()` 都没有**，
客机连"游戏结束"这个状态都收不到；而且就算收到也没有客户端逻辑。
修复：
- `playerWins` / `playerLoses` 结束时补 `broadcastGameState()`
- `showRankPopup()` 通过特效层广播（`rankPopup`），客机同步弹名次飘窗
- `syncGameState()` 发现 `status === 'ended'` 且未处理过 → 延迟 1.5s 走 `showFinalResults()`，
  用 `remoteFinalResultsShown` 保证只进一次

**顺带修掉的滚动条**：结算榜高于视口时会把整个文档撑出滚动条
（1280×720 实测 `scrollHeight > clientHeight`）。给它 `overflow-y: auto; max-height: 100vh`，
改为界面内部滚动（`ui-components.css` 第 19 节）。

### 9.51 本阶段验收

`.dev/verify_four_issues.mjs` —— **10/10**（状态机）：

| 断言 | 实测 |
| --- | --- |
| 客机重复触发只有一份交锋状态 | `active=true introPlaying=true` |
| 交锋收尾动画有广播事件 | `winnerId=1`，参与者 2 |
| 客机收尾不报错并清理状态 | `active=false` |
| 抢夺界面带线索标签 | 命中 2/2（`🔍🔍`） |
| 远程方向点选后待选状态清空 | 点选后 `null`、重绘后 `null` |
| 同一处分叉重复请求不重设 | `[5,7]` / `[5,7]` |
| 客机应用魔女化氛围 | `witchified-atmosphere=true` |
| 客机切魔女化音乐 | 类别 `Witch` |
| 魔女化玩家离场后氛围撤销 | `witchified-atmosphere=false` |
| 客机进入结算流程 | `remoteFinalResultsShown=true` |

`.dev/verify_four_visual.mjs` —— **8/8**（真实浏览器 1280×720）：

| 断言 | 实测 |
| --- | --- |
| 客机播放交锋收尾动画 | 容器可见、标题有尺寸、胜利者文字显示 |
| 抢夺界面显示线索标签 | 卡片 2、标签 `🔍🔍` 均可见 |
| 魔女化氛围类名 / 音乐 | `hasClass=true`、`Witch`、无滚动 |
| 客机进入结算界面 | `result-screen` 可见、宽 1280、**文档不滚动** |

最终回归（23 套 + 静态检查）：四问题 10/10 + 8/8、特效 11/11 + 15/15、
箭头+思考 16/16、客机交锋 24/24、交锋布局 5/5、交锋兜底 6/6、回合刷新 8/8 + 7/7、
等待态 18/18 + 10/10、远程选择 12/12 + 11/11、移动 8/8、双端 19/19、方案 A 9/9、
BGM 7/7 + 5/5、新角色 12/12、奈叶香+梅露露 9/9、模式回退 12/12、联机选人 9/9、JS 7/7。

### 9.52 房主关闭被动会连带关掉客机的被动

**原因**：`togglePassive()` 同时改了两处

```js
player.passiveEnabled = ...;                      // 每人一份（正确）
gameState.passiveMagicLock = !player.passiveEnabled;   // ← 全局，会随状态同步下发
```

而 8 处被动判定读的都是这个**全局锁**：
`checkAnanMagic` / `checkLeiyaMagicAtFork` / `checkHiroMagic` / `checkCocoMagic` /
`resolveConfrontation`（雪莉）/ `checkMiliaMagicAfterConfrontation` / `checkMargPassive`。
于是房主一关，`gameState.passiveMagicLock = true` 同步给客机，客机的被动全被关掉。

**修复**：被动开关改为**按玩家生效**

```js
function isPassiveEnabledFor(player) {
    if (!player) return !gameState.passiveMagicLock;
    if (player.passiveEnabled === false) return false;
    if (networkState.mode === 'online') return true;   // 联机：只认本人的开关
    return !gameState.passiveMagicLock;                 // 单人：沿用全局总开关
}
```

- `togglePassive()`：联机下**不再写全局锁**，只改本人设置；
  房主改 → `broadcastGameState()`；客机改 → 发 `passive_toggle { playerId, enabled }`
  给房主（房主是权威，记下来再广播）
- 7 处持有者查找全部加上 `isPassiveEnabledFor(p)`：「**是被动持有者自己的开关**」说话，
  雪莉那处把 `!gameState.passiveMagicLock` 换成 `isPassiveEnabledFor(sherryPlayer)`
- 设置面板的 `togglePassiveLock()` 在联机下也只作用于本机玩家，不再动全局
- 单人模式行为完全不变（全局总开关照旧生效）

### 9.53 本阶段验收

`.dev/verify_passive_toggle.mjs` —— **12/12**：

| 断言 | 实测 |
| --- | --- |
| 房主关被动后本人开关为关 | `passiveEnabled=false` |
| 房主关被动**不再写**全局锁 | `passiveMagicLock=false` |
| 客机全局锁没被带跑 | `passiveMagicLock=false` |
| **客机的被动仍然开启** | `isPassiveEnabledFor(P2)=true` |
| 房主自己的被动确实关闭 | `isPassiveEnabledFor(P1)=false` |
| 联机下全局锁不影响本人判定 | `true` |
| 本人关闭后判定为关闭 | `false` |
| 客机关被动会上报房主 | `playerId=2 enabled=false` |
| 房主记录下客机的设置 | 房主侧 `P2.passiveEnabled=false` |
| 房主自己的被动不受影响 | `P1.passiveEnabled=true` |
| 单人全局锁仍生效 | `false` → 解除后 `true` |

`.dev/verify_passive_visual.mjs` —— **4/4**（真实浏览器 1280×720）：

| 断言 | 实测 |
| --- | --- |
| 客机按钮默认「被动：开」 | 按钮文本「被动：开」、active、宽 135px 可见 |
| 客机自身被动判定开启 | `enabledForMe=true` |
| 房主关后客机按钮不变 | 仍是「被动：开」 |
| 房主关后客机被动仍生效 | 客机 `true` / 房主 `false` |

最终回归（25 套 + 静态检查）：被动开关 12/12 + 4/4、四问题 10/10 + 8/8、
特效 11/11 + 15/15、箭头+思考 16/16、客机交锋 24/24、交锋布局 5/5、交锋兜底 6/6、
回合刷新 8/8 + 7/7、等待态 18/18 + 10/10、远程选择 12/12 + 11/11、移动 8/8、
双端 19/19、方案 A 9/9、BGM 7/7 + 5/5、新角色 12/12、奈叶香+梅露露 9/9、
模式回退 12/12、联机选人 9/9、JS 7/7。

### 9.54 结算界面去掉「再来一局」

按需求删除结算页的「再来一局」按钮，只留「返回大厅」。

- `index.html`：移除 `result-btn-secondary` 那个按钮块
- `game.js`：连带删掉 `handlePlayAgain()`（删完确认全文无引用）
- 测试侧同步清理：`.dev/b_dual_client.mjs` 的导出列表里还有 `handlePlayAgain`、
  以及一条 `handlePlayAgain 不抛错且沿用上一局人数` 的用例 —— 一起删掉，
  否则加载 harness 时会 `ReferenceError`，导致 14 个依赖它的套件**静默无输出**

**顺带修的布局问题**：矮窗口（1024×640 实测）下按钮落在视口外
（`y=584`，高 75，而视口只有 640），需要滚动才能点到。
给 `#result-screen .result-actions` 加 `position: sticky; bottom: 0` +
底部渐变兜底（`ui-components.css` 第 20 节），任何高度都能直接点到。

### 9.55 本阶段验收

`.dev/verify_result_button.mjs` —— **12/12**（真实浏览器 3 尺寸 × 4 项）：

| 断言 | 实测（1024×640） |
| --- | --- |
| 只剩一个按钮 | 按钮数 1 |
| 文案是「返回大厅」 | `⚖返回大厅⚖` |
| 页面不再出现「再来一局」 | 文本残留 false、`handlePlayAgain` 残留 false |
| 按钮可见且在视口内 | 345×75，位置 332,547，`inViewport=true` |

`b_dual_client.mjs` 恢复 **18/18**（删掉过时用例后）。

最终回归（27 套 + 静态检查）全部有输出且全绿：
结算按钮 12/12、被动开关 12/12 + 4/4、四问题 10/10 + 8/8、特效 11/11 + 15/15、
箭头+思考 16/16、客机交锋 24/24、交锋布局 5/5、交锋兜底 6/6、回合刷新 8/8 + 7/7、
等待态 18/18 + 10/10、远程选择 12/12 + 11/11、移动 8/8、双端 18/18、方案 A 9/9、
BGM 7/7 + 5/5、新角色 12/12、奈叶香+梅露露 9/9、模式回退 12/12、联机选人 9/9、JS 7/7。

### 9.56 gameState 字段审计：共享事实 vs 个人视图

联机时**整个 `gameState` 都会下发给所有人**，所以放进去的任何"个人设置/个人界面状态"
都会串给别人。已经踩过两次：`showingShadowWorld`（奈叶香里世界开关）、
`passiveMagicLock`（房主关被动把客机也关了）。

**判定标准**

- **共享事实**：所有客户端必须看到同一个值（回合、棋盘、玩家、进行中的决策…）
- **个人视图**：只对某台机器有意义（我选了哪张牌、我的界面开关、本机的回调…）

**审计结果：49 个字段 = 33 共享 + 16 个人视图**

共享事实（33）：`status` `gameMode` `playerCount` `currentSelectingPlayer` `selectedCharacters`
`players` `board` `currentRound` `currentSubRound` `totalSubRounds` `currentPlayerIndex`
`pendingEvents` `magicStates` `passiveMagicLock` `confrontation` `waitingFor`
`hiroExtraTurns` `leiyaEnhancedActive` `leiyaEnhancedPlayerId` `leiyaEnhancedStartRound`
`leiyaEnhancedStartSubRound` `leiyaEnhancedRemainingSubRounds` `leiyaPresetDirections`
`margSilenceActive` `margSilencePlayerId` `meruruEnhancedActive` `meruruEnhancedPlayerId`
`nayekaEnhancedActive` `nayekaEnhancedPlayerId` `noahEnhancedActive` `noahPlayerId`
`nayekaVisionActive` `nayekaVisionPlayerId`

个人视图（16，全部剥离）：

| 分类 | 字段 |
| --- | --- |
| 本机界面开关 | `showingShadowWorld` |
| 本机防连点锁 | `charSelectLock` `cardSubmitting` `starting` |
| 未确认的临时选择 | `tempSelectedChar` `selectedCardIndex` |
| 决策过程对象（持 player/callback 引用） | `meruruHealState` `nayekaBasementState` `nayekaState` `margPassiveState` `shadowSwapState` `shadowDeleteState` `sherryTargetState` `sherryConfrontationState` `hannaStepState` |
| 函数 | `leiyaEnhancedForkCallback` |

**实现**：`network.js` 新增 `PERSONAL_VIEW_FIELDS` 显式清单（每项带理由注释），
`getSerializableGameState()` 统一按清单剥离，取代原来散落的两个 `delete`。

**已知遗留（不剥离，属于规则状态）**：`nayekaVisionActive/PlayerId` 等持续效果
必须同步（奈叶香若在客机，本机需要这个旗标），但会顺带告诉别人"幻视生效了"。
这属于"未做按视角裁剪"的既有局限，已在文档标注，不在本次改动范围。

### 9.57 本阶段验收

`.dev/verify_gamestate_audit.mjs` —— **静态检查，全部通过**：

| 检查项 | 结果 |
| --- | --- |
| 字段提取 | 49 个（静态 17 + 动态 32） |
| 分类完整性 | 无未分类字段 |
| 个人视图是否都剥离 | 16/16 在清单里 |
| 共享事实是否被误剥离 | 无误剥离 |
| 清单是否有拼错/已删项 | 无 |

**已实测它能拦住回潮**：往 `gameState` 注入 `mysteryNewField: 42`
→ 报「未分类字段 gameState.mysteryNewField」并返回退出码 1；移除后恢复通过。

`.dev/verify_gamestate_runtime.mjs` —— **6/6**：

| 断言 | 实测 |
| --- | --- |
| 个人视图字段全部被剥离 | 16 个均未下发 |
| 共享事实字段全部保留 | 18 个采样字段都在 |
| 共享字段值正确传达 | `status=playing round=3 hiroExtra=2` |
| 序列化可 JSON 往返 | 683 字节，无循环/函数残留 |
| 房主个人锁不同步给客机 | 客机 `cardSubmitting=false charSelectLock=false starting=false` |
| 客机仍能正常出牌 | `cardSubmitting=false` |

最终回归（29 套 + 2 个静态检查）全部有输出且全绿：
本机判定静态检查、字段审计静态检查、审计运行时 6/6、结算按钮 12/12、
被动开关 12/12 + 4/4、四问题 10/10 + 8/8、特效 11/11 + 15/15、箭头+思考 16/16、
客机交锋 24/24、交锋布局 5/5、交锋兜底 6/6、回合刷新 8/8 + 7/7、等待态 18/18 + 10/10、
远程选择 12/12 + 11/11、移动 8/8、双端 18/18、方案 A 9/9、BGM 7/7 + 5/5、
新角色 12/12、奈叶香+梅露露 9/9、模式回退 12/12、联机选人 9/9、JS 7/7。

---

## 十、遗留待办

1. **`ui-components.css` 内仍有 108 个同名选择器重复定义**（其中 67 个存在属性互相覆盖，10 个是完全等同的重复块）。
   合并只消除了「跨文件不可见」的问题，真正的去重需逐条核对属性并目视确认渲染无变化。
   清单见 `.dev/dup_selectors.txt`（含每处的行号与属性列表）。
2. `#passive-lock-checkbox`、`#opponents-magic-list` 两个 id 在 DOM 中不存在，相关功能静默失效（已在 `togglePassiveLock()` 等处加空值保护）。
3. 生僻字兜底：字体子集按源码字符集生成，玩家输入罕用字会回退到系统衬线字体（属预期行为）。
4. 高度相关修复（1280×720 紧凑档）的数值来自样式值累加，建议在真实窗口下目视确认一次。
5. ~~小窗口下底部控制台压住棋盘最下面两行格子~~ —— **已在第八节布局重构中解决**（72/72 断言通过，
   12 种尺寸下格子被挡数恒为 0）。
6. 布局重构后 `ui-components.css` 末尾有约 700 行"第七~十节"覆盖块，与文件前中部的旧规则并存。
   这是「同特异性、后出现者胜」的代价：可读性下降，且旧规则仍在参与层叠计算。
   彻底解决需要把旧规则逐条合并进覆盖块（与第 1 条去重是同一件事），风险较高，暂未做。
7. 800×600 这类远小于正常使用范围的窗口，棋盘约 204px（格子 32px）—— 完整可用但已到下限；
   若需要更小窗口可用，应把"自己的角色卡"也挪进顶部玩家条以腾出竖向空间。
8. **新对手面板（第九节）只在 ≥1101px 显示**：≤1100 时仍是原有的横向玩家条，
   立绘列与详情面板被隐藏。若要窄屏也能看详情，需要把详情做成点击弹出的覆盖层。
