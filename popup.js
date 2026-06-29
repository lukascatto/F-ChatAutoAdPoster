// popup.js
// Controls the extension popup UI dashboard

let activeTabId = null;
let selectedChannelIds = [];
let isTestMode = false;
let isAutoPostingActive = false;
let countdownInterval = null;
let currentChannelData = [];

// DOM Elements
const channelListContainer = document.getElementById('channel-list');
const channelListEmpty = document.getElementById('channel-list-empty');
const textareaAdContent = document.getElementById('ad-content');
const previewContainer = document.getElementById('preview-container');
const editorContainer = document.getElementById('editor-container');
const previewPane = document.getElementById('bbcode-preview');
const btnPreviewToggle = document.getElementById('btn-preview-toggle');
const inputPostDelay = document.getElementById('post-delay');
const btnToggleActive = document.getElementById('btn-toggle-active');
const toggleTestMode = document.getElementById('toggle-test-mode');
const statusBadge = document.getElementById('status-badge');
const btnRefresh = document.getElementById('btn-refresh');
const btnTest = document.getElementById('btn-test');
const bulkSelectContainer = document.getElementById('bulk-select-container');
const btnSelectAll = document.getElementById('btn-select-all');
const btnDeselectAll = document.getElementById('btn-deselect-all');
const btnExportLogs = document.getElementById('btn-export-logs');

// Diagnostics Logging System
let diagLogs = [];
function logDiag(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    diagLogs.push(line);
    console.log("F-Chat AutoPoster (Diag): " + msg);
    if (diagLogs.length > 200) diagLogs.shift();
}

