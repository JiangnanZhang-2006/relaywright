const SECRET_FIELD = /密码|口令|password|passwd|pwd|passcode|验证码|captcha|otp/i;
export function isSensitive(target) {
    if (target.sensitive)
        return true;
    if ((target.role ?? '').toLowerCase().includes('password'))
        return true;
    return SECRET_FIELD.test(`${target.name ?? ''}\n${target.label ?? ''}`);
}
/** Typed secrets are stored as a placeholder. Select values stay literal. */
export function valueForTrace(action, value, target) {
    if (value === undefined)
        return undefined;
    if (action === 'type' && target && isSensitive(target))
        return '{{secret}}';
    return value;
}
//# sourceMappingURL=redact.js.map