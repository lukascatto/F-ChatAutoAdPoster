// content-main.js
// Runs in the MAIN world (page context). Has direct access to window.fchatCore and Vue state.

// Global activity and rate-limiting variables
let lastUserMessageSentTime = 0;
let lastQueuePostTime = 0;
let disconnectStartTime = 0;
let lastHeartbeatTime = 0;
let connectionHooked = false;
let queueTimer = null;

function logDiag(msg) {
    console.log("F-Chat AutoPoster: " + msg);
    sendToIsolated({
        action: 'DIAG_LOG',
        message: msg
    });
}

// Hook window.WebSocket to intercept user messaging and ad transmissions
(function interceptWebSocket() {
    try {
        const OriginalWebSocket = window.WebSocket;
        if (!OriginalWebSocket || OriginalWebSocket.__autoposterHooked) return;

        const HookedWebSocket = function(url, protocols) {
            logDiag("WebSocket constructor intercepted. URL=" + url);
            const socket = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
            
            // Immediately shut off autoposting if WebSocket closes (e.g. user logs out)
            socket.addEventListener('close', () => {
                logDiag("WebSocket closed (logged out or disconnected). Auto-disabling immediately.");
                disableAutoPostingOnDisconnect();
            });

            const originalSend = socket.send;
            socket.send = function(data) {
                if (typeof data === 'string') {
                    // Extract command word (first 3 chars) for privacy and rate limiting check
                    const spaceIdx = data.indexOf(' ');
                    const command = spaceIdx !== -1 ? data.substring(0, spaceIdx) : data;
                    
                    if (command === 'LRP') {
                        // Extension or manual advertisement sent
                        lastQueuePostTime = Date.now();
                        scheduleNextQueueCheck();
                    } else if (command === 'MSG' || command === 'PRI' || command === 'RLL') {
                        const now = Date.now();
                        const msSinceLastAd = now - lastQueuePostTime;
                        
                        // Check if an ad was sent by the extension in less than 1 second (with 50ms buffer)
                        if (msSinceLastAd < 1050) {
                            const delayMs = 1050 - msSinceLastAd;
                            logDiag(`Rate-limit threat! Ad sent ${msSinceLastAd}ms ago. Delaying user message (${command}) by ${delayMs}ms.`);
                            setTimeout(() => {
                                if (socket.readyState === OriginalWebSocket.OPEN) {
                                    originalSend.call(socket, data);
                                    lastUserMessageSentTime = Date.now();
                                    logDiag(`Delayed user message (${command}) dispatched. lastUserMessageSentTime updated.`);
                                    scheduleNextQueueCheck();
                                }
                            }, delayMs);
                            return;
                        }
                        
                        lastUserMessageSentTime = now;
                        logDiag(`User sent message (${command}) successfully. Rate-limit clear.`);
                        scheduleNextQueueCheck();
                    }
                }
                return originalSend.apply(this, arguments);
            };
            
            return socket;
        };

        // Preserve constants and prototype chain
        Object.assign(HookedWebSocket, OriginalWebSocket);
        HookedWebSocket.prototype = OriginalWebSocket.prototype;
        HookedWebSocket.__autoposterHooked = true;
        
        window.WebSocket = HookedWebSocket;
        logDiag("window.WebSocket successfully hooked.");
    } catch (e) {
        console.error("F-Chat AutoPoster: Failed to hook window.WebSocket:", e);
    }
})();

// Helper to find the root Vue instance by scanning DOM elements
function findVueRoot() {
    // 1. Try default element
    const appEl = document.getElementById('app');
    if (appEl && appEl.__vue__) return appEl.__vue__;
    
    // 2. Try body children
    for (const child of document.body.children) {
        if (child.__vue__) {
            let inst = child.__vue__;
            while (inst.$parent) inst = inst.$parent;
            return inst;
        }
    }
    
    // 3. Try common F-Chat container elements
    const commonSelectors = ['#chatView', '.conversation-nav', '#sidebar', '.app-container', '#app'];
    for (const selector of commonSelectors) {
        const el = document.querySelector(selector);
        if (el && el.__vue__) {
            let inst = el.__vue__;
            while (inst.$parent) inst = inst.$parent;
            return inst;
        }
    }
    
    // 4. Fallback: Search all elements in body (first 300)
    const elements = document.body.getElementsByTagName('*');
    for (let i = 0; i < elements.length && i < 300; i++) {
        if (elements[i].__vue__) {
            let inst = elements[i].__vue__;
            while (inst.$parent) inst = inst.$parent;
            return inst;
        }
    }
    return null;
}