function exportLogs() {
    logDiag("Exporting diagnostics log file...");
    const systemInfo = [
        "F-Chat Auto-Advertiser Diagnostics Log",
        "=====================================",
        `Generated At: ${new Date().toString()}`,
        `Extension Version: 1.2.1`,
        `User Agent: ${navigator.userAgent}`,
        "",
        "Current Extension State:",
        "-----------------------",
        `Auto-Posting Active: ${isAutoPostingActive}`,
        `Test Mode Active: ${isTestMode}`,
        `Post Delay: ${inputPostDelay.value} seconds`,
        `Selected Target Channels: [${selectedChannelIds.join(', ')}]`,
        `Cached Channels Count: ${currentChannelData.length}`,
        `Active Tab ID Connected: ${activeTabId}`,
        "",
        "Diagnostic Timeline Logs:",
        "------------------------"
    ];
    
    const fileContent = systemInfo.concat(diagLogs).join('\n');
    const blob = new Blob([fileContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `autoposter_diagnostics.txt`;
    a.click();
    URL.revokeObjectURL(url);
    logDiag("Diagnostics log exported successfully.");
}

// BBCode Parser function
function parseBBCode(text) {
    if (!text) return '';
    
    const tokens = [];
    let lastIndex = 0;
    const tagRegex = /\[(\/?[a-zA-Z]+)(?:=([^\]]+))?\]/g;
    let match;
    
    while ((match = tagRegex.exec(text)) !== null) {
        const index = match.index;
        if (index > lastIndex) {
            tokens.push({ type: 'text', value: text.substring(lastIndex, index) });
        }
        
        const rawTag = match[0];
        const tagName = match[1].toLowerCase();
        const param = match[2] || '';
        
        if (tagName.startsWith('/')) {
            tokens.push({
                type: 'close',
                name: tagName.substring(1),
                raw: rawTag
            });
        } else {
            tokens.push({
                type: 'open',
                name: tagName,
                param: param,
                raw: rawTag
            });
        }
        lastIndex = tagRegex.lastIndex;
    }
    
    if (lastIndex < text.length) {
        tokens.push({ type: 'text', value: text.substring(lastIndex) });
    }
    
    const supportedTags = new Set([
        'b', 'i', 'u', 's', 'sub', 'sup', 'color', 
        'user', 'session', 'channel', 'url', 'noparse', 
        'eicon', 'icon'
    ]);
    
    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
    
    let tokenIdx = 0;
    
    function parseNodes(parentTagName = '') {
        const nodes = [];
        
        while (tokenIdx < tokens.length) {
            const token = tokens[tokenIdx];
            
            if (token.type === 'close') {
                if (token.name === parentTagName) {
                    tokenIdx++;
                    return nodes;
                } else {
                    nodes.push({ type: 'text', value: token.raw });
                    tokenIdx++;
                }
            } else if (token.type === 'open') {
                const tagName = token.name;
                
                if (!supportedTags.has(tagName)) {
                    nodes.push({ type: 'text', value: token.raw });
                    tokenIdx++;
                } else if (tagName === 'noparse') {
                    tokenIdx++;
                    let literalText = '';
                    while (tokenIdx < tokens.length) {
                        const nextToken = tokens[tokenIdx];
                        if (nextToken.type === 'close' && nextToken.name === 'noparse') {
                            tokenIdx++;
                            break;
                        }
                        if (nextToken.type === 'text') {
                            literalText += nextToken.value;
                        } else {
                            literalText += nextToken.raw;
                        }
                        tokenIdx++;
                    }
                    nodes.push({ type: 'noparse', content: literalText });
                } else if (tagName === 'eicon' || tagName === 'icon' || tagName === 'user' || tagName === 'session' || tagName === 'channel') {
                    tokenIdx++;
                    let tagContent = '';
                    while (tokenIdx < tokens.length) {
                        const nextToken = tokens[tokenIdx];
                        if (nextToken.type === 'close' && nextToken.name === tagName) {
                            tokenIdx++;
                            break;
                        }
                        if (nextToken.type === 'text') {
                            tagContent += nextToken.value;
                        } else {
                            tagContent += nextToken.raw;
                        }
                        tokenIdx++;
                    }
                    nodes.push({ type: tagName, param: token.param, content: tagContent });
                } else {
                    tokenIdx++;
                    const children = parseNodes(tagName);
                    nodes.push({ type: tagName, param: token.param, children: children });
                }
            } else {
                nodes.push({ type: 'text', value: token.value });
                tokenIdx++;
            }
        }
        
        return nodes;
    }
    
    const rootNodes = parseNodes();
    
    function renderNode(node) {
        if (node.type === 'text') {
            return escapeHtml(node.value).replace(/\r?\n/g, '<br>');
        }
        if (node.type === 'noparse') {
            return escapeHtml(node.content).replace(/\r?\n/g, '<br>');
        }
        
        let childrenHtml = '';
        if (node.children) {
            childrenHtml = node.children.map(renderNode).join('');
        }
        
        switch (node.type) {
            case 'b':
                return `<strong>${childrenHtml}</strong>`;
            case 'i':
                return `<em>${childrenHtml}</em>`;
            case 'u':
                return `<u>${childrenHtml}</u>`;
            case 's':
                return `<del>${childrenHtml}</del>`;
            case 'sub':
                return `<sub>${childrenHtml}</sub>`;
            case 'sup':
                return `<sup>${childrenHtml}</sup>`;
            case 'color':
                const validColors = /^(red|blue|white|yellow|pink|gray|green|orange|purple|black|brown|cyan)$/i;
                const color = node.param.toLowerCase();
                if (validColors.test(color)) {
                    return `<span style="color: ${color}">${childrenHtml}</span>`;
                }
                return `[color=${node.param}]${childrenHtml}[/color]`;
            case 'user':
                const username = node.content.trim();
                const uregex = /^[a-zA-Z0-9_\-\s]+$/;
                if (uregex.test(username)) {
                    return `<a href="https://www.f-list.net/c/${username}" target="_blank" class="preview-user-link">${node.content}</a>`;
                }
                return `[user]${node.content}[/user]`;
            case 'icon':
                const iconCharName = node.content.trim();
                const iregex = /^[a-zA-Z0-9_\-\s]+$/;
                if (iregex.test(iconCharName)) {
                    const avatarUrl = `https://static.f-list.net/images/avatar/${iconCharName.toLowerCase()}.png`;
                    return `<a href="https://www.f-list.net/c/${iconCharName}" target="_blank" title="${iconCharName}"><img src="${avatarUrl}" class="character-avatar icon" alt="${iconCharName}"></a>`;
                }
                return `[icon]${node.content}[/icon]`;
            case 'eicon':
                const eiconName = node.content.trim();
                const eregex = /^[a-zA-Z0-9_\-\s]+$/;
                if (eregex.test(eiconName)) {
                    const eiconUrl = `https://static.f-list.net/images/eicon/${eiconName.toLowerCase()}.gif`;
                    return `<img src="${eiconUrl}" class="character-avatar icon" title="${eiconName}" alt="${eiconName}">`;
                }
                return `[eicon]${node.content}[/eicon]`;
            case 'session':
                const sessionId = node.content.trim();
                const sessionName = node.param.trim() || sessionId;
                return `<span class="preview-session-link" title="${sessionId}">#${sessionName}</span>`;
            case 'channel':
                const channelName = node.content.trim();
                return `<span class="preview-channel-link">#${channelName}</span>`;
            case 'url':
                const rawParam = (node.param || '').trim();
                let targetUrl = rawParam || childrenHtml;
                let displayHtml = childrenHtml || rawParam;
                
                if (!rawParam) {
                    // Strip HTML tags from targetUrl if it was generated from childrenHtml
                    targetUrl = targetUrl.replace(/<[^>]*>/g, '');
                }
                targetUrl = targetUrl.trim();
                
                if (!targetUrl) return '';
                
                let absoluteUrl = targetUrl;
                if (!/^(https?|ftp|mailto):/i.test(targetUrl)) {
                    absoluteUrl = 'https://' + targetUrl;
                }
                
                return `<a href="${escapeHtml(absoluteUrl)}" target="_blank">${displayHtml}</a>`;
            default:
                return childrenHtml;
        }
    }
    
    return rootNodes.map(renderNode).join('');
}

// Update the live BBCode preview
function updatePreview() {
    previewPane.innerHTML = parseBBCode(textareaAdContent.value);
}

// Load settings from storage
function loadSettings() {
    logDiag("Loading settings from storage...");
    chrome.storage.local.get({
        adText: '',
        active: false,
        testMode: false,
        channels: [],
        postDelay: 2
    }, (items) => {
        logDiag(`Settings loaded: active=${items.active}, testMode=${items.testMode}, channelsCount=${items.channels.length}, postDelay=${items.postDelay}`);
        textareaAdContent.value = items.adText;
        isAutoPostingActive = items.active;
        toggleTestMode.checked = items.testMode;
        isTestMode = items.testMode;
        selectedChannelIds = items.channels;
        let delay = items.postDelay;
        if (delay < 1) delay = 1;
        inputPostDelay.value = delay;
        
        if (isTestMode) {
            // Keep at most 1 channel selected in test mode
            selectedChannelIds = selectedChannelIds.slice(0, 1);
        }
        
        updateStatusUI(items.active);
        updateTestModeUI();
        updatePreview();
        
        // Connect to active tab
        connectToFchatTab();
    });
}

// Save settings to storage and push updates to the active tab
function saveSettings() {
    // Enforce 1 second minimum stagger delay
    let delay = parseFloat(inputPostDelay.value);
    if (isNaN(delay) || delay < 1) {
        delay = 1;
        inputPostDelay.value = 1;
    }
    
    const settings = {
        adText: textareaAdContent.value,
        active: isAutoPostingActive,
        testMode: isTestMode,
        channels: selectedChannelIds,
        postDelay: delay
    };
    
    chrome.storage.local.set(settings, () => {
        updateStatusUI(settings.active);
        
        // Push settings to the content script
        if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, {
                action: 'UPDATE_SETTINGS',
                settings: settings
            }).catch(() => {});
        }
    });
}

