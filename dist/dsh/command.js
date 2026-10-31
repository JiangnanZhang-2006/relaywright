import { join } from 'node:path';
import { relaywrightHome } from '../config/paths.js';
import { RelayError } from '../errors.js';
import { formatSkillList } from '../skills/format.js';
import { listSkills, readSkill } from '../skills/store.js';
/** `/relaywright` reads the skill directory directly and does not start the daemon. */
export function relaywrightCommand(rawInput, root = relaywrightHome()) {
    const input = rawInput.trim();
    if (input === '' || input === 'list') {
        const skills = listSkills(root);
        if (skills.length === 0) {
            return { kind: 'success', text: `没有已保存的技能。\n目录：${join(root, 'skills')}` };
        }
        return { kind: 'success', text: formatSkillList(skills) };
    }
    const shown = /^show(?:\s+([a-z0-9][a-z0-9-]{1,63}))?$/.exec(input);
    if (!shown?.[1])
        return { kind: 'error', text: '用法：/relaywright [list | show <name>]' };
    try {
        return { kind: 'success', text: readSkill(shown[1], undefined, root).yaml };
    }
    catch (err) {
        const text = err instanceof RelayError ? err.message : err instanceof Error ? err.message : String(err);
        return { kind: 'error', text };
    }
}
//# sourceMappingURL=command.js.map