// Helper to retrieve F-Chat conversations
function getFchatConversations() {
    if (window.fchatCore && window.fchatCore.conversations) {
        return window.fchatCore.conversations;
    }
    
    const root = findVueRoot();
    if (!root) return null;
    
    // Search children recursively for the conversations state object.
    // We check for the presence of channelConversations to verify we have found 
    // the actual core conversations state, and not a child view (like Logs.vue) 
    // that uses a local array named conversations.
    function searchVue(inst) {
        if (!inst) return null;
        if (inst.conversations && inst.conversations.channelConversations) {
            return inst.conversations;
        }
        if (inst.$children) {
            for (const child of inst.$children) {
                const res = searchVue(child);
                if (res) return res;
            }
        }
        return null;
    }
    return searchVue(root);
}

// Helper to retrieve a mock or direct core object
function getFchatCore() {
    const conversations = getFchatConversations();
    if (conversations) {
        return { 
            conversations: conversations,
            connection: window.fchatCore ? window.fchatCore.connection : null
        };
    }
    return null;
}

// Check if F-Chat is active and connected
function isFchatConnected() {
    const root = findVueRoot();
    if (!root) return false;
    
    // In Chat.vue, there is a boolean `connected` property
    if (root.connected !== undefined) {
        return !!root.connected;
    }
    
    // Fallback: check if conversations exist and have joined channels
    const conversations = getFchatConversations();
    if (conversations && conversations.channelConversations && conversations.channelConversations.length > 0) {
        return true;
    }
    
    return false;
}

// Scheduler state variables
let isAutoPosting = false;
let selectedChannels = []; // Array of channel IDs
let adText = '';
let postDelay = 1000; // 1 second stagger between postings
let lastPostedTime = {}; // channelId -> timestamp
let postingQueue = [];
// Timestamp of the last post from the queue
let isCurrentlySending = false; // Guard to prevent overlapping sends

// Helper to send messages back to the isolated content script
function sendToIsolated(message) {
    window.postMessage({
        source: 'fchat-autoposter-main',
        message: message
    }, '*');
}

// Listen for commands from the extension (relayed by content-isolated.js)
window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'fchat-autoposter-isolated') {
        const cmd = event.data.message;
        
        try {
            switch (cmd.action) {
                case 'GET_CHANNELS':
                    sendChannelsList();
                    break;
                
                case 'UPDATE_SETTINGS':
                    isAutoPosting = cmd.settings.active;
                    selectedChannels = cmd.settings.channels || [];
                    adText = cmd.settings.adText || '';
                    postDelay = Math.max(1000, (cmd.settings.postDelay || 1) * 1000);
                    if (isAutoPosting) {
                        scheduleNextQueueCheck();
                    } else {
                        postingQueue = [];
                        if (queueTimer !== null) {
                            clearTimeout(queueTimer);
                            queueTimer = null;
                        }
                    }
                    break;
                    
                case 'TEST_POST':
                    executeTestPost(cmd.channelId, cmd.adText);
                    break;
                    
                case 'SCHEDULER_TICK':
                    receivedFirstTick = true;
                    if (fallbackInterval) {
                        clearInterval(fallbackInterval);
                        fallbackInterval = null;
                    }
                    handleSchedulerTick();
                    break;
            }
        } catch (e) {
            console.error("F-Chat AutoPoster: Message listener error:", e);
            sendToIsolated({
                action: 'CHANNELS_LIST',
                success: false,
                error: 'Internal Error: ' + e.message
            });
        }
    }
});