// Update active indicator badge and toggle button state
function updateStatusUI(active) {
    isAutoPostingActive = active;
    if (active) {
        statusBadge.textContent = 'Active';
        statusBadge.classList.add('active');
        btnToggleActive.textContent = 'Stop Autoposting';
        btnToggleActive.classList.add('btn-active');
        btnToggleActive.classList.remove('btn-primary');
        btnToggleActive.title = 'Stop background auto-posting';
    } else {
        statusBadge.textContent = 'Inactive';
        statusBadge.classList.remove('active');
        btnToggleActive.textContent = 'Start Autoposting';
        btnToggleActive.classList.add('btn-primary');
        btnToggleActive.classList.remove('btn-active');
        btnToggleActive.title = 'Start background auto-posting';
    }
}

// Update UI Layout based on Test Mode toggle state
function updateTestModeUI() {
    if (isTestMode) {
        bulkSelectContainer.classList.add('hidden');
        btnTest.classList.remove('hidden');
        btnToggleActive.classList.add('hidden');
    } else {
        bulkSelectContainer.classList.remove('hidden');
        btnTest.classList.add('hidden');
        btnToggleActive.classList.remove('hidden');
    }
}

// Update the Test Ad button state (disabled/enabled) based on selection and cooldowns
function updateTestButtonState() {
    if (!isTestMode) return;
    
    const checkedRadio = channelListContainer.querySelector('input[type="radio"]:checked');
    if (!checkedRadio) {
        btnTest.disabled = true;
        btnTest.title = 'Please select exactly one channel to perform a test.';
        return;
    }
    
    const chId = checkedRadio.getAttribute('data-id');
    const ch = currentChannelData.find(c => c.id === chId);
    const isCooldown = ch && ch.cooldownRemaining > 0;
    
    if (isCooldown) {
        btnTest.disabled = true;
        btnTest.title = 'Selected channel is currently on cooldown.';
    } else {
        btnTest.disabled = false;
        btnTest.title = 'Post to the single selected channel immediately to test settings';
    }
}

