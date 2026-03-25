/**
 * Aurora — BorealisMark AI Support Chat Widget
 *
 * Drop-in chat bubble that connects to the /v1/support/chat API.
 * Self-contained: no dependencies, includes all CSS inline.
 *
 * Usage: <script src="https://borealismark-api.onrender.com/aurora-widget.js"></script>
 *
 * The widget auto-initializes on DOMContentLoaded.
 */
(function() {
  'use strict';

  const API_URL = 'https://borealismark-api.onrender.com/v1/support/chat';
  const SESSION_KEY = 'aurora_session_id';

  // Generate or retrieve session ID
  function getSessionId() {
    let sid = null;
    try { sid = sessionStorage.getItem(SESSION_KEY); } catch(e) {}
    if (!sid) {
      sid = 'chat-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { sessionStorage.setItem(SESSION_KEY, sid); } catch(e) {}
    }
    return sid;
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #aurora-widget-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 60px;
        height: 60px;
        border-radius: 50%;
        background: linear-gradient(135deg, #D4A853 0%, #B8912E 100%);
        border: none;
        cursor: pointer;
        box-shadow: 0 4px 20px rgba(212,168,83,0.4);
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s, box-shadow 0.2s;
      }
      #aurora-widget-btn:hover {
        transform: scale(1.08);
        box-shadow: 0 6px 28px rgba(212,168,83,0.5);
      }
      #aurora-widget-btn svg { width: 28px; height: 28px; fill: #0C0D10; }
      #aurora-widget-btn .aurora-badge {
        position: absolute;
        top: -2px;
        right: -2px;
        width: 16px;
        height: 16px;
        background: #22c55e;
        border-radius: 50%;
        border: 2px solid #0C0D10;
      }

      #aurora-chat-panel {
        position: fixed;
        bottom: 96px;
        right: 24px;
        width: 380px;
        max-width: calc(100vw - 48px);
        height: 520px;
        max-height: calc(100vh - 140px);
        background: #12131A;
        border: 1px solid #2A2B33;
        border-radius: 16px;
        z-index: 99998;
        display: none;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 12px 48px rgba(0,0,0,0.5);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      }
      #aurora-chat-panel.aurora-open { display: flex; }

      .aurora-header {
        padding: 16px 20px;
        background: #16171C;
        border-bottom: 1px solid #2A2B33;
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
      }
      .aurora-header-avatar {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: linear-gradient(135deg, #D4A853 0%, #B8912E 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        color: #0C0D10;
        font-size: 14px;
        flex-shrink: 0;
      }
      .aurora-header-info { flex: 1; }
      .aurora-header-name { font-size: 15px; font-weight: 600; color: #fff; }
      .aurora-header-status { font-size: 12px; color: #22c55e; display: flex; align-items: center; gap: 4px; }
      .aurora-header-status::before {
        content: '';
        width: 6px;
        height: 6px;
        background: #22c55e;
        border-radius: 50%;
        display: inline-block;
      }
      .aurora-close-btn {
        background: none;
        border: none;
        color: #666;
        cursor: pointer;
        padding: 4px;
        font-size: 20px;
        line-height: 1;
      }
      .aurora-close-btn:hover { color: #fff; }

      .aurora-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .aurora-messages::-webkit-scrollbar { width: 4px; }
      .aurora-messages::-webkit-scrollbar-track { background: transparent; }
      .aurora-messages::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }

      .aurora-msg {
        max-width: 85%;
        padding: 10px 14px;
        border-radius: 12px;
        font-size: 14px;
        line-height: 1.5;
        word-wrap: break-word;
        white-space: pre-wrap;
      }
      .aurora-msg-bot {
        align-self: flex-start;
        background: #1E1F28;
        color: #d0d0d0;
        border-bottom-left-radius: 4px;
      }
      .aurora-msg-user {
        align-self: flex-end;
        background: linear-gradient(135deg, #D4A853 0%, #B8912E 100%);
        color: #0C0D10;
        border-bottom-right-radius: 4px;
      }
      .aurora-msg-bot a { color: #D4A853; }

      .aurora-typing {
        align-self: flex-start;
        display: none;
        gap: 4px;
        padding: 12px 16px;
        background: #1E1F28;
        border-radius: 12px;
        border-bottom-left-radius: 4px;
      }
      .aurora-typing.active { display: flex; }
      .aurora-typing-dot {
        width: 6px;
        height: 6px;
        background: #666;
        border-radius: 50%;
        animation: auroraBounce 1.4s ease-in-out infinite;
      }
      .aurora-typing-dot:nth-child(2) { animation-delay: 0.2s; }
      .aurora-typing-dot:nth-child(3) { animation-delay: 0.4s; }
      @keyframes auroraBounce {
        0%, 60%, 100% { transform: translateY(0); }
        30% { transform: translateY(-6px); }
      }

      .aurora-input-area {
        padding: 12px 16px;
        background: #16171C;
        border-top: 1px solid #2A2B33;
        display: flex;
        gap: 8px;
        flex-shrink: 0;
      }
      .aurora-input {
        flex: 1;
        background: #0C0D10;
        border: 1px solid #2A2B33;
        border-radius: 8px;
        padding: 10px 14px;
        color: #e0e0e0;
        font-size: 14px;
        font-family: inherit;
        outline: none;
        resize: none;
        max-height: 80px;
      }
      .aurora-input::placeholder { color: #555; }
      .aurora-input:focus { border-color: #D4A853; }
      .aurora-send-btn {
        background: linear-gradient(135deg, #D4A853 0%, #B8912E 100%);
        border: none;
        border-radius: 8px;
        width: 40px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: opacity 0.2s;
      }
      .aurora-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .aurora-send-btn svg { width: 18px; height: 18px; fill: #0C0D10; }

      .aurora-powered {
        text-align: center;
        padding: 6px;
        font-size: 11px;
        color: #444;
        background: #16171C;
      }
      .aurora-powered a { color: #D4A853; text-decoration: none; }

      .aurora-quick-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 16px 12px;
      }
      .aurora-quick-btn {
        background: #1E1F28;
        border: 1px solid #2A2B33;
        color: #aaa;
        padding: 6px 12px;
        border-radius: 16px;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.2s;
      }
      .aurora-quick-btn:hover {
        border-color: #D4A853;
        color: #D4A853;
        background: rgba(212,168,83,0.08);
      }

      @media (max-width: 480px) {
        #aurora-chat-panel {
          bottom: 0;
          right: 0;
          width: 100vw;
          height: 100vh;
          max-height: 100vh;
          border-radius: 0;
        }
        #aurora-widget-btn { bottom: 16px; right: 16px; }
      }
    `;
    document.head.appendChild(style);
  }

  function createWidget() {
    // Floating button
    const btn = document.createElement('button');
    btn.id = 'aurora-widget-btn';
    btn.title = 'Chat with Aurora — AI Support';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/>
        <circle cx="8" cy="10" r="1.2"/>
        <circle cx="12" cy="10" r="1.2"/>
        <circle cx="16" cy="10" r="1.2"/>
      </svg>
      <div class="aurora-badge"></div>
    `;
    document.body.appendChild(btn);

    // Chat panel
    const panel = document.createElement('div');
    panel.id = 'aurora-chat-panel';
    panel.innerHTML = `
      <div class="aurora-header">
        <div class="aurora-header-avatar">A</div>
        <div class="aurora-header-info">
          <div class="aurora-header-name">Aurora</div>
          <div class="aurora-header-status">Online — AI Support</div>
        </div>
        <button class="aurora-close-btn" title="Close">&times;</button>
      </div>
      <div class="aurora-messages" id="aurora-messages">
        <div class="aurora-msg aurora-msg-bot">Hi! I'm Aurora, the BorealisMark AI support assistant. How can I help you today?</div>
      </div>
      <div class="aurora-quick-actions" id="aurora-quick-actions">
        <button class="aurora-quick-btn" data-q="What is BorealisMark?">What is BorealisMark?</button>
        <button class="aurora-quick-btn" data-q="Tell me about pricing and plans">Pricing & Plans</button>
        <button class="aurora-quick-btn" data-q="How do I deploy a bot?">Deploy a Bot</button>
        <button class="aurora-quick-btn" data-q="How does USDC payment work?">USDC Payments</button>
        <button class="aurora-quick-btn" data-q="How do I verify a certificate on Hedera?">Verify Certificate</button>
      </div>
      <div class="aurora-input-area">
        <textarea class="aurora-input" id="aurora-input" placeholder="Ask Aurora anything..." rows="1"></textarea>
        <button class="aurora-send-btn" id="aurora-send" title="Send">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
      <div class="aurora-powered">Powered by <a href="https://borealisprotocol.ai" target="_blank">BorealisMark Protocol</a></div>
    `;
    document.body.appendChild(panel);

    // State
    const sessionId = getSessionId();
    let isOpen = false;
    let isSending = false;

    const messagesEl = panel.querySelector('#aurora-messages');
    const inputEl = panel.querySelector('#aurora-input');
    const sendBtn = panel.querySelector('#aurora-send');
    const closeBtn = panel.querySelector('.aurora-close-btn');
    const quickActions = panel.querySelector('#aurora-quick-actions');

    // Toggle
    function toggle() {
      isOpen = !isOpen;
      panel.classList.toggle('aurora-open', isOpen);
      if (isOpen) {
        inputEl.focus();
        // Hide badge after first open
        const badge = btn.querySelector('.aurora-badge');
        if (badge) badge.style.display = 'none';
      }
    }

    btn.addEventListener('click', toggle);
    closeBtn.addEventListener('click', toggle);

    // Add message to chat
    function addMessage(text, isUser) {
      const div = document.createElement('div');
      div.className = 'aurora-msg ' + (isUser ? 'aurora-msg-user' : 'aurora-msg-bot');

      // Simple markdown-to-HTML for bot messages (bold, links, code)
      if (!isUser) {
        let html = text
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/`(.*?)`/g, '<code style="background:#2A2B33;padding:1px 4px;border-radius:3px;font-size:13px">$1</code>')
          .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        div.innerHTML = html;
      } else {
        div.textContent = text;
      }

      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Show/hide typing indicator
    let typingEl = null;
    function showTyping() {
      if (!typingEl) {
        typingEl = document.createElement('div');
        typingEl.className = 'aurora-typing active';
        typingEl.innerHTML = '<div class="aurora-typing-dot"></div><div class="aurora-typing-dot"></div><div class="aurora-typing-dot"></div>';
        messagesEl.appendChild(typingEl);
      } else {
        typingEl.classList.add('active');
        messagesEl.appendChild(typingEl);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function hideTyping() {
      if (typingEl) {
        typingEl.classList.remove('active');
        if (typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
      }
    }

    // Send message
    async function send(text) {
      if (!text || !text.trim() || isSending) return;

      const msg = text.trim();
      addMessage(msg, true);
      inputEl.value = '';
      inputEl.style.height = 'auto';
      isSending = true;
      sendBtn.disabled = true;

      // Hide quick actions after first message
      if (quickActions) quickActions.style.display = 'none';

      showTyping();

      try {
        const resp = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg, sessionId }),
        });

        const data = await resp.json();
        hideTyping();

        if (data.success && data.data && data.data.reply) {
          addMessage(data.data.reply, false);
        } else {
          addMessage(data.error || 'Something went wrong. Please try again or email support@borealismark.com.', false);
        }
      } catch (err) {
        hideTyping();
        addMessage('Connection error. Please check your internet and try again, or email us at support@borealismark.com.', false);
      } finally {
        isSending = false;
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    // Event listeners
    sendBtn.addEventListener('click', function() { send(inputEl.value); });

    inputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(inputEl.value);
      }
    });

    // Auto-resize textarea
    inputEl.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 80) + 'px';
    });

    // Quick action buttons
    quickActions.addEventListener('click', function(e) {
      const btn = e.target.closest('.aurora-quick-btn');
      if (btn) send(btn.getAttribute('data-q'));
    });

    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && isOpen) toggle();
    });
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      injectStyles();
      createWidget();
    });
  } else {
    injectStyles();
    createWidget();
  }
})();