// Compile and send the current channel list and states
function sendChannelsList() {
    try {
        const isConnected = isFchatConnected();
        const core = getFchatCore();
        
        if (!isConnected || !core || !core.conversations) {
            sendToIsolated({
                action: 'CHANNELS_LIST',
                success: false,
                error: 'Please log in to F-Chat first.'
            });
            return;
        }
        
        const list = core.conversations.channelConversations.map(c => {
            if (!c) return null;
            
            const channelId = c.channel ? c.channel.id : (c.key || '');
            const channelName = c.channel ? c.channel.name : (c.name || 'Unknown');
            
            // A channel is ad capable if its mode allows ads
            const isAdCapable = c.isSendingAds || (c.channel && (c.channel.mode === 'ads' || c.channel.mode === 'both'));
            
            let nextAdVal = c.nextAd;
            if (typeof nextAdVal !== 'number') nextAdVal = 0;
            
            const cooldownRemaining = Math.max(0, Math.ceil((nextAdVal - Date.now()) / 1000));
            
            return {
                id: channelId,
                name: channelName,
                isAdCapable: !!isAdCapable,
                nextAd: nextAdVal,
                cooldownRemaining: cooldownRemaining
            };
        }).filter(Boolean);
        
        sendToIsolated({
            action: 'CHANNELS_LIST',
            success: true,
            channels: list
        });
    } catch (e) {
        console.error("F-Chat AutoPoster: Failed to compile channels list:", e);
        sendToIsolated({
            action: 'CHANNELS_LIST',
            success: false,
            error: 'Scan Error: ' + e.message
        });
    }
}

// Immediately post an ad for testing
async function executeTestPost(channelId, text) {
    try {
        const isConnected = isFchatConnected();
        const core = getFchatCore();
        if (!isConnected || !core || !core.conversations) {
            sendToIsolated({ action: 'TEST_RESULT', success: false, error: 'Please log in to F-Chat first.' });
            return;
        }
        
        const conv = core.conversations.channelConversations.find(c => {
            const cId = c.channel ? c.channel.id : c.key;
            return cId === channelId;
        });
        
        if (!conv) {
            sendToIsolated({ action: 'TEST_RESULT', success: false, error: 'Channel conversation tab not open.' });
            return;
        }
        
        // Save original settings
        const originalText = conv.enteredText;
        const originalIsSendingAds = conv.isSendingAds;
        const originalNextAd = conv.nextAd;
        
        let nextAdVal = conv.nextAd;
        if (typeof nextAdVal === 'number' && nextAdVal > 0) {
            const now = Date.now();
            if (now < nextAdVal + 1000) {
                const waitSec = Math.ceil((nextAdVal + 1000 - now) / 1000);
                sendToIsolated({ action: 'TEST_RESULT', success: false, error: `Channel is still on cooldown. Please wait ${waitSec}s.` });
                return;
            }
        }
        
        // Override settings to force advertisement send
        conv.isSendingAds = true;
        conv.enteredText = text;
        conv.nextAd = 0; // Temporarily bypass local client rate-limit
        
        try {
            await conv.send();
            const channelName = conv.channel ? conv.channel.name : conv.name;
            sendToIsolated({ action: 'TEST_RESULT', success: true, channelName: channelName });
            // Sync channels list immediately so the UI reflects the new cooldown immediately!
            sendChannelsList();
        } catch (e) {
            sendToIsolated({ action: 'TEST_RESULT', success: false, error: e.message || 'Send error' });
        } finally {
            // Restore properties (nextAd will be overwritten automatically by F-Chat with a new timestamp)
            conv.isSendingAds = originalIsSendingAds;
        }
    } catch (e) {
        console.error("F-Chat AutoPoster: Test post execution error:", e);
        sendToIsolated({ action: 'TEST_RESULT', success: false, error: 'Execution Error: ' + e.message });
    }
}

// Rate limiting, user typing detection, and disconnect tracking variables

function disableAutoPostingOnDisconnect() {
    if (!isAutoPosting) return;
    isAutoPosting = false;
    disconnectStartTime = 0;
    postingQueue = [];
    if (queueTimer !== null) {
        clearTimeout(queueTimer);
        queueTimer = null;
    }
    logDiag("Triggering FORCE_DISABLE_AUTOPOST message relay...");
    sendToIsolated({
        action: 'FORCE_DISABLE_AUTOPOST'
    });
}