function isFchatUrl(url) {
    if (!url) return false;
    return url.includes('f-list.net/chat') || url.includes('f-list.net/chat3') || url.includes('localhost');
}

// Find F-Chat tab and request current channels list
function connectToFchatTab() {
    logDiag("connectToFchatTab() called. Querying active tab...");
    channelListEmpty.textContent = 'Loading...';
    channelListEmpty.classList.remove('hidden');
    channelListContainer.classList.add('hidden');

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs.length > 0 && isFchatUrl(tabs[0].url)) {
            activeTabId = tabs[0].id;
            logDiag(`Active tab is F-Chat. ID=${activeTabId}. Requesting channels list...`);
            requestChannels();
        } else {
            logDiag("Active tab is not F-Chat. Scanning background tabs...");
            // Active tab is not F-Chat, scan all tabs to find F-Chat in background
            chrome.tabs.query({}, (allTabs) => {
                if (allTabs && allTabs.length > 0) {
                    const fchatTab = allTabs.find(t => isFchatUrl(t.url));
                    if (fchatTab) {
                        activeTabId = fchatTab.id;
                        logDiag(`F-Chat background tab found. ID=${activeTabId}. Requesting channels list...`);
                        requestChannels();
                        return;
                    }
                }
                logDiag("No F-Chat tab found in the entire browser.");
                showInfoMessage('F-Chat tab is not selected. Make sure F-Chat is open in your browser.');
            });
        }
    });
}

// Request channel lists from content script
function requestChannels() {
    if (!activeTabId) {
        logDiag("requestChannels() aborted: activeTabId is null.");
        return;
    }
    logDiag(`Requesting channels from active tab ${activeTabId}...`);
    channelListEmpty.textContent = 'Loading...';
    channelListEmpty.classList.remove('hidden');
    channelListContainer.classList.add('hidden');
    
    chrome.tabs.sendMessage(activeTabId, { action: 'GET_CHANNELS' })
        .catch((err) => {
            logDiag("Failed to send GET_CHANNELS message: " + (err.message || err));
            showInfoMessage('Unable to connect to tab. Refresh the F-Chat webpage and try again.');
        });
}

// Display messages inside the channel list container
function showInfoMessage(msg) {
    channelListEmpty.textContent = msg;
    channelListEmpty.classList.remove('hidden');
    channelListContainer.classList.add('hidden');
}

