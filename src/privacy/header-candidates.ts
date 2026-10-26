import { AVATAR_PATTERN } from './detect.js';

/**
 * Runs in the page. Returns short names that look like the signed-in user.
 * Avatar text comes from the smallest ancestor within 3 levels of the image.
 * Logout text stays inside 2 levels and ignores section titles and the site name.
 */
export function headerCandidatesEvaluator(): () => string[] {
  const pattern = JSON.stringify(AVATAR_PATTERN);
  const body = `
function rwClass(el) {
  var value = el && el.className;
  if (value && typeof value === 'object' && value.baseVal) return String(value.baseVal);
  return String(value || '');
}
function rwNorm(value) {
  return String(value || '').replace(/[\\u00a0\\u3000\\s]+/g, ' ').replace(/^\\s+|\\s+$/g, '');
}
function rwStripRole(value) {
  return rwNorm(rwNorm(value).replace(/学生|教师|老师|同学/g, ' '));
}
function rwShort(value) {
  var text = rwStripRole(value);
  var chars = Array.from(text);
  if (chars.length < 2 || chars.length > 20) return '';
  if (/退出|注销|登出|logout|log\\s*out|sign\\s*out/i.test(text)) return '';
  if (/^\\d+$/.test(text)) return '';
  return text;
}
function rwInBrand(el) {
  var node = el;
  while (node) {
    var tag = String(node.tagName || '').toLowerCase();
    if (tag === 'a') {
      var mark = (rwClass(node) + ' ' + (node.id || '')).toLowerCase();
      if (/(?:^|[^a-z])(?:brand|logo)(?![a-z])/.test(mark) && !/user_?logo/.test(mark)) return true;
    }
    node = node.parentElement;
  }
  return false;
}
function rwSectionTitle(el) {
  var tag = String(el.tagName || '').toLowerCase();
  if (!/^h[1-6]$/.test(tag)) return false;
  var sib = el.nextElementSibling;
  if (!sib || !sib.tagName) return false;
  var next = String(sib.tagName).toLowerCase();
  return next === 'ul' || next === 'ol' || next === 'section' || next === 'dl';
}
function rwBlocked(el, logoutMode) {
  var node = el;
  while (node) {
    var tag = String(node.tagName || '').toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (rwSectionTitle(node)) return true;
      if (logoutMode && (tag === 'h1' || tag === 'h2' || tag === 'h3')) return true;
      return false;
    }
    node = node.parentElement;
  }
  return false;
}
function rwSize(img) {
  var rect = { width: 0, height: 0 };
  try {
    if (img.getBoundingClientRect) rect = img.getBoundingClientRect() || rect;
  } catch (err) {}
  var w = rect.width || 0;
  var h = rect.height || 0;
  if (!(w > 0)) w = Number(img.getAttribute && img.getAttribute('width')) || 0;
  if (!(h > 0)) h = Number(img.getAttribute && img.getAttribute('height')) || 0;
  var style = String((img.getAttribute && img.getAttribute('style')) || '');
  if (!(w > 0)) {
    var sw = /width\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*px/i.exec(style);
    if (sw) w = Number(sw[1]);
  }
  if (!(h > 0)) {
    var sh = /height\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*px/i.exec(style);
    if (sh) h = Number(sh[1]);
  }
  return { w: w, h: h };
}
function rwAvatar(img) {
  if (rwInBrand(img)) return false;
  var src = String((img.getAttribute && img.getAttribute('src')) || '');
  var low = src.toLowerCase();
  if (low.indexOf('logo') !== -1 && !/user_?logo/.test(low)) return false;
  var size = rwSize(img);
  if (size.w > 0 && size.h > 0 && (size.w < 24 || size.h < 24)) return false;
  var blob = [src, (img.getAttribute && img.getAttribute('alt')) || '', rwClass(img), img.id || ''].join(' ');
  return new RegExp(${pattern}, 'i').test(blob);
}
function rwOwnText(el) {
  var parts = [];
  var nodes = el.childNodes || [];
  for (var i = 0; i < nodes.length; i += 1) {
    if (nodes[i] && nodes[i].nodeType === 3) parts.push(nodes[i].textContent || '');
  }
  return rwNorm(parts.join(' '));
}
function rwIsLogout(el) {
  var tag = String(el.tagName || '').toLowerCase();
  if (tag !== 'button' && tag !== 'a' && tag !== 'input') return false;
  var own = tag === 'input' ? rwNorm((el.getAttribute && el.getAttribute('value')) || '') : rwOwnText(el);
  if (!own && el.getAttribute) own = rwNorm(el.getAttribute('aria-label') || el.getAttribute('title') || '');
  if (!own || Array.from(own).length > 24) return false;
  return /退出|注销|登出|logout|log\\s*out|sign\\s*out/i.test(own);
}
function rwInteractive(el) {
  if (!el || !el.tagName) return false;
  var tag = String(el.tagName).toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
  var role = el.getAttribute ? String(el.getAttribute('role') || '').toLowerCase() : '';
  if (role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab') return true;
  if (el.getAttribute && el.getAttribute('onclick')) return true;
  if (typeof el.onclick === 'function') return true;
  return false;
}
function rwInsideControl(el) {
  var node = el;
  while (node) {
    if (rwInteractive(node)) return true;
    node = node.parentElement;
  }
  return false;
}
function rwPlain(el) {
  var parts = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      parts.push(node.textContent || '');
      return;
    }
    if (node !== el && rwInteractive(node)) return;
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i += 1) walk(kids[i]);
  }
  walk(el);
  return parts.join('');
}
function rwAfter(anchor, node) {
  if (!anchor || !anchor.compareDocumentPosition) return false;
  return (anchor.compareDocumentPosition(node) & 4) !== 0;
}
function rwPick(root, anchor, logoutMode, title) {
  if (!root || !root.querySelectorAll) return '';
  var nodes = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,strong');
  var best = '';
  var bestRank = 99;
  for (var i = 0; i < nodes.length; i += 1) {
    var node = nodes[i];
    if (rwInBrand(node) || rwBlocked(node, logoutMode) || rwInsideControl(node)) continue;
    var name = rwShort(rwPlain(node));
    if (!name) continue;
    if (logoutMode && title && title.toLowerCase().indexOf(name.toLowerCase()) !== -1) continue;
    var heading = /^H[1-6]$/.test(String(node.tagName || ''));
    var after = rwAfter(anchor, node);
    var rank = (after ? 0 : 2) + (heading ? 0 : 1);
    if (rank < bestRank) {
      bestRank = rank;
      best = name;
    }
  }
  return best;
}
function rwClimb(start, max, pick) {
  var el = start;
  for (var level = 0; level <= max; level += 1) {
    if (!el || !el.tagName) break;
    var tag = String(el.tagName).toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    var found = pick(el);
    if (found) return found;
    el = el.parentElement;
  }
  return '';
}
function rwCollect(doc) {
  var found = [];
  var title = rwNorm(doc.title || '');
  var images = doc.querySelectorAll ? doc.querySelectorAll('img') : [];
  for (var i = 0; i < images.length; i += 1) {
    if (!rwAvatar(images[i])) continue;
    var name = rwClimb(images[i], 3, function (root) { return rwPick(root, images[i], false, title); });
    if (name) found.push(name);
  }
  var controls = doc.querySelectorAll ? doc.querySelectorAll('button, a, input') : [];
  for (var c = 0; c < controls.length; c += 1) {
    if (!rwIsLogout(controls[c])) continue;
    var near = rwClimb(controls[c], 2, function (root) { return rwPick(root, controls[c], true, title); });
    if (near) found.push(near);
  }
  var out = [];
  for (var n = 0; n < found.length; n += 1) {
    if (out.indexOf(found[n]) === -1) out.push(found[n]);
  }
  return out;
}
return rwCollect(document);`;
  return new Function(body) as () => string[];
}

/** Test hook. The page evaluator reads the real document. */
export function collectHeaderCandidates(doc: unknown): string[] {
  const box = globalThis as { document?: unknown };
  const previous = box.document;
  box.document = doc;
  try {
    return headerCandidatesEvaluator()();
  } finally {
    if (previous === undefined) delete box.document;
    else box.document = previous;
  }
}
