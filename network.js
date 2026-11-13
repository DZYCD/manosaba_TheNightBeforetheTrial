/**
 * 魔法少女的魔女审判 - 网络模块 (MQTT)
 */

// ========== MQTT配置 ==========
const MQTT_CONFIG = {
    brokers: [
        { url: 'wss://broker.emqx.io:8084/mqtt', name: 'EMQX' },
        { url: 'wss://broker.hivemq.com:8884/mqtt', name: 'HiveMQ' }
    ],
    currentBrokerIndex: 0,
    topicPrefix: 'witch-game'
};

// ========== 网络状态 ==========
let networkState = {
    mode: 'local',          // 'local' | 'online'
    isHost: false,          // 是否是房主
    localPlayerId: null,    // 本地玩家ID (1-4)
    roomCode: null,         // 房间码
    client: null,           // MQTT客户端
    connected: false,       // 是否已连接
    players: {},            // 房间内玩家 { oderId: { id, name, ready, character } }
    pendingCallbacks: {},   // 等待响应的回调 { requestId: { callback, timeout } }
    reconnectAttempts: 0,
    maxReconnectAttempts: 15, // 配合指数退避，约可持续重试 5 分钟
    reconnectDelay: 2000,   // 重连延迟（毫秒）
    isReconnecting: false,  // 是否正在重连
    lastGameState: null,    // 断线前的游戏状态（用于重连恢复）
    heartbeatInterval: null,// 心跳定时器
    lastHeartbeat: 0,       // 最后心跳时间
    sendSeq: 0,             // 本端发送序号
    recvSeq: {},            // 各发送端已处理的最大序号
    stateSyncTimer: null,   // 房主周期性全量同步定时器
    sessionUid: null        // 本标签页的客户端标识（按会话，不跨标签页共享）
};

// 稳定的 clientId：同一标签页固定不变，重连才能续上 broker 会话。
// MQTT 规范只允许字母数字与 - _，且公共 broker 建议不要太长，这里取 20 字符。
function getStableClientId() {
    const uid = getClientUid().replace(/[^A-Za-z0-9_-]/g, '');
    return ('witch_' + uid).slice(0, 32);
}

/* 房主周期性全量同步：每 5 秒兜底广播一次完整状态。
   丢包/乱序最多导致客机落后 5 秒，而不是"一直卡住直到下一个动作"。 */
/* 执行一次周期同步（定时器与测试都走这里，逻辑只有一份）。 */
function runPeriodicStateSyncOnce() {
        // 诊断计数：便于排查"周期同步到底有没有跑"
        networkState.periodicTicks = (networkState.periodicTicks || 0) + 1;
        networkState.periodicSkip = null;
        if (!isOnlineMode() || !networkState.isHost || !networkState.roomCode) {
            networkState.periodicSkip = 'not-host-or-offline';
            return;
        }
        if (typeof gameState === 'undefined' || !gameState || !Array.isArray(gameState.players)) {
            networkState.periodicSkip = 'no-game-state';
            return;
        }
        // 只在真正对局中同步，避免在选角/房间阶段刷无用流量
        if (gameState.players.length < 2) {
            networkState.periodicSkip = 'waiting-players';
            return;
        }
        if (gameState.status === 'ended') {
            networkState.periodicSkip = 'game-ended';
            return;
        }
        try {
            broadcastGameState();
            networkState.periodicLastAt = Date.now();
        } catch (e) {
            networkState.periodicSkip = 'broadcast-error:' + (e && e.message);
            console.warn('[MQTT] 周期同步失败', e);
        }
}

function startPeriodicStateSync() {
    stopPeriodicStateSync();
    networkState.stateSyncTimer = setInterval(runPeriodicStateSyncOnce, 5000);
}

function stopPeriodicStateSync() {
    if (networkState.stateSyncTimer) {
        clearInterval(networkState.stateSyncTimer);
        networkState.stateSyncTimer = null;
    }
}

// ========== 生成房间码 ==========
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// ========== 生成请求ID ==========
function generateRequestId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ========== 客户端稳定标识 ==========
// 用于房主端识别"同一个客户端重复加入/断线重连"，避免一个人占两个座位。
//
// 重要：这里**不能**用 localStorage。
// localStorage 在同源的所有标签页之间共享，而"双开两个标签页测试联机"是最常见的用法，
// 两个客户端会拿到同一个 uid，房主端据此把这名新玩家误判为"自己重复加入"，
// 直接复用房主自己的座位（localPlayerId=1、玩家列表仍只有 1 人），联机因此完全不可用。
//
// 改为按页面会话生成：同一标签页内刷新/重连保持同一个 uid（满足去重与重连需求），
// 不同标签页各自独立。
function getClientUid() {
    if (networkState.sessionUid) return networkState.sessionUid;
    
    const KEY = 'witch_client_uid';
    let uid = null;
    try {
        // sessionStorage 天然按标签页隔离，且刷新后保留
        uid = sessionStorage.getItem(KEY);
        if (!uid) {
            uid = 'u_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
            sessionStorage.setItem(KEY, uid);
        }
    } catch (e) {
        // sessionStorage 不可用时退化为纯内存标识
        uid = 'u_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
    }
    networkState.sessionUid = uid;
    return uid;
}

// Promise 超时包装：broker 无响应时给出可读错误，而不是一直转圈
function withTimeout(promise, ms, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
    ]);
}

// ========== 获取MQTT主题 ==========
function getTopic(subTopic) {
    return `${MQTT_CONFIG.topicPrefix}/${networkState.roomCode}/${subTopic}`;
}