// Render channel rows in the checkbox list
// Local countdown timer in popup
function startLocalCountdown() {
    if (countdownInterval) return; // Only start one interval
    
    countdownInterval = setInterval(() => {
        let needsReRender = false;
        
        currentChannelData.forEach(ch => {
            if (ch.cooldownRemaining > 0) {
                ch.cooldownRemaining--;
                if (ch.cooldownRemaining === 0) {
                    needsReRender = true;
                } else {
                    // Update badge text in place
                    const item = channelListContainer.querySelector(`.channel-item[data-id="${ch.id}"]`);
                    if (item) {
                        const badge = item.querySelector('.badge-timer');
                        if (badge) {
                            badge.textContent = `Timer: ${ch.cooldownRemaining}s`;
                        }
                    }
                }
            }
        });
        
        if (needsReRender) {
            // Re-render in place to enable checkbox/radio buttons
            renderChannels(currentChannelData);
        }
    }, 1000);
}

// Render channel rows in the checkbox list
function renderChannels(channels) {
    if (!channels || channels.length === 0) {
        showInfoMessage('No joined channels found. Join some channels in F-Chat first.');
        return;
    }
    
    channelListEmpty.classList.add('hidden');
    channelListContainer.classList.remove('hidden');
    
    // Filter out any selected channels that are no longer joined or no longer ad-capable
    let settingsChanged = false;
    selectedChannelIds = selectedChannelIds.filter(id => {
        const ch = channels.find(c => c.id === id);
        if (!ch || !ch.isAdCapable) {
            settingsChanged = true;
            return false;
        }
        return true;
    });
    if (settingsChanged) {
        saveSettings();
    }
    
    currentChannelData = channels;
    
    // Check if we need a full redraw (e.g. different channels or container is empty)
    const existingItems = channelListContainer.querySelectorAll('.channel-item');
    const existingIds = Array.from(existingItems).map(item => item.getAttribute('data-id'));
    const incomingIds = channels.map(ch => ch.id);
    
    const needsFullRedraw = existingItems.length === 0 || 
                            existingIds.length !== incomingIds.length ||
                            !existingIds.every((val, index) => val === incomingIds[index]);
                            
    if (needsFullRedraw) {
        channelListContainer.innerHTML = '';
        channels.forEach(ch => {
            const item = document.createElement('div');
            item.className = 'channel-item';
            item.setAttribute('data-id', ch.id);
            
            const isCooldown = ch.cooldownRemaining > 0;
            const isDisabled = !ch.isAdCapable;
            const isChecked = selectedChannelIds.includes(ch.id);
            
            if (isDisabled) {
                item.classList.add('disabled');
            }
            
            const inputType = isTestMode ? 'radio' : 'checkbox';
            const inputName = isTestMode ? 'test-channel-selection' : '';
            
            item.innerHTML = `
                <label class="channel-item-left">
                    <input type="${inputType}" name="${inputName}" data-id="${ch.id}" ${isChecked ? 'checked' : ''} ${isDisabled ? 'disabled' : ''}>
                    <span class="channel-name">${ch.name}</span>
                </label>
                <div class="channel-item-right">
                    ${!ch.isAdCapable ? 
                        `<span class="channel-status-badge badge-no-ads">No Ads Tab</span>` : 
                        (isCooldown ? `<span class="channel-status-badge badge-timer">Timer: ${ch.cooldownRemaining}s</span>` : '')
                    }
                </div>
            `;
            
            channelListContainer.appendChild(item);
        });
        
        // Add checkbox/radio change event listeners
        const inputs = channelListContainer.querySelectorAll('input');
        inputs.forEach(input => {
            input.addEventListener('change', (e) => {
                const chId = e.target.getAttribute('data-id');
                if (isTestMode) {
                    if (e.target.checked) {
                        selectedChannelIds = [chId];
                    }
                } else {
                    if (e.target.checked) {
                        if (!selectedChannelIds.includes(chId)) {
                            selectedChannelIds.push(chId);
                        }
                    } else {
                        selectedChannelIds = selectedChannelIds.filter(id => id !== chId);
                    }
                }
                saveSettings();
                updateTestButtonState();
            });
        });
    } else {
        // Update existing elements in place (avoids scroll jumps and flickering)
        channels.forEach(ch => {
            const item = channelListContainer.querySelector(`.channel-item[data-id="${ch.id}"]`);
            if (item) {
                const isCooldown = ch.cooldownRemaining > 0;
                const isDisabled = !ch.isAdCapable;
                const isChecked = selectedChannelIds.includes(ch.id);
                
                if (isDisabled) {
                    item.classList.add('disabled');
                } else {
                    item.classList.remove('disabled');
                }
                
                const input = item.querySelector('input');
                if (input) {
                    const expectedType = isTestMode ? 'radio' : 'checkbox';
                    if (input.type !== expectedType) {
                        input.type = expectedType;
                        input.name = isTestMode ? 'test-channel-selection' : '';
                    }
                    input.checked = isChecked;
                    input.disabled = isDisabled;
                }
                
                const rightContainer = item.querySelector('.channel-item-right');
                if (rightContainer) {
                    if (!ch.isAdCapable) {
                        rightContainer.innerHTML = `<span class="channel-status-badge badge-no-ads">No Ads Tab</span>`;
                    } else if (isCooldown) {
                        rightContainer.innerHTML = `<span class="channel-status-badge badge-timer">Timer: ${ch.cooldownRemaining}s</span>`;
                    } else {
                        rightContainer.innerHTML = '';
                    }
                }
            }
        });
    }
    
    updateTestButtonState();
    startLocalCountdown();
}