// Hook F-Chat client's connection.send and closed event to intercept manual messages and logout
function hookConnection() {
    try {
        const core = getFchatCore();
        if (core && core.connection && !core.connection.__autoposterHooked) {
            const originalSend = core.connection.send;
            core.connection.send = function(command, data) {
                // Intercept MSG (channel messages), PRI (private messages), and RLL (dice rolls)
                if (command === 'MSG' || command === 'PRI' || command === 'RLL') {
                    lastUserMessageSentTime = Date.now();
                    logDiag(`Intercepted connection.send(${command}) from client framework.`);
                    scheduleNextQueueCheck();
                } else if (command === 'LRP') {
                    lastQueuePostTime = Date.now();
                    scheduleNextQueueCheck();
                }
                return originalSend.apply(this, arguments);
            };
            
            if (typeof core.connection.onEvent === 'function') {
                core.connection.onEvent('closed', () => {
                    logDiag("Connection closed event from client framework. Auto-disabling immediately.");
                    disableAutoPostingOnDisconnect();
                });
            }
            
            core.connection.__autoposterHooked = true;
            logDiag("fchatCore connection.send successfully hooked.");
        }
    } catch (e) {
        logDiag("Error hooking connection.send: " + e.message);
    }
}

// High-precision queue scheduling functions
function scheduleTimer(delayMs) {
    if (queueTimer !== null) {
        clearTimeout(queueTimer);
        queueTimer = null;
    }
    queueTimer = setTimeout(() => {
        queueTimer = null;
        processPostingQueue();
    }, Math.max(0, delayMs));
}

function scheduleNextQueueCheck() {
    if (!isAutoPosting || postingQueue.length === 0 || isCurrentlySending) return;
    processPostingQueue();
}

// Core queue processor
function processPostingQueue() {
    if (!isAutoPosting || postingQueue.length === 0 || isCurrentlySending) {
        return;
    }
    
    const now = Date.now();
    const msSinceLastAd = now - lastQueuePostTime;
    const msSinceLastUserMsg = now - lastUserMessageSentTime;
    
    // 1. Must satisfy postDelay (e.g. exactly 1000ms) since the previous ad
    const adDelayRemaining = Math.max(0, postDelay - msSinceLastAd);
    
    // 2. Must satisfy 1050ms since the user's last message anywhere to avoid "wait 1 second" error
    const userMsgDelayRemaining = Math.max(0, 1050 - msSinceLastUserMsg);
    
    // 3. Must satisfy at least 1 second (1050ms) after the target channel's 10-minute cooldown ends
    let channelCooldownRemaining = 0;
    const nextChannelId = postingQueue[0];
    const core = getFchatCore();
    if (core && core.conversations) {
        const conv = core.conversations.channelConversations.find(c => {
            const cId = c.channel ? c.channel.id : c.key;
            return cId === nextChannelId;
        });
        if (conv) {
            let nextAdVal = conv.nextAd;
            if (typeof nextAdVal === 'number' && nextAdVal > 0) {
                channelCooldownRemaining = Math.max(0, (nextAdVal + 1050) - now);
            }
        }
    }
    
    const waitRemaining = Math.max(adDelayRemaining, userMsgDelayRemaining, channelCooldownRemaining);
    
    if (waitRemaining > 0) {
        // Not ready yet. Schedule timer for the exact remaining duration
        scheduleTimer(waitRemaining);
        return;
    }
    
    if (queueTimer !== null) {
        clearTimeout(queueTimer);
        queueTimer = null;
    }
    
    const nextChannelIdToSend = postingQueue.shift();
    sendAdToChannel(nextChannelIdToSend);
}

