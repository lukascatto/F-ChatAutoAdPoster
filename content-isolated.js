// content-isolated.js
// Bridges the popup (extension sandbox) with the page context (MAIN world script)

// Listen for messages from the extension popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Forward message to the MAIN world (content-main.js)
    window.postMessage({
        source: 'fchat-autoposter-isolated',
        message: message
    }, '*');
    
    // Acknowledge receipt immediately. This resolves the chrome.tabs.sendMessage promise
    // and prevents "port closed before a response was received" errors.
    sendResponse({ status: 'relayed' });
    return false; // Do not keep the channel open since we send results asynchronously
});

// Listen for responses/updates from the MAIN world (content-main.js) and scheduler iframe
window.addEventListener('message', (event) => {
    // 1. Relays to background/popup and handles internal extension actions
    if (event.data && event.data.source === 'fchat-autoposter-main') {
        const msg = event.data.message;
        if (msg && msg.action === 'FORCE_DISABLE_AUTOPOST') {
            try {
                chrome.storage.local.set({ active: false });
            } catch (err) {
                // Context invalidated or storage error
            }
            return;
        }
        
        try {
            // Verify context is still valid before communicating
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
                chrome.runtime.sendMessage(event.data.message).catch(err => {
                    // Silence errors when the popup is closed
                });
            }
        } catch (err) {
            // Silence "Extension context invalidated" errors after extension reloads
        }
    }

    // 2. Relays scheduler ticks from the extension iframe securely
    if (event.data && event.data.source === 'fchat-autoposter-iframe') {
        try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
                const expectedOrigin = chrome.runtime.getURL('').slice(0, -1);
                if (event.origin === expectedOrigin && event.data.action === 'SCHEDULER_TICK') {
                    window.postMessage({
                        source: 'fchat-autoposter-isolated',
                        message: { action: 'SCHEDULER_TICK' }
                    }, '*');
                }
            }
        } catch (e) {
            // Context invalidated
        }
    }
});

// Create hidden iframe running in extension context to spawn CSP-exempt worker
function initIframeScheduler() {
    try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
        
        const iframe = document.createElement('iframe');
        iframe.src = chrome.runtime.getURL('scheduler-iframe.html');
        iframe.style.display = 'none';
        
        if (document.body) {
            document.body.appendChild(iframe);
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                document.body.appendChild(iframe);
            });
        }
    } catch (e) {
        console.warn("F-Chat AutoPoster: Failed to create scheduler iframe:", e);
    }
}

// Initialize the scheduler iframe
initIframeScheduler();