// Handle messages sent back from content script
chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    
    switch (message.action) {
        case 'CHANNELS_LIST':
            if (message.success) {
                logDiag(`Channels list received. Count=${message.channels.length}`);
                renderChannels(message.channels);
            } else {
                logDiag("Failed to receive channels list: " + message.error);
                showInfoMessage(message.error || 'Connection failed.');
            }
            break;
            
        case 'TEST_RESULT':
            btnTest.textContent = 'Test Ad';
            updateTestButtonState();
            if (message.success) {
                logDiag(`Test ad sent successfully on channel #${message.channelName}`);
                alert(`Test post successful on #${message.channelName}!`);
            } else {
                logDiag("Test ad sending failed: " + message.error);
                alert(`Test post failed: ${message.error}`);
            }
            break;
            
        case 'DIAG_LOG':
            logDiag("[Page Context] " + message.message);
            break;
    }
});

// Event Listeners
btnRefresh.addEventListener('click', requestChannels);

// Shift key tracking to match F-Chat's paste behavior
let isShiftPressed = false;
window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') isShiftPressed = true;
});
window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') isShiftPressed = false;
});
window.addEventListener('blur', () => {
    isShiftPressed = false;
});

// Text area input triggers live preview & saves settings
textareaAdContent.addEventListener('input', () => {
    updatePreview();
    saveSettings();
});

