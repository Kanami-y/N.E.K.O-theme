/*! domset.js -- the single representative DOM used by BOTH instruments:
 *
 *   - test/expr-realab.js      : A/B zero-change check (real page, sheet on vs off)
 *   - tools/gen-realpage-probe.js : native measurement on the real page
 *
 * Why one shared definition: the last defect class came from the two instruments
 * disagreeing. A synthetic fixture measured an INHERITED value (or a value produced
 * by a media query the fixture's viewport matched but the app's does not, or missed
 * the inline <style> layer the app injects at runtime) and baked it in as a fallback.
 * The A/B harness then reported the element as changed on the real page.
 *
 * One DOM set, measured on the real page in both directions, removes that class.
 * Keep this in sync with test/targets.js: every selector there must appear here.
 */
'use strict';

var MARKUP = [
  '<div class="message user"><div class="message-block"><div class="message-block-text">t</div>',
  '  <div class="message-block-markdown">md <a href="#">l</a> <code class="message-markdown-inline-code">c</code>',
  '  <pre class="message-markdown-pre">p</pre></div></div></div>',
  '<div class="message gemini"><div class="message-block"><div class="message-block-markdown">ai</div></div></div>',
  '<div class="message-row message-row-user"><div class="message-stack">',
  '  <div class="message-bubble message-bubble-user"><div class="message-block"><div class="message-block-markdown">u</div></div></div>',
  '</div></div>',
  '<div class="message-row"><div class="message-stack">',
  '  <div class="message-bubble message-bubble-assistant"><div class="message-block"><div class="message-block-markdown">a <a href="#">l</a></div></div></div>',
  '</div></div>',
  '<div class="message-bubble message-bubble-tool">t</div>',
  '<div class="message-bubble message-bubble-system">s</div>',
  '<div class="message-block message-block-image">i</div>',
  '<div class="message-block-status tone-info">si</div>',
  '<div class="message-block-status tone-success">ss</div>',
  '<div class="message-block-status tone-warning">sw</div>',
  '<div class="message-block-status tone-error">se</div>',
  '<div id="react-chat-window-root"><div id="react-chat-window-shell"><div id="react-chat-window-backdrop"></div>',
  '  <div class="window-topbar"><span class="window-title">t</span></div>',
  '  <div class="chat-window"><div class="chat-body"></div></div>',
  '  <div class="composer-panel">panel <a href="#">in-panel link</a></div>',
  '  <div id="text-input-area">',
  '    <div class="composer-input-shell"><textarea class="composer-input" placeholder="p"></textarea></div>',
  '    <button class="composer-tool-btn"></button><button class="composer-icon-button"></button>',
  '    <button class="composer-emoji-btn"></button><button class="composer-translate-btn"></button>',
  '    <button class="composer-overflow-btn"></button><button class="composer-galgame-btn"></button>',
  '    <button class="composer-tool-clear-btn"></button><button class="composer-attachment-remove"></button>',
  '    <span class="send-button-circle"></span>',
  '    <div class="composer-attachments"></div>',
  '    <div class="composer-visit-bar">v<span class="composer-visit-bar-badge">b</span><button class="composer-visit-bar-action">a</button></div>',
  '  </div>',
  '  <div class="composer-icon-popover">ip</div>',
  '  <div class="composer-overflow-popover">op</div>',
  '  <div class="composer-overflow-menu">om</div>',
  '  <div class="composer-galgame-options"><div class="composer-galgame-option">o</div></div>',
  '  <div class="modal-overlay"><div class="modal-dialog"><h3 class="modal-title">t</h3></div></div>',
  '  <div class="proactive-recommendation"><div class="proactive-recommendation-bubble">',
  '    <div class="proactive-recommendation-card">c</div></div>',
  '    <div class="music-recommendation-bubble"><div class="music-recommendation-icon">i</div></div>',
  '    <div class="system-chip"><div class="system-chip-content">c</div></div>',
  '    <div class="compact-export-history-bubble">h</div>',
  '    <div class="compact-export-preview-bubble">p</div>',
  '  </div>',
  '  <div id="agent-plugin-views"><div id="agent-plugin-content"><div class="agent-plugin-view">v</div></div></div>',
  '  <div id="textInputBox"><button id="sendButton">s</button><button id="textSendButton">t</button></div>',
  '</div></div>'
].join('\n');

/* Mounting style. Must stay OUT of the layout flow but still be RENDERED: display:none
 * would zero computed values and make width/height-dependent rules resolve differently. */
var MOUNT_CSS = 'position:absolute;left:-4000px;top:0;width:1200px;';
var MOUNT_ID = '__nts_ab';

/* The property set both instruments compare. */
var PROPS = ['color', 'background-color', 'background-image', 'border-top-color',
  'border-top-width', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius', 'outline-color',
  'outline-width', 'box-shadow', 'backdrop-filter', 'font-size', 'font-family',
  'scrollbar-color'];

module.exports = { MARKUP: MARKUP, MOUNT_CSS: MOUNT_CSS, MOUNT_ID: MOUNT_ID, PROPS: PROPS };