// ========== 连接MQTT ==========
async function connectMQTT() {
    return new Promise((resolve, reject) => {
        const broker = MQTT_CONFIG.brokers[MQTT_CONFIG.currentBrokerIndex];
        console.log(`[MQTT] 正在连接 ${broker.name}...`);
        updateConnectionStatus('connecting', `正在连接 ${broker.name}...`);
        
        // 稳定的 clientId（按标签页固定）+ 保留会话：
        // 原来每次连接都用随机 clientId 且 clean:true，断线期间的 QoS1 消息会被 broker 丢弃，
        // 重连后既补不到旧消息，也保留不了订阅。
        const clientId = getStableClientId();
        
        try {
            networkState.client = mqtt.connect(broker.url, {
                clientId: clientId,
                clean: false,
                connectTimeout: 10000,
                reconnectPeriod: 0,  // 禁用自动重连，我们自己控制退避
                keepalive: 30        // 30秒心跳
            });
            
            networkState.client.on('connect', () => {
                console.log('[MQTT] 连接成功');
                networkState.connected = true;
                networkState.reconnectAttempts = 0;
                networkState.isReconnecting = false;
                updateConnectionStatus('connected', '已连接');
                startHeartbeat();
                resolve();
            });
            
            networkState.client.on('error', (err) => {
                console.error('[MQTT] 连接错误:', err);
                networkState.connected = false;
                updateConnectionStatus('error', '连接错误');
                reject(err);
            });
            
            networkState.client.on('close', () => {
                console.log('[MQTT] 连接关闭');
                networkState.connected = false;
                stopHeartbeat();
                
                // 如果在游戏中且不是主动断开，尝试重连
                if (networkState.mode === 'online' && networkState.roomCode && !networkState.isReconnecting) {
                    handleDisconnect();
                }
            });
            
            networkState.client.on('offline', () => {
                console.log('[MQTT] 离线');
                networkState.connected = false;
                updateConnectionStatus('offline', '离线');
            });
            
            networkState.client.on('message', (topic, message) => {
                handleMQTTMessage(topic, message.toString());
            });
            
        } catch (err) {
            reject(err);
        }
    });
}

// ========== 断线处理 ==========
function handleDisconnect() {
    if (networkState.isReconnecting) return;
    
    networkState.isReconnecting = true;
    console.log('[MQTT] 检测到断线，准备重连...');
    updateConnectionStatus('reconnecting', '连接断开，正在重连...');
    
    // 显示重连提示UI
    showReconnectingUI();
    
    // 保存当前游戏状态
    if (typeof gameState !== 'undefined') {
        networkState.lastGameState = getSerializableGameState();
    }
    
    attemptReconnect();
}

/* 指数退避：2s、3s、4.5s… 上限 30s，并加 ±20% 抖动避免多端同步重连打爆 broker。
   原来固定 2 秒 × 最多 5 次，10 秒后就永久放弃 —— 一次稍长的网络抖动就再也回不来。 */
function computeReconnectDelay(attempt) {
    const base = Math.min(30000, 2000 * Math.pow(1.5, Math.max(0, attempt - 1)));
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    return Math.round(base + jitter);
}

// ========== 尝试重连 ==========
async function attemptReconnect() {
    if (networkState.reconnectAttempts >= networkState.maxReconnectAttempts) {
        console.log('[MQTT] 重连次数已达上限');
        updateConnectionStatus('failed', '重连失败');
        showReconnectFailedUI();
        networkState.isReconnecting = false;
        return;
    }
    
    networkState.reconnectAttempts++;
    const attempt = networkState.reconnectAttempts;
    networkState.reconnectDelay = computeReconnectDelay(attempt);
    console.log(`[MQTT] 第 ${attempt}/${networkState.maxReconnectAttempts} 次重连尝试（${networkState.reconnectDelay}ms 后）...`);
    updateConnectionStatus('reconnecting', `重连中 (${attempt}/${networkState.maxReconnectAttempts})…`);
    
    try {
        // 先断开旧连接
        if (networkState.client) {
            networkState.client.end(true);
            networkState.client = null;
        }
        
        // 尝试切换broker
        if (attempt > 1 && attempt % 2 === 0) {
            MQTT_CONFIG.currentBrokerIndex = (MQTT_CONFIG.currentBrokerIndex + 1) % MQTT_CONFIG.brokers.length;
            console.log(`[MQTT] 切换到备用服务器: ${MQTT_CONFIG.brokers[MQTT_CONFIG.currentBrokerIndex].name}`);
        }
        
        // 等待一段时间后重连
        await new Promise(resolve => setTimeout(resolve, networkState.reconnectDelay));
        
        // 重新连接
        await connectMQTT();
        
        // 重新订阅房间（等订阅真正建立后再发消息，避免请求抢在订阅之前被丢弃）
        if (networkState.roomCode) {
            subscribeToRoom(() => {
                // 发送重连消息
                sendMessage('reconnect', {
                    playerId: networkState.localPlayerId,
                    isHost: networkState.isHost
                }, 'room');

                // 如果是房主，广播当前状态；否则请求状态同步
                if (networkState.isHost) {
                    broadcastGameState();
                } else {
                    requestStateSync();
                }
            });
        }
        
        console.log('[MQTT] 重连成功');
        hideReconnectingUI();
        networkState.isReconnecting = false;
        
    } catch (err) {
        console.error(`[MQTT] 第 ${attempt} 次重连失败:`, err);
        
        // 继续尝试
        setTimeout(() => {
            attemptReconnect();
        }, networkState.reconnectDelay);
    }
}

// ========== 请求状态同步 ==========
function requestStateSync() {
    sendMessage('request_sync', {
        playerId: networkState.localPlayerId
    }, 'room');
}

// ========== 心跳机制 ==========
function startHeartbeat() {
    stopHeartbeat();
    networkState.lastHeartbeat = Date.now();
    
    networkState.heartbeatInterval = setInterval(() => {
        if (networkState.connected && networkState.roomCode) {
            sendMessage('heartbeat', {
                playerId: networkState.localPlayerId,
                timestamp: Date.now()
            }, 'room');
            networkState.lastHeartbeat = Date.now();
        }
    }, 15000); // 每15秒发送心跳
}

