/* Safe Markdown-ish renderer for agent replies. Model text is never interpreted as HTML. */
(function (g) {
  'use strict';
  function inlineReply(parent, source) {
    var text = String(source == null ? '' : source);
    var re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s<>]+|<\/?[A-Za-z][^<>]*>)/g;
    var at = 0, match;
    while ((match = re.exec(text))) {
      if (match.index > at) parent.appendChild(document.createTextNode(text.slice(at, match.index)));
      var token = match[0], node;
      if (token.charAt(0) === '`') {
        node = document.createElement('code'); node.textContent = token.slice(1, -1);
      } else if (token.slice(0, 2) === '**' || token.slice(0, 2) === '__') {
        node = document.createElement('strong'); node.textContent = token.slice(2, -2);
      } else if (token.charAt(0) === '*' || token.charAt(0) === '_') {
        node = document.createElement('em'); node.textContent = token.slice(1, -1);
      } else if (/^https?:\/\//i.test(token)) {
        var url = token, trailing = '';
        while (/[.,!?;:)\]]$/.test(url)) { trailing = url.slice(-1) + trailing; url = url.slice(0, -1); }
        node = document.createElement('a'); node.href = url; node.textContent = url; node.target = '_blank'; node.rel = 'noopener noreferrer';
        parent.appendChild(node); if (trailing) parent.appendChild(document.createTextNode(trailing)); at = re.lastIndex; continue;
      } else {
        node = document.createElement('code'); node.className = 'inline-code'; node.textContent = token;
      }
      parent.appendChild(node); at = re.lastIndex;
    }
    if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
  }

  function renderReply(text) {
    var root = document.createElement('div'); root.className = 'reply-markdown';
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var paragraph = [], list = null, listType = '', codeLines = null;
    function flushParagraph() {
      if (!paragraph.length) return;
      var p = document.createElement('p'); inlineReply(p, paragraph.join(' ').trim()); root.appendChild(p); paragraph = [];
    }
    function flushList() { if (list) { root.appendChild(list); list = null; listType = ''; } }
    function flushCode() {
      var pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = codeLines.join('\n'); pre.appendChild(code); root.appendChild(pre); codeLines = null;
    }
    lines.forEach(function (line) {
      if (codeLines) { if (/^\s*```/.test(line)) flushCode(); else codeLines.push(line); return; }
      if (/^\s*```/.test(line)) { flushParagraph(); flushList(); codeLines = []; return; }
      if (!line.trim()) { flushParagraph(); flushList(); return; }
      var heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
      if (heading) {
        flushParagraph(); flushList();
        var h = document.createElement('h' + Math.min(heading[1].length + 1, 5)); inlineReply(h, heading[2]); root.appendChild(h); return;
      }
      var item = line.match(/^\s*(?:[-*+]\s+|(\d+)[.)]\s+)(.*)$/);
      if (item) {
        flushParagraph();
        var type = item[1] ? 'ol' : 'ul';
        if (!list || listType !== type) { flushList(); list = document.createElement(type); listType = type; }
        var li = document.createElement('li'); inlineReply(li, item[2]); list.appendChild(li); return;
      }
      if (/^\s*[-*_]{3,}\s*$/.test(line)) { flushParagraph(); flushList(); root.appendChild(document.createElement('hr')); return; }
      flushList(); paragraph.push(line.trim());
    });
    if (codeLines) flushCode();
    flushParagraph(); flushList();
    return root;
  }

  g.ReplyRenderer = { renderReply: renderReply };
})(window);
