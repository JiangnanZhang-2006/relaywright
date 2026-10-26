import { PASSWORD_FIELD_HELPERS } from '../perception/password-like.js';

const ACCOUNT_HINT = 'user|username|account|login|yhm|学号|工号|账号|用户名|手机号';

/**
 * Runs in the page. Returns the login account and never the password.
 * The account is the last non-empty text input before a password field,
 * or a field whose name, id, placeholder, or label looks like a username.
 */
export function loginAccountEvaluator(): () => string {
  const body = `${PASSWORD_FIELD_HELPERS}
function rwAccountLike(el) {
  var hint = /${ACCOUNT_HINT}/i;
  var placeholder = el.getAttribute('placeholder') || '';
  var name = el.getAttribute('name') || '';
  var id = el.id || '';
  if (hint.test(placeholder) || hint.test(name) || hint.test(id) || hint.test(rwControlText(el))) return true;
  return false;
}
function rwAccountFrom(doc, depth) {
  if (!doc || !doc.querySelectorAll || depth > 4) return '';
  var inputs = doc.querySelectorAll('input');
  var preceding = '';
  var labelled = '';
  var sawPassword = false;
  for (var i = 0; i < inputs.length; i += 1) {
    var input = inputs[i];
    var type = (input.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden') continue;
    var password = type === 'password' || (rwShown(input) && rwPasswordLike(input));
    if (password) {
      sawPassword = true;
      break;
    }
    if (!rwShown(input) || !rwTextLikeInput(input)) continue;
    var value = String(input.value || '').replace(/^\\s+|\\s+$/g, '');
    if (!value) continue;
    preceding = value;
    if (rwAccountLike(input)) labelled = value;
  }
  if (labelled) return labelled;
  if (sawPassword && preceding) return preceding;
  var frames = doc.querySelectorAll('iframe, frame');
  for (var f = 0; f < frames.length; f += 1) {
    try {
      var inner = rwAccountFrom(frames[f].contentDocument, depth + 1);
      if (inner) return inner;
    } catch (err) {}
  }
  return '';
}
return rwAccountFrom(document, 0);`;
  return new Function(body) as () => string;
}