function stopHeartbeat() {
    if (networkState.heartbeatInterval) {
        clearInterval(networkState.heartbeatInterval);
        networkState.heartbeatInterval = null;
    }
}

// ========== 连接状态UI更新 ==========
function updateConnectionStatus(status, message) {
    const statusEl = document.getElementById('connection-status');
    if (statusEl) {
        statusEl.className = `connection-status ${status}`;
        statusEl.textContent = message;
        statusEl.style.display = 'block';
    }
    
    // 触发自定义事件
    window.dispatchEvent(new CustomEvent('connectionStatusChange', {
        detail: { status, message }
    }));
}

// ========== 重连UI ==========
function showReconnectingUI() {
    let overlay = document.getElementById('reconnect-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'reconnect-overlay';
        overlay.innerHTML = `
            <div class="reconnect-content">
                <div class="reconnect-spinner"></div>
                <div class="reconnect-text">连接断开，正在重连...</div>
                <div class="reconnect-attempts" id="reconnect-attempts"></div>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
}

function hideReconnectingUI() {
    const overlay = document.getElementById('reconnect-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function showReconnectFailedUI() {
    let overlay = document.getElementById('reconnect-overlay');
    if (overlay) {
        overlay.innerHTML = `
            <div class="reconnect-content">
                <div class="reconnect-failed-icon">❌</div>
                <div class="reconnect-text">重连失败</div>
                <div class="reconnect-buttons">
                    <button class="btn-confirm" onclick="manualReconnect()">重试</button>
                    <button class="btn-confirm" onclick="returnToMenu()">返回菜单</button>
                </div>
            </div>
        `;
    }
}

// ========== 手动重连 ==========
async function manualReconnect() {
    networkState.reconnectAttempts = 0;
    networkState.isReconnecting = false;
    
    const overlay = document.getElementById('reconnect-overlay');
    if (overlay) {
        overlay.innerHTML = `
            <div class="reconnect-content">
                <div class="reconnect-spinner"></div>
                <div class="reconnect-text">正在重连...</div>
            </div>
        `;
    }
    
    attemptReconnect();
}

// ========== 返回菜单 ==========
function returnToMenu() {
    hideReconnectingUI();
    disconnectMQTT();
    
    // 重置网络状态
    networkState.mode = 'local';
    networkState.isHost = false;
    networkState.localPlayerId = null;
    networkState.roomCode = null;
    networkState.players = {};
    networkState.isReconnecting = false;
    networkState.reconnectAttempts = 0;
    
    // 返回主菜单
    if (typeof showScreen === 'function') {
        showScreen('menu-screen');
    }
}

// ========== 断开MQTT ==========
/* 权威清理：把联机相关的全部状态归零。
   历史问题：disconnectMQTT 只清 client/roomCode/isHost/players，
   而 mode、localPlayerId、心跳定时器、未完成回调、重连状态都会残留。
   退出房间回到单人后 mode 仍是 'online'（或被写成非法的 'single'），
   导致 isLocalPlayer()/isMyTurn()/getLocalPlayer() 全部返回错误结果，
   且所有 networkState.mode === 'local' 的 AI 自动行为被跳过。 */
function resetNetworkState() {
    // 停心跳
    try { stopHeartbeat(); } catch (e) { /* 忽略 */ }

    // 清未完成的请求回调（含超时定时器，否则之后会突然 reject）
    try {
        const pending = networkState.pendingCallbacks || {};
        Object.keys(pending).forEach((key) => {
            const entry = pending[key];
            if (entry && entry.timeout) {
                try { clearTimeout(entry.timeout); } catch (e) { /* 忽略 */ }
            }
            delete pending[key];
        });
        networkState.pendingCallbacks = {};
    } catch (e) { /* 忽略 */ }

    // 强制关闭连接
    if (networkState.client) {
        try { networkState.client.end(true); } catch (e) { /* 忽略 */ }
        networkState.client = null;
    }

    // 关闭重连提示层
    try { if (typeof hideReconnectingUI === 'function') hideReconnectingUI(); } catch (e) { /* 忽略 */ }

    // 状态归零：mode 必须是合法值 'local'
    networkState.mode = 'local';
    networkState.isHost = false;
    networkState.localPlayerId = null;
    networkState.roomCode = null;
    networkState.connected = false;
    networkState.players = {};
    networkState.isReconnecting = false;
    networkState.reconnectAttempts = 0;
    networkState.lastGameState = null;
    networkState.lastHeartbeat = 0;
    networkState.sendSeq = 0;
    networkState.recvSeq = {};
    try { if (typeof stopPeriodicStateSync === 'function') stopPeriodicStateSync(); } catch (e) { /* 忽略 */ }

    return networkState;
}

function disconnectMQTT() {
    resetNetworkState();
}

// ========== 带故障转移的连接 ==========
// 原来首次连接只试当前 broker，EMQX 一旦抽风就直接失败（切换逻辑只存在于"断线重连"路径）。
// 公共 broker 偶发不可用是最常见的"联机不可用"成因，这里逐个尝试，并给出可读的失败原因。
async function connectWithFailover() {
    if (networkState.connected) return MQTT_CONFIG.brokers[MQTT_CONFIG.currentBrokerIndex];
    
    const total = MQTT_CONFIG.brokers.length;
    let lastErr = null;
    
    for (let i = 0; i < total; i++) {
        const idx = (MQTT_CONFIG.currentBrokerIndex + i) % total;
        const broker = MQTT_CONFIG.brokers[idx];
        
        // 清理上一次失败留下的僵尸 client
        if (networkState.client) {
            try { networkState.client.end(true); } catch (e) { /* ignore */ }
            networkState.client = null;
        }
        networkState.connected = false;
        
        if (total > 1) {
            updateConnectionStatus('connecting', `正在连接 ${broker.name}${i > 0 ? `（备用 ${i}）` : ''}...`);
        }
        
        try {
            MQTT_CONFIG.currentBrokerIndex = idx;
            await withTimeout(connectMQTT(), 12000, `连接 ${broker.name} 超时`);
            console.log(`[MQTT] 已连接 ${broker.name}`);
            return broker;
        } catch (e) {
            lastErr = e;
            console.warn(`[MQTT] ${broker.name} 连接失败: ${e && e.message ? e.message : e}`);
        }
    }
    
    throw new Error(`所有服务器都无法连接${lastErr ? '（' + lastErr.message + '）' : ''}，请检查网络后重试`);
}

// ========== 创建房间 ==========
async function createRoom() {
    try {
        // 连接MQTT（逐个尝试所有 broker，带超时）
        if (!networkState.connected) {
            await connectWithFailover();
        }
        
        // 生成房间码
        networkState.roomCode = generateRoomCode();
        networkState.isHost = true;
        networkState.localPlayerId = 1;
        networkState.mode = 'online';
        
        // 订阅房间主题
        subscribeToRoom();
        
        // 添加自己到玩家列表
        networkState.players[1] = {
            id: 1,
            uid: getClientUid(),
            name: typeof getPlayerName === 'function' ? getPlayerName() : '房主',
            ready: false,
            character: null,
            isHost: true,
            lastSeen: Date.now()
        };
        
        console.log(`[房间] 创建成功: ${networkState.roomCode}`);
        return networkState.roomCode;
        
    } catch (err) {
        console.error('[房间] 创建失败:', err);
        throw err;
    }
}

// ========== 加入房间 ==========
async function joinRoom(roomCode) {
    try {
        // 连接MQTT（逐个尝试所有 broker，带超时）
        if (!networkState.connected) {
            await connectWithFailover();
        }
        
        networkState.roomCode = roomCode.toUpperCase();
        networkState.isHost = false;
        networkState.mode = 'online';
        
        // 订阅房间主题
        subscribeToRoom();
        
        // 发送加入请求
        return new Promise((resolve, reject) => {
            const requestId = generateRequestId();
            
            // 设置超时
            const timeout = setTimeout(() => {
                delete networkState.pendingCallbacks[requestId];
                reject(new Error('加入房间超时，房间可能不存在'));
            }, 5000);
            
            networkState.pendingCallbacks[requestId] = {
                callback: (response) => {
                    clearTimeout(timeout);
                    if (response.success) {
                        networkState.localPlayerId = response.playerId;
                        networkState.players = response.players;
                        console.log(`[房间] 加入成功，玩家ID: ${response.playerId}`);
                        resolve(response);
                    } else {
                        reject(new Error(response.error || '加入失败'));
                    }
                },
                timeout: timeout
            };
            
            // 发送加入请求（带上稳定的客户端 uid，房主据此去重/识别重连）
            sendMessage('join', {
                requestId: requestId,
                uid: getClientUid(),
                name: typeof getPlayerName === 'function' ? getPlayerName() : '玩家'
            });
        });
        
    } catch (err) {
        console.error('[房间] 加入失败:', err);
        throw err;
    }
}

// ========== 订阅房间主题 ==========
function subscribeToRoom(onAllDone) {
    if (!networkState.client || !networkState.roomCode) {
        if (typeof onAllDone === 'function') onAllDone(false);
        return;
    }
    
    const topics = [
        getTopic('state'),      // 游戏状态
        getTopic('action'),     // 玩家操作
        getTopic('room'),       // 房间管理
        getTopic('passive')     // 被动技能
    ];
    
    let pending = topics.length;
    let failed = 0;
    const done = () => {
        pending--;
        if (pending > 0) return;
        if (typeof onAllDone === 'function') onAllDone(failed === 0);
    };
    
    topics.forEach(topic => {
        networkState.client.subscribe(topic, { qos: 1 }, (err) => {
            if (err) {
                failed++;
                console.error(`[MQTT] 订阅失败: ${topic}`, err);
            } else {
                console.log(`[MQTT] 已订阅: ${topic}`);
            }
            done();
        });
    });
}

// ========== 发送消息 ==========
function sendMessage(type, data, subTopic = 'action') {
    if (!networkState.client || !networkState.connected) {
        console.error('[MQTT] 未连接，无法发送消息');
        return;
    }
    
    // 单调递增序号：接收端据此丢弃重复/过期消息（QoS1 会重复投递）
    networkState.sendSeq = (networkState.sendSeq || 0) + 1;
    const message = {
        type: type,
        senderId: networkState.localPlayerId,
        seq: networkState.sendSeq,
        timestamp: Date.now(),
        ...data
    };
    
    const topic = getTopic(subTopic);
    // QoS 1：至少送达一次。回合制动作频率低，重发开销可忽略，
    // 而 QoS 0 一旦丢包就是"丢一步操作"（卡回合/不同步的直接原因）。
    networkState.client.publish(topic, JSON.stringify(message), { qos: 1 });
    console.log(`[MQTT] 发送: ${type} seq=${message.seq}`);
}

// ========== 处理收到的消息 ==========
function handleMQTTMessage(topic, messageStr) {
    try {
        const message = JSON.parse(messageStr);

        // 防护：非联机模式时忽略一切房间消息。
        // 否则退回单人后，在途/残留消息仍会改写 gameState。
        // 只判 mode 而不判 roomCode：roomCode 与 mode 一起清零，
        // 多加一个条件只会在状态时序异常时静默丢消息，反而更难排查。
        if (!isOnlineMode()) return;

        // 忽略自己发送的消息（除了某些需要确认的）
        if (message.senderId === networkState.localPlayerId && 
            !['join_response', 'state_sync'].includes(message.type)) {
            return;
        }

        // 按发送者做序号去重：QoS1 可能重复投递，同一序号只处理一次；
        // 明显乱序（旧序号）直接丢弃，避免用旧状态覆盖新状态。
        if (typeof message.seq === 'number' && message.senderId !== null && message.senderId !== undefined) {
            const key = String(message.senderId);
            const last = networkState.recvSeq[key] || 0;
            if (message.seq <= last) {
                console.log(`[MQTT] 丢弃重复/过期消息 ${message.type} seq=${message.seq} <= ${last}`);
                return;
            }
            networkState.recvSeq[key] = message.seq;
        }
        
        console.log(`[MQTT] 收到: ${message.type}`, message);
        
        // 根据消息类型处理
        switch (message.type) {
            // ===== 房间管理 =====
            case 'join':
                handleJoinRequest(message);
                break;
            case 'join_response':
                handleJoinResponse(message);
                break;
            case 'player_joined':
                handlePlayerJoined(message);
                break;
            case 'player_left':
                handlePlayerLeft(message);
                break;
            case 'player_offline':
                // 房主广播的掉线通知（原来没有任何接收分支，是条单向死消息）
                if (typeof markPlayerOfflineInGame === 'function') {
                    markPlayerOfflineInGame(message.playerId, 'offline');
                }
                break;
            case 'game_abort':
                handleGameAbort(message);
                break;
            case 'player_ready':
                handlePlayerReady(message);
                break;
            case 'character_selected':
                handleCharacterSelected(message);
                break;
            case 'game_start':
                handleGameStart(message);
                break;
            case 'reconnect':
                handlePlayerReconnect(message);
                break;
            case 'request_sync':
                handleSyncRequest(message);
                break;
            case 'heartbeat':
                handleHeartbeat(message);
                break;
                
            // ===== 游戏操作 =====
            case 'play_card':
                handleRemotePlayCard(message);
                break;
            case 'select_direction':
                handleRemoteSelectDirection(message);
                break;

            // 移动的一步（房主广播，客机复现滑动动画）
            case 'move_step':
                handleMoveStep(message);
                break;

            // 被动开关：客机把自己的设置告诉房主（房主是权威，要记下来）
            case 'passive_toggle':
                if (networkState.isHost && typeof handleRemotePassiveToggle === 'function') {
                    handleRemotePassiveToggle(message);
                }
                break;

            // 特效（技能动画 / 提示 / 魔女化飘字 / 警告）：客机重放
            case 'fx_event':
                if (!networkState.isHost && typeof handleRemoteFx === 'function') {
                    handleRemoteFx(message);
                }
                break;

            // 回合刷新：转场动画 + 处刑警告（房主广播，客机复现同款动画）
            case 'round_transition':
                if (!networkState.isHost && typeof playRemoteRoundTransition === 'function') {
                    playRemoteRoundTransition(message);
                }
                break;
            case 'execution_warning':
                if (!networkState.isHost && typeof playRemoteExecutionWarning === 'function') {
                    playRemoteExecutionWarning(message);
                }
                break;

            // 交锋：开局 / 灯亮 / 结束（房主广播，客机各自显示界面）
            case 'confrontation_start':
                if (!networkState.isHost && typeof showRemoteConfrontation === 'function') {
                    showRemoteConfrontation(message);
                }
                break;
            case 'confrontation_light':
                if (!networkState.isHost && typeof handleRemoteConfrontationLight === 'function') {
                    handleRemoteConfrontationLight(message);
                }
                break;
            case 'confrontation_outro':
                if (!networkState.isHost && typeof handleRemoteConfrontationOutro === 'function') {
                    handleRemoteConfrontationOutro(message);
                }
                break;
            case 'confrontation_end':
                if (!networkState.isHost && typeof handleRemoteConfrontationEnd === 'function') {
                    handleRemoteConfrontationEnd(message);
                }
                break;
            case 'select_resource':
                handleRemoteSelectResource(message);
                break;
            case 'cast_magic':
                handleRemoteCastMagic(message);
                break;
            case 'confrontation_press':
                handleRemoteConfrontationPress(message);
                break;
            case 'confirm_steal':
                handleRemoteConfirmSteal(message);
                break;
                
            // ===== 汉娜浮空 =====
            case 'hanna_step_selected':
                handleRemoteHannaStepSelected(message);
                break;
            case 'hanna_direction_selected':
                handleRemoteHannaDirectionSelected(message);
                break;
                
            // ===== 里世界效果 =====
            case 'shadow_swap':
                handleRemoteShadowSwap(message);
                break;
            case 'shadow_delete':
                handleRemoteShadowDelete(message);
                break;
                
            // ===== 被动技能 =====
            case 'passive_request':
                handlePassiveRequest(message);
                break;
            case 'passive_response':
                handlePassiveResponse(message);
                break;
                
            // ===== 状态同步 =====
            case 'state_sync':
                handleStateSync(message);
                break;
                
            default:
                console.log(`[MQTT] 未知消息类型: ${message.type}`);
        }
        
    } catch (err) {
        console.error('[MQTT] 消息解析错误:', err);
    }
}

// ========== 房间管理消息处理 ==========

// 处理加入请求（房主处理）
function handleJoinRequest(message) {
    if (!networkState.isHost) return;
    
    // 同一个客户端重复提交（手抖双击、同一标签页重连）只保留一个座位——幂等语义：
    //   1. 绝不匹配房主席位（否则新玩家会把房主挤掉，联机会直接瘫痪）；
    //   2. uid 现在是按标签页生成的（sessionStorage），所以匹配到就一定是同一个标签页。
    if (message.uid) {
        const existing = Object.values(networkState.players).find((p) =>
            p.uid === message.uid &&
            !p.isHost &&
            p.id !== networkState.localPlayerId
        );
        if (existing) {
            existing.lastSeen = Date.now();
            console.log(`[房间] 重复加入请求，复用座位 ${existing.id}`);
            sendMessage('join_response', {
                requestId: message.requestId,
                success: true,
                playerId: existing.id,
                players: networkState.players
            }, 'room');
            return;
        }
    }
    
    // 检查房间是否已满
    const playerCount = Object.keys(networkState.players).length;
    if (playerCount >= 4) {
        sendMessage('join_response', {
            requestId: message.requestId,
            success: false,
            error: '房间已满'
        }, 'room');
        return;
    }
    
    // 分配玩家ID：取现有最大 id + 1，避免有人离开后出现座位号冲突
    const maxId = Object.keys(networkState.players).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
    const newPlayerId = maxId + 1;
    
    // 同名去重：昵称存在 localStorage 里，同一浏览器开两个标签页会读到同一个名字，
    // 一局里出现两个"玩家"会让人分不清谁是谁。
    let playerName = message.name || `玩家${newPlayerId}`;
    if (Object.values(networkState.players).some((p) => p.name === playerName)) {
        const base = playerName;
        let suffix = 2;
        while (Object.values(networkState.players).some((p) => p.name === `${base}(${suffix})`)) {
            suffix++;
        }
        playerName = `${base}(${suffix})`;
    }
    
    networkState.players[newPlayerId] = {
        id: newPlayerId,
        uid: message.uid || null,
        name: playerName,
        ready: false,
        character: null,
        isHost: false,
        lastSeen: Date.now()
    };
    
    // 发送响应
    sendMessage('join_response', {
        requestId: message.requestId,
        success: true,
        playerId: newPlayerId,
        players: networkState.players
    }, 'room');
    
    // 广播玩家加入
    sendMessage('player_joined', {
        playerId: newPlayerId,
        player: networkState.players[newPlayerId],
        players: networkState.players
    }, 'room');
    
    // 更新房间UI
    if (typeof updateRoomUI === 'function') {
        updateRoomUI();
    }
}

// 处理加入响应
function handleJoinResponse(message) {
    const pending = networkState.pendingCallbacks[message.requestId];
    if (pending) {
        pending.callback(message);
        delete networkState.pendingCallbacks[message.requestId];
    }
}

// 处理玩家加入广播
function handlePlayerJoined(message) {
    networkState.players = message.players;
    if (typeof updateRoomUI === 'function') {
        updateRoomUI();
    }
}

// 处理玩家离开
function handlePlayerLeft(message) {
    delete networkState.players[message.playerId];
    // 对局中光删房间列表不够：必须同步 gameState，否则其他玩家的回合会永久停在离开者身上
    if (typeof markPlayerOfflineInGame === 'function') {
        markPlayerOfflineInGame(message.playerId, 'left');
    }
    if (typeof updateRoomUI === 'function') {
        updateRoomUI();
    }
}

// 房主中途退出：整局中止
function handleGameAbort(message) {
    console.warn('[联机] 房主中止了对局', message && message.reason);
    if (typeof showMagicAlert === 'function') {
        showMagicAlert('对局中止', '房主已离开，本局结束。');
    }
    if (typeof stopHeartbeat === 'function') stopHeartbeat();
    disconnectMQTT();
    if (typeof resetAllGameState === 'function') resetAllGameState();
    if (typeof showScreen === 'function') showScreen('menu-screen');
}

// 处理玩家准备
function handlePlayerReady(message) {
    if (networkState.players[message.playerId]) {
        networkState.players[message.playerId].ready = message.ready;
    }
    if (typeof updateRoomUI === 'function') {
        updateRoomUI();
    }
}

// 处理角色选择
function handleCharacterSelected(message) {
    // 幂等：本地先应用一次后，broker 把同一条消息回声回来时直接忽略，
    // 否则会重复推进选角序号、甚至把游戏初始化两次。
    const seat = networkState.players[message.playerId];
    if (!seat) return;
    if (seat.character === message.characterId) return;

    // 更新网络状态中的玩家角色
    seat.character = message.characterId;
    
    // 同步到游戏状态
    if (typeof gameState !== 'undefined') {
        // 添加到已选角色列表（如果还没有）
        if (!gameState.selectedCharacters.includes(message.characterId)) {
            gameState.selectedCharacters.push(message.characterId);
        }
        
        // 更新当前选择玩家索引
        gameState.currentSelectingPlayer = gameState.selectedCharacters.length;
        
        // 检查是否所有人都选完了
        if (gameState.currentSelectingPlayer >= gameState.playerCount) {
            // 房主初始化游戏
            if (networkState.isHost) {
                if (typeof initOnlineGame === 'function') {
                    // 延迟一点让UI更新
                    setTimeout(() => {
                        initOnlineGame();
                    }, 500);
                }
            }
        } else {
            // 更新角色选择界面
            if (typeof renderOnlineCharacterSelect === 'function') {
                renderOnlineCharacterSelect();
            }
        }
    }
    
    if (typeof updateRoomUI === 'function') {
        updateRoomUI();
    }
}

// 处理游戏开始
function handleGameStart(message) {
    console.log('[房间] 收到游戏开始消息:', message);
    
    // 角色选择阶段
    if (message.phase === 'character_select') {
        if (typeof gameState !== 'undefined') {
            gameState.gameMode = 'multi';
            gameState.playerCount = message.playerCount;
            gameState.currentSelectingPlayer = 0;
            gameState.selectedCharacters = [];
            gameState.tempSelectedChar = null;
        }
        
        if (typeof showScreen === 'function') {
            showScreen('character-screen');
        }
        if (typeof renderOnlineCharacterSelect === 'function') {
            renderOnlineCharacterSelect();
        }
    } 
    // 游戏进行阶段（带完整状态）
    else if (message.gameState) {
        if (typeof startOnlineGame === 'function') {
            startOnlineGame(message);
        }
    }
}

// 处理玩家重连
function handlePlayerReconnect(message) {
    console.log(`[房间] 玩家 ${message.playerId} 重连`);
    
    // 更新玩家在线状态
    if (networkState.players[message.playerId]) {
        networkState.players[message.playerId].online = true;
        networkState.players[message.playerId].lastSeen = Date.now();
    }
    
    // 房主发送当前状态给重连玩家
    if (networkState.isHost) {
        setTimeout(() => {
            broadcastGameState();
        }, 300);
    }
    
    if (typeof updateRoomUI === 'function') {
        updateRoomUI();
    }
    
    // 显示重连提示
    if (typeof showToast === 'function') {
        const playerName = networkState.players[message.playerId]?.name || `玩家${message.playerId}`;
        showToast(`${playerName} 已重连`);
    }
}

// 处理状态同步请求（房主处理）
function handleSyncRequest(message) {
    if (!networkState.isHost) return;
    
    console.log(`[房间] 玩家 ${message.playerId} 请求状态同步`);
    broadcastGameState();
}

// 处理心跳
function handleHeartbeat(message) {
    // 更新玩家最后活跃时间
    if (networkState.players[message.playerId]) {
        networkState.players[message.playerId].lastSeen = message.timestamp;
        networkState.players[message.playerId].online = true;
    }
    
    // 房主检查离线玩家
    if (networkState.isHost) {
        checkOfflinePlayers();
    }
}

// 检查离线玩家（房主用）
function checkOfflinePlayers() {
    const now = Date.now();
    const offlineThreshold = 45000; // 45秒无心跳视为离线
    
    Object.keys(networkState.players).forEach(playerId => {
        const player = networkState.players[playerId];
        if (parseInt(playerId) === networkState.localPlayerId) return; // 跳过自己
        
        if (player.lastSeen && (now - player.lastSeen) > offlineThreshold) {
            if (player.online !== false) {
                player.online = false;
                console.log(`[房间] 玩家 ${playerId} 可能离线`);
                
                // 广播玩家离线状态
                sendMessage('player_offline', {
                    playerId: parseInt(playerId)
                }, 'room');
                
                if (typeof updateRoomUI === 'function') {
                    updateRoomUI();
                }
            }
        }
    });
}

// ========== 游戏操作消息处理 ==========

function handleRemotePlayCard(message) {
    if (networkState.isHost && typeof processRemotePlayCard === 'function') {
        processRemotePlayCard(message.playerId, message.cardIndex);
    }
}

function handleRemoteSelectDirection(message) {
    if (networkState.isHost && typeof processRemoteSelectDirection === 'function') {
        processRemoteSelectDirection(message.playerId, message.direction);
    }
}

// 房主广播的"移动一步"事件：交给 game.js 复现动画
function handleMoveStep(message) {
    if (networkState.isHost) return;
    if (typeof handleMoveStepEvent === 'function') {
        handleMoveStepEvent(message);
    }
}

function handleRemoteSelectResource(message) {
    if (networkState.isHost && typeof processRemoteSelectResource === 'function') {
        processRemoteSelectResource(message.playerId, message.selection);
    }
}

function handleRemoteCastMagic(message) {
    if (networkState.isHost && typeof processRemoteCastMagic === 'function') {
        processRemoteCastMagic(message.playerId);
    }
}

function handleRemoteConfrontationPress(message) {
    if (networkState.isHost && typeof processRemoteConfrontationPress === 'function') {
        processRemoteConfrontationPress(message.playerId, message.pressTime);
    }
}

function handleRemoteConfirmSteal(message) {
    if (networkState.isHost && typeof processRemoteConfirmSteal === 'function') {
        processRemoteConfirmSteal(message.playerId, message.selectedSteals);
    }
}

// ========== 汉娜浮空消息处理 ==========

function handleRemoteHannaStepSelected(message) {
    if (networkState.isHost && typeof processRemoteHannaStepSelected === 'function') {
        processRemoteHannaStepSelected(message.playerId, message.steps, message.isEnhanced);
    }
}

function handleRemoteHannaDirectionSelected(message) {
    if (networkState.isHost && typeof processRemoteHannaDirectionSelected === 'function') {
        processRemoteHannaDirectionSelected(message.playerId, message.targetPos);
    }
}

// ========== 里世界效果消息处理 ==========

function handleRemoteShadowSwap(message) {
    if (networkState.isHost && typeof processRemoteShadowSwap === 'function') {
        processRemoteShadowSwap(message.playerId, message.targetPlayers);
    }
}

function handleRemoteShadowDelete(message) {
    if (networkState.isHost && typeof processRemoteShadowDelete === 'function') {
        processRemoteShadowDelete(message.playerId, message.targetId, message.cardIndex);
    }
}

// ========== 被动技能消息处理 ==========

// 被动技能请求队列（房主用）
let passiveRequestQueue = {};

// 最近一次收到的被动请求 id（诊断/测试用）
let lastPassiveRequestId = null;

function handlePassiveRequest(message) {
    // 检查是否是发给自己的
    if (message.targetPlayerId !== networkState.localPlayerId) return;

    lastPassiveRequestId = message.requestId;
    
    // 显示被动技能决策UI
    if (typeof showRemotePassiveDecision === 'function') {
        showRemotePassiveDecision(message);
    }
}

function handlePassiveResponse(message) {
    // 房主处理被动技能响应
    const requestId = message.requestId;
    if (passiveRequestQueue[requestId]) {
        const { callback, timeout } = passiveRequestQueue[requestId];
        clearTimeout(timeout);
        delete passiveRequestQueue[requestId];
        callback(message.activate, message.data);
    }
}

// 房主发送被动技能请求
function sendPassiveRequest(skillType, targetPlayerId, data, onResponse, timeoutMs = 10000) {
    const requestId = generateRequestId();

    // 所有"等某个玩家做决定"都走这里，统一广播等待态：
    // 其他人锁操作 + 高亮那位玩家（蓝色"考虑中"）。
    if (typeof beginPlayerWaiting === 'function') {
        beginPlayerWaiting(targetPlayerId, skillType, requestId);
    }

    // 响应/超时都要解除等待态，所以包一层
    const settled = (activate, payload) => {
        if (typeof endPlayerWaiting === 'function') {
            endPlayerWaiting(requestId);
        }
        if (typeof onResponse === 'function') {
            onResponse(activate, payload);
        }
    };
    
    // 设置超时
    const timeout = setTimeout(() => {
        if (passiveRequestQueue[requestId]) {
            delete passiveRequestQueue[requestId];
            settled(false, null); // 超时默认不发动
        }
    }, timeoutMs);
    
    passiveRequestQueue[requestId] = {
        callback: settled,
        timeout: timeout
    };
    
    // 注意展开顺序：业务数据必须放在固定字段之前。
    // 否则 data 里若带 type 之类的键，会把 type='passive_request' 覆盖掉，
    // 接收端就会当成未知消息类型丢掉（曾经踩过）。
    sendMessage('passive_request', {
        ...data,
        requestId: requestId,
        skillType: skillType,
        targetPlayerId: targetPlayerId
    }, 'passive');
}

// 玩家发送被动技能响应
function sendPassiveResponse(requestId, activate, data = {}) {
    sendMessage('passive_response', {
        requestId: requestId,
        activate: activate,
        data: data
    }, 'passive');
}

// ========== 状态同步 ==========

function handleStateSync(message) {
    // 非房主接收状态同步
    if (!networkState.isHost && typeof syncGameState === 'function') {
        syncGameState(message.gameState);
    }
}

// 房主广播游戏状态
function broadcastGameState() {
    if (!networkState.isHost) return;
    
    sendMessage('state_sync', {
        gameState: getSerializableGameState()
    }, 'state');
}

// 获取可序列化的游戏状态
/* ========== gameState 字段分类：共享事实 vs 个人视图 ==========

   背景：联机时整个 gameState 会下发给所有人。放进去的"个人设置/个人界面状态"
   会串给别人（已经踩过：passiveMagicLock 导致房主关被动把客机也关了）。
   所以个人视图字段必须在这里剥离。

   判定标准：
   - 共享事实：所有客户端必须看到同一个值（回合、棋盘、玩家、进行中的决策…）
   - 个人视图：只对某台机器有意义（我选了哪张牌、我的界面开关、本机的回调…）

   新增 gameState 字段时请同步更新本清单与 .dev/verify_gamestate_audit.mjs，
   否则静态检查会报"未分类字段"。 */
const PERSONAL_VIEW_FIELDS = [
    // —— 本机界面开关 ——
    'showingShadowWorld',        // 奈叶香"查看里世界"的本机开关，同步会让别人也进里世界

    // —— 本机交互锁（防连点）：被别人同步过来会把自己的按钮锁死 ——
    'charSelectLock',
    'cardSubmitting',
    'starting',

    // —— 本机选择中但未确认的临时状态 ——
    'tempSelectedChar',          // 选角页暂存
    'selectedCardIndex',         // 手牌选中索引

    // —— 决策过程对象：持有 player/callback 引用，序列化后是脏数据 ——
    'meruruHealState',
    'nayekaBasementState',
    'nayekaState',
    'margPassiveState',
    'shadowSwapState',
    'shadowDeleteState',
    'sherryTargetState',
    'sherryConfrontationState',
    'hannaStepState',
    'leiyaEnhancedForkCallback'  // 直接是函数，JSON 序列化会变成 {} 脏数据
];

function getSerializableGameState() {
    // 创建gameState的深拷贝，移除不可序列化的内容
    const state = JSON.parse(JSON.stringify(gameState));
    
    // 移除Set类型（需要转换）
    if (state.players) {
        state.players.forEach(p => {
            if (p.visitedCells) {
                p.visitedCells = Array.from(p.visitedCells || []);
            }
        });
    }

    // gameState 里哪些字段是"个人视图"、不能下发，见下方 PERSONAL_VIEW_FIELDS。
    PERSONAL_VIEW_FIELDS.forEach((field) => {
        delete state[field];
    });
    
    // 添加moveState用于同步移动状态（汉娜浮空等）
    if (typeof moveState !== 'undefined') {
        state._moveState = {
            isMoving: moveState.isMoving,
            playerId: moveState.player ? moveState.player.id : null,
            remainingSteps: moveState.remainingSteps,
            path: moveState.path,
            previousPosition: moveState.previousPosition,
            lastPassedCell: moveState.lastPassedCell,
            isHannaFloat: moveState.isHannaFloat || false,
            isHannaEnhanced: moveState.isHannaEnhanced || false,
            skipConfrontation: moveState.skipConfrontation || false
        };
    }
    
    return state;
}

// ========== 辅助函数 ==========

/* 是否处于联机模式。
   判据写成"只有明确等于 online 才算联机"：mode 一旦是任何其它值
   （包括历史遗留的非法值，如 'single'），一律按本地模式处理，
   这样单人局永远不会因为状态残留而走进联机分支。 */
function isOnlineMode() {
    return typeof networkState !== 'undefined' && !!networkState && networkState.mode === 'online';
}

// 检查是否是本地玩家
function isLocalPlayer(player) {
    if (!isOnlineMode()) {
        return !player.isAI;
    }
    return player.id === networkState.localPlayerId;
}

// 检查是否是当前玩家的回合
function isMyTurn() {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (!isOnlineMode()) {
        return !!currentPlayer && !currentPlayer.isAI;
    }
    return !!currentPlayer && currentPlayer.id === networkState.localPlayerId;
}

// 获取本地玩家
function getLocalPlayer() {
    if (!isOnlineMode()) {
        return gameState.players.find(p => !p.isAI);
    }
    return gameState.players.find(p => p.id === networkState.localPlayerId);
}

// ========== 导出 ==========
window.networkState = networkState;
window.createRoom = createRoom;
window.joinRoom = joinRoom;
window.disconnectMQTT = disconnectMQTT;
window.sendMessage = sendMessage;
window.broadcastGameState = broadcastGameState;
window.isLocalPlayer = isLocalPlayer;
window.isMyTurn = isMyTurn;
window.getLocalPlayer = getLocalPlayer;
window.sendPassiveRequest = sendPassiveRequest;
window.sendPassiveResponse = sendPassiveResponse;
window.manualReconnect = manualReconnect;
window.returnToMenu = returnToMenu;
window.requestStateSync = requestStateSync;
