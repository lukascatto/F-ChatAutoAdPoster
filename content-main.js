// content-main.js
// Runs in the MAIN world (page context). Has direct access to window.fchatCore and Vue state.

// Global activity and rate-limiting variables
let lastUserMessageSentTime = 0;
let lastQueuePostTime = 0;
let lastTypingTime = 0;
let disconnectTicks = 0;
let connectionHooked = false;

// Hook window.WebSocket to intercept user messaging on any live F-Chat client
(function interceptWebSocket() {
    try {
        const OriginalWebSocket = window.WebSocket;
        if (!OriginalWebSocket || OriginalWebSocket.__autoposterHooked) return;

        const HookedWebSocket = function(url, protocols) {
            const socket = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
            
            const originalSend = socket.send;
            socket.send = function(data) {
                if (typeof data === 'string') {
                    // Extract command word (first 3 chars) for privacy and rate limiting check
                    const spaceIdx = data.indexOf(' ');
                    const command = spaceIdx !== -1 ? data.substring(0, spaceIdx) : data;
                    
                    if (command === 'MSG' || command === 'PRI') {
                        lastUserMessageSentTime = Date.now();
                        
                        // Check if an ad was sent by the extension very recently
                        const msSinceLastAd = Date.now() - lastQueuePostTime;
                        if (msSinceLastAd < 1050) {
                            const delayMs = 1050 - msSinceLastAd;
                            console.log(`F-Chat AutoPoster (Socket Intercept): Ad was sent ${msSinceLastAd}ms ago. Delaying user message by ${delayMs}ms to prevent error.`);
                            setTimeout(() => {
                                if (socket.readyState === OriginalWebSocket.OPEN) {
                                    originalSend.call(socket, data);
                                }
                            }, delayMs);
                            return;
                        }
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
        console.log("F-Chat AutoPoster: Successfully hooked window.WebSocket for live traffic interception.");
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
    if (root.connected !== undefined && root.connected) {
        return true;
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
                    postDelay = (cmd.settings.postDelay || 1) * 1000;
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
            
            const delayOffset = isAutoPosting ? postDelay : 0;
            const cooldownRemaining = Math.max(0, Math.ceil((nextAdVal + delayOffset - Date.now()) / 1000));
            
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
    isAutoPosting = false;
    disconnectTicks = 0;
    sendToIsolated({
        action: 'FORCE_DISABLE_AUTOPOST'
    });
}

// Track active typing in any textbox or textarea in the page
document.addEventListener('input', (e) => {
    const target = e.target;
    if (target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type === 'text'))) {
        if (target.value && target.value.trim().length > 0) {
            lastTypingTime = Date.now();
        }
    }
}, true);

// Check if user is currently focused on an input element with text
function isUserCurrentlyTyping() {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || (activeEl.tagName === 'INPUT' && activeEl.type === 'text'))) {
        if (activeEl.value && activeEl.value.trim().length > 0) {
            return true;
        }
    }
    return false;
}

// Hook F-Chat client's connection.send function to intercept manual messages
function hookConnection() {
    try {
        const core = getFchatCore();
        if (core && core.connection && !core.connection.__autoposterHooked) {
            const originalSend = core.connection.send;
            core.connection.send = function(command, data) {
                // Intercept MSG (channel messages) and PRI (private messages)
                if (command === 'MSG' || command === 'PRI') {
                    lastUserMessageSentTime = Date.now();
                    console.log(`F-Chat AutoPoster: User sent message (${command}). Delaying ads.`);
                }
                return originalSend.apply(this, arguments);
            };
            core.connection.__autoposterHooked = true;
            console.log("F-Chat AutoPoster: Hooked connection.send to track user chat activity.");
        }
    } catch (e) {
        console.error("F-Chat AutoPoster: Error hooking connection.send:", e);
    }
}

// Scheduler tick logic (executed every second)
function handleSchedulerTick() {
    try {
        if (!isAutoPosting) {
            postingQueue = [];
            return;
        }
        
        // If F-Chat is disconnected for 5 consecutive ticks, disable auto-posting
        if (!isFchatConnected()) {
            disconnectTicks++;
            if (disconnectTicks >= 5) {
                console.log("F-Chat AutoPoster: F-Chat is disconnected. Disabling auto-post mode.");
                disableAutoPostingOnDisconnect();
            }
            return;
        } else {
            disconnectTicks = 0;
        }
        
        const core = getFchatCore();
        if (!core || !core.conversations) return;
        
        // Ensure connection is hooked
        hookConnection();
        
        const now = Date.now();
        const channels = core.conversations.channelConversations;
        
        // 1. Scan and queue any channels whose cooldown has expired
        for (const conv of channels) {
            if (!conv) continue;
            const id = conv.channel ? conv.channel.id : conv.key;
            
            // Is it selected for auto-posting?
            if (!selectedChannels.includes(id)) continue;
            
            // Has the local cooldown + post delay expired?
            let nextAdVal = conv.nextAd;
            if (typeof nextAdVal !== 'number') nextAdVal = 0;
            if (now < nextAdVal + postDelay) continue;
            
            // Is it already queued?
            if (postingQueue.includes(id)) continue;
            
            // Add to queue
            postingQueue.push(id);
        }
        
        // 2. Process the queue if we have items and we aren't currently sending an ad
        if (postingQueue.length > 0 && !isCurrentlySending) {
            // Check if stagger delay (postDelay) has elapsed since the last post
            if (now - lastQueuePostTime >= postDelay) {
                // Check if user is active/typing or just sent a message
                const userIsTyping = isUserCurrentlyTyping();
                const msSinceLastTyping = now - lastTypingTime;
                const msSinceLastSent = now - lastUserMessageSentTime;
                
                // Pause ads if:
                // 1. User is actively typing (focused on an input with text)
                // 2. User typed something in the last 4 seconds (handles brief pauses)
                // 3. User sent a message in the last 1.5 seconds (prevents rate limit clashes)
                const shouldPauseForUser = userIsTyping || (msSinceLastTyping < 4000) || (msSinceLastSent < 1500);
                
                if (shouldPauseForUser) {
                    // Postpone queue execution during this tick
                    return;
                }
                
                const nextChannelId = postingQueue.shift();
                sendAdToChannel(nextChannelId);
            }
        }
    } catch (e) {
        console.error("F-Chat AutoPoster: Scheduler tick error:", e);
    }
}

let receivedFirstTick = false;
let fallbackInterval = null;

// Initialize scheduler. It prefers ticks relayed from the Web Worker running
// in the isolated world (to bypass CSP and avoid console errors).
function initScheduler() {
    // Wait up to 2.5 seconds for a tick from the isolated world Web Worker.
    // If none arrives (e.g. extension was reloaded or worker failed), fall back to standard setInterval.
    setTimeout(() => {
        if (!receivedFirstTick && !fallbackInterval) {
            console.warn("F-Chat AutoPoster: No tick received from isolated scheduler. Falling back to standard setInterval.");
            fallbackInterval = setInterval(handleSchedulerTick, 1000);
        }
    }, 2500);
}

initScheduler();

// Send the advertisement text to a specific channel
async function sendAdToChannel(channelId) {
    isCurrentlySending = true;
    const now = Date.now();
    lastQueuePostTime = now; // Mark the time we initiated the post
    
    try {
        const core = getFchatCore();
        if (!core || !core.conversations) return;
        
        const conv = core.conversations.channelConversations.find(c => {
            const cId = c.channel ? c.channel.id : c.key;
            return cId === channelId;
        });
        
        if (conv) {
            let nextAdVal = conv.nextAd;
            if (typeof nextAdVal !== 'number') nextAdVal = 0;
            
            // Verify again that it is actually ready (safety check)
            if (now >= nextAdVal) {
                const originalIsSendingAds = conv.isSendingAds;
                try {
                    // Temporarily force isSendingAds to true to ensure F-Chat formats message as ad
                    conv.isSendingAds = true;
                    conv.enteredText = adText;
                    await conv.send();
                    lastPostedTime[channelId] = Date.now();
                    console.log(`F-Chat AutoPoster: Posted ad to channel: ${channelId}`);
                } catch (e) {
                    console.error("F-Chat AutoPoster: Error sending to " + channelId, e);
                } finally {
                    conv.isSendingAds = originalIsSendingAds;
                }
            }
        }
    } catch (e) {
        console.error("F-Chat AutoPoster: Send ad error:", e);
    } finally {
        isCurrentlySending = false;
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