// Scheduler tick logic (executed every 50ms by the background worker, or 100ms fallback)
let totalTicks = 0;
function handleSchedulerTick() {
    try {
        if (!isAutoPosting) {
            postingQueue = [];
            return;
        }
        
        totalTicks++;
        const now = Date.now();
        if (now - lastHeartbeatTime >= 15000) {
            lastHeartbeatTime = now;
            logDiag(`Scheduler heartbeat: active=true, tickCount=${totalTicks}, queueSize=${postingQueue.length}, connected=${isFchatConnected()}`);
        }
        
        // If F-Chat is disconnected for 5 continuous seconds, disable auto-posting
        if (!isFchatConnected()) {
            if (!disconnectStartTime) {
                disconnectStartTime = now;
            } else if (now - disconnectStartTime >= 5000) {
                logDiag("Disconnected for 5 continuous seconds. Auto-disabling.");
                disableAutoPostingOnDisconnect();
                return;
            }
            return;
        } else {
            disconnectStartTime = 0;
        }
        
        const core = getFchatCore();
        if (!core || !core.conversations) return;
        
        // Ensure connection is hooked
        hookConnection();
        
        const channels = core.conversations.channelConversations;
        let queueModified = false;
        
        // 1. Scan and queue any channels whose native cooldown has expired plus at least 1 second buffer
        for (const conv of channels) {
            if (!conv) continue;
            const id = conv.channel ? conv.channel.id : conv.key;
            
            // Is it selected for auto-posting?
            if (!selectedChannels.includes(id)) continue;
            
            // Has the channel's native cooldown expired (+1s buffer)?
            let nextAdVal = conv.nextAd;
            if (typeof nextAdVal !== 'number') nextAdVal = 0;
            if (nextAdVal > 0 && now < nextAdVal + 1050) continue;
            
            // Is it already queued?
            if (postingQueue.includes(id)) continue;
            
            // Add to queue
            postingQueue.push(id);
            queueModified = true;
            logDiag(`Channel #${id} cooldown expired (+1s buffer). Added to queue. Queue=[${postingQueue.join(', ')}]`);
        }
        
        // 2. Process queue if items were added or ready
        if (queueModified || (postingQueue.length > 0 && !isCurrentlySending)) {
            processPostingQueue();
        }
    } catch (e) {
        logDiag("Scheduler tick error: " + e.message);
    }
}

let receivedFirstTick = false;
let fallbackInterval = null;

// Initialize scheduler. Prepares ticks relayed from the Web Worker running
// in the isolated world (to bypass CSP and avoid console errors).
function initScheduler() {
    setTimeout(() => {
        if (!receivedFirstTick && !fallbackInterval) {
            console.warn("F-Chat AutoPoster: No tick received from isolated scheduler. Falling back to standard setInterval.");
            fallbackInterval = setInterval(handleSchedulerTick, 100);
        }
    }, 2500);
}

initScheduler();

// Send the advertisement text to a specific channel
async function sendAdToChannel(channelId) {
    isCurrentlySending = true;
    const now = Date.now();
    lastQueuePostTime = now;
    logDiag(`Initiating ad posting to channel: #${channelId}`);
    
    try {
        const core = getFchatCore();
        if (!core || !core.conversations) {
            logDiag("Failed to send ad: core or conversations is null.");
            return;
        }
        
        const conv = core.conversations.channelConversations.find(c => {
            const cId = c.channel ? c.channel.id : c.key;
            return cId === channelId;
        });
        
        if (conv) {
            let nextAdVal = conv.nextAd;
            if (typeof nextAdVal !== 'number') nextAdVal = 0;
            
            // Ensure at least 1 second (1000ms) has passed since the timer ended
            if (nextAdVal === 0 || now >= nextAdVal + 1000) {
                const originalIsSendingAds = conv.isSendingAds;
                try {
                    conv.isSendingAds = true;
                    conv.enteredText = adText;
                    await conv.send();
                    lastPostedTime[channelId] = Date.now();
                    logDiag(`Ad successfully posted to #${channelId}. Next ad cooldown set to: ${conv.nextAd}`);
                } catch (e) {
                    logDiag(`Error sending ad to #${channelId}: ` + (e.message || e));
                } finally {
                    conv.isSendingAds = originalIsSendingAds;
                }
            } else {
                logDiag(`Post aborted: #${channelId} is not ready yet (nextAd=${nextAdVal} + 1000ms buffer, now=${now})`);
            }
        } else {
            logDiag(`Failed to post: Channel #${channelId} tab not found.`);
        }
    } catch (e) {
        logDiag(`Ad posting execution crash on #${channelId}: ` + e.message);
    } finally {
        isCurrentlySending = false;
        scheduleNextQueueCheck();
    }
}

// Periodically sync channel states (e.g. current countdowns) with the popup
setInterval(() => {
    try {
        if (isFchatConnected()) {
            sendChannelsList();
        }
    } catch (e) {
        console.error("F-Chat AutoPoster: Sync tick error:", e);
    }
}, 1000);