// Paste event listener to automatically wrap links in [url=...]...[/url]
textareaAdContent.addEventListener('paste', (e) => {
    if (isShiftPressed) return; // Allow normal paste if Shift is held (like F-Chat)
    
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;
    
    const pastedText = clipboardData.getData('text/plain');
    if (!pastedText) return;
    
    // URL matching pattern (protocols or starting with www.)
    const isUrl = /^(?:(?:https?|ftps?|irc):\/\/|www\.)[^\s/$.?#"'()]+\.[^\s"()]+/i.test(pastedText.trim());
    
    if (isUrl) {
        e.preventDefault();
        
        const start = textareaAdContent.selectionStart;
        const end = textareaAdContent.selectionEnd;
        const text = textareaAdContent.value;
        const selectedText = text.substring(start, end);
        
        let prefix = `[url=${pastedText.trim()}]`;
        let suffix = `[/url]`;
        let replacement = prefix + selectedText + suffix;
        
        textareaAdContent.value = text.substring(0, start) + replacement + text.substring(end);
        
        if (selectedText.length > 0) {
            textareaAdContent.setSelectionRange(start, start + replacement.length);
        } else {
            textareaAdContent.setSelectionRange(start + prefix.length, start + prefix.length);
        }
        
        // Trigger input event to update preview and save settings
        textareaAdContent.dispatchEvent(new Event('input'));
    }
});

// Setup timing input changes
inputPostDelay.addEventListener('change', saveSettings);

// Toggle Autoposting running state
btnToggleActive.addEventListener('click', () => {
    if (!isAutoPostingActive) {
        // If starting, validate that they have selected at least one channel (if not in test mode)
        if (!isTestMode && selectedChannelIds.length === 0) {
            alert('Please select at least one target channel before starting.');
            return;
        }
        
        // Validate advertisement text is not empty when starting
        if (!textareaAdContent.value.trim()) {
            alert('Please type some advertisement text before starting.');
            return;
        }
    }
    
    isAutoPostingActive = !isAutoPostingActive;
    saveSettings();
});

// Test Mode toggle event listener
toggleTestMode.addEventListener('change', () => {
    isTestMode = toggleTestMode.checked;
    
    // Clean up selections when toggling modes
    if (isTestMode) {
        // Keep only the first checked channel
        selectedChannelIds = selectedChannelIds.slice(0, 1);
    }
    
    updateTestModeUI();
    saveSettings();
    requestChannels(); // Re-render channel list with radios/checkboxes
});

// Select All Channels (Normal Mode)
btnSelectAll.addEventListener('click', () => {
    if (isTestMode) return;
    
    const checkboxes = channelListContainer.querySelectorAll('input[type="checkbox"]:not(:disabled)');
    checkboxes.forEach(cb => {
        cb.checked = true;
        const chId = cb.getAttribute('data-id');
        if (!selectedChannelIds.includes(chId)) {
            selectedChannelIds.push(chId);
        }
    });
    saveSettings();
});

// Deselect All Channels (Normal Mode)
btnDeselectAll.addEventListener('click', () => {
    if (isTestMode) return;
    
    const checkboxes = channelListContainer.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.checked = false;
    });
    selectedChannelIds = [];
    saveSettings();
});

// Test posting function
btnTest.addEventListener('click', () => {
    // Collect the checked radio button
    const checkedRadio = channelListContainer.querySelector('input[type="radio"]:checked');
    
    if (!checkedRadio) {
        alert('Please select exactly one channel in the list above to perform a test.');
        return;
    }
    
    const channelId = checkedRadio.getAttribute('data-id');
    const ch = currentChannelData.find(c => c.id === channelId);
    const isCooldown = ch && ch.cooldownRemaining > 0;
    if (isCooldown) {
        alert('This channel is currently on cooldown. Please wait until the timer runs out before testing again.');
        return;
    }
    
    const adText = textareaAdContent.value;
    
    if (!adText.trim()) {
        alert('Please type some advertisement text first.');
        return;
    }
    
    // Disable button to prevent double-clicks
    btnTest.disabled = true;
    btnTest.textContent = 'Testing...';
    
    if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, {
            action: 'TEST_POST',
            channelId: channelId,
            adText: adText
        }).catch(() => {
            alert('Failed to send test command to F-Chat tab.');
            btnTest.disabled = false;
            btnTest.textContent = 'Test Ad';
            updateTestButtonState();
        });
    }
});

// Toggle preview mode
btnPreviewToggle.addEventListener('click', () => {
    if (previewContainer.classList.contains('hidden')) {
        previewContainer.classList.remove('hidden');
        editorContainer.classList.add('hidden');
        btnPreviewToggle.textContent = 'Edit Code';
        updatePreview();
    } else {
        previewContainer.classList.add('hidden');
        editorContainer.classList.remove('hidden');
        btnPreviewToggle.textContent = 'Show Preview';
    }
});

// Update UI if storage settings are changed externally (e.g. forced disable on disconnect)
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.active) {
        isAutoPostingActive = changes.active.newValue;
        logDiag(`Storage changed externally: active=${isAutoPostingActive}`);
        updateStatusUI(isAutoPostingActive);
        updateTestModeUI();
    }
});

// Bind export logs button action
btnExportLogs.addEventListener('click', exportLogs);

// Run load on popup initialization
document.addEventListener('DOMContentLoaded', loadSettings);
