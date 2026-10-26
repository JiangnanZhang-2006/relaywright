import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { privacyDir, privacyPath } from '../src/config/paths.js';
import { findStructured, fold, luhn, matchesAvatarSignal, stripRole, validId15, validId18 } from '../src/privacy/detect.js';
import { collectHeaderCandidates } from '../src/privacy/header-candidates.js';
import { PrivacyGap, Redactor, formatDeidentified } from '../src/privacy/redactor.js';
import { stringifySkill, type Skill } from '../src/skills/schema.js';

const ID18 = '110101199003078515';
const ID15 = '110101900307851';
const PHONE = '13800138000';
const PHONE_FULL = '１３８００１３８０００';
const PHONE_SPACED = '138 0013 8000';
const EMAIL = 'li.si@example.com';
const CARD = '4111111111111111';
const CARD_SPACED = '4111 1111 1111 1111';
const NAME = '张三';
const NAME_ENCODED = '%E5%BC%A0%E4%B8%89';
const NAME_ENCODED_LOWER = '%e5%bc%a0%e4%b8%89';
const OTHER = '李四';
const TEACHER = '韩易辰';
const STUDENT = '20219999';
const ACCOUNT = '20210001';
const NICK = '小张';
const URL = 'https://school.edu.cn/home';

const SEEDS = [
  NAME,
  '张 三',
  OTHER,
  TEACHER,
  NICK,
  ACCOUNT,
  STUDENT,
  PHONE,
  PHONE_FULL,
  PHONE_SPACED,
  EMAIL,
  EMAIL.toUpperCase(),
  ID18,
  CARD,
  CARD_SPACED,
  NAME_ENCODED,
  NAME_ENCODED_LOWER,
];

function home(): string {
  return mkdtempSync(join(tmpdir(), 'relaywright-privacy-'));
}

function page(): string {
  return [
    `page: 教学管理信息服务平台  url: ${URL}?su=${ACCOUNT}&who=${NAME_ENCODED}`,
    '[e1] link "教学管理信息服务平台"',
    '[e2] button "退出"',
    'h3 "我的应用"',
    `h4 "${NAME}\u00A0\u00A0学生"`,
    'table "名单" rows=1 cols: 姓名 | 学号 | 手机 | 教师 | 昵称',
    `  | ${OTHER} | ${STUDENT} | ${PHONE} | ${TEACHER} | ${NICK} |`,
    `身份证：${ID18}`,
    `邮箱：${EMAIL}`,
    `银行卡：${CARD}`,
    '课表 2025-2026-1-北校区-南3-B101-周八',
  ].join('\n');
}

function skillWith(): Skill {
  return {
    name: 'privacy-sample',
    description: '保存一份不含个人数据的技能',
    version: 1,
    start_url: `${URL}?su=${ACCOUNT}&phone=${PHONE}&mail=${EMAIL}&id=${ID18}&card=${CARD}&who=${NAME_ENCODED}&teacher=${encodeURIComponent(TEACHER)}&other=${encodeURIComponent(OTHER)}&sid=${STUDENT}&nick=${encodeURIComponent(NICK)}`,
    params: { year: { type: 'string', example: '2025-2026' } },
    steps: [
      {
        id: 's1-click',
        click: { target: { role: 'link', name: TEACHER, css: `#row-${PHONE}` } },
      },
      {
        id: 's2-expect',
        expect: {
          any: [
            {
              outcome: 'ok',
              when: { text_present: `${PHONE_FULL} ${PHONE_SPACED} 张 三 ${CARD_SPACED} ${NAME_ENCODED_LOWER} ${EMAIL.toUpperCase()}` },
            },
          ],
        },
      },
      {
        id: 's3-download',
        download: { click: { target: { role: 'link', name: '下载名单' } }, save_as: `${NAME}-${ACCOUNT}.txt` },
      },
    ],
  };
}

class FakeEl {
  tagName: string;
  id = '';
  className = '';
  attrs: Record<string, string> = {};
  parentElement: FakeEl | null = null;
  children: FakeEl[] = [];
  ownText = '';

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  get childNodes(): Array<{ nodeType: number; textContent: string }> {
    return this.ownText ? [{ nodeType: 3, textContent: this.ownText }] : [];
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  get nextElementSibling(): FakeEl | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] ?? null;
  }

  querySelectorAll(selector: string): FakeEl[] {
    const tags = new Set(selector.split(',').map((part) => part.trim().toUpperCase()));
    const found: FakeEl[] = [];
    const walk = (el: FakeEl): void => {
      for (const child of el.children) {
        if (tags.has(child.tagName)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  compareDocumentPosition(other: FakeEl): number {
    const order: FakeEl[] = [];
    let root: FakeEl = this;
    while (root.parentElement) root = root.parentElement;
    const walk = (el: FakeEl): void => {
      order.push(el);
      for (const child of el.children) walk(child);
    };
    walk(root);
    const left = order.indexOf(this);
    const right = order.indexOf(other);
    if (right > left) return 4;
    if (right < left) return 2;
    return 0;
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 0, height: 0 };
  }
}

function fake(tag: string, attrs: Record<string, string>, text = '', kids: FakeEl[] = []): FakeEl {
  const el = new FakeEl(tag);
  el.id = attrs.id ?? '';
  el.className = attrs.class ?? '';
  el.attrs = { ...attrs };
  if (attrs.class) el.attrs.class = attrs.class;
  el.ownText = text;
  for (const kid of kids) {
    kid.parentElement = el;
    el.children.push(kid);
  }
  return el;
}

function headerDoc(): { title: string; querySelectorAll(selector: string): FakeEl[] } {
  const logo = fake('img', { src: '/assets/images/logo/logo_jw_w.png', width: '120', height: '40', alt: '' });
  const brand = fake('a', { class: 'navbar-brand logo_2', href: '#' }, '', [logo, fake('span', { id: 'xtmc' }, '教学管理信息服务平台')]);
  const userImg = fake('img', { src: '/assets/images/user_logo.jpg', width: '42', height: '32', alt: '' });
  const navbar = fake('div', { class: 'navbar-header' }, '', [
    brand,
    fake('button', { id: 'exit_btn', type: 'button' }, '退出'),
    fake('button', { id: 'js_btn', type: 'button' }, '', [userImg, fake('span', {}, '功能菜单')]),
    fake('div', { role: 'button' }, '', [fake('span', {}, '菜单项')]),
    fake('span', { onclick: 'void 0' }, '快捷入口'),
  ]);
  const head = fake('div', { class: 'container head-t' }, '', [navbar]);
  const appHeading = fake('h3', {}, '', [fake('span', {}, '我的应用'), fake('a', { class: 'sz', href: '#' })]);
  const apps = fake('div', { class: 'index_wdyy' }, '', [appHeading, fake('ul', { id: 'index_wdyy' })]);
  const photo = fake('img', {
    class: 'media-object',
    alt: '110x110',
    src: '/jwglxt/xtgl/photo_cxXszp4.html?xh_id=2025000000&zplx=rxhzp',
    style: 'width:110px;height:110px',
  });
  const media = fake('div', { class: 'media' }, '', [
    fake('a', { class: 'pull-left', href: '#' }, '', [photo]),
    fake('div', { class: 'media-body' }, '', [fake('h4', { class: 'media-heading' }, '张三\u00A0\u00A0学生'), fake('p', {}, '计算机与人工智能学院 25计算机2')]),
  ]);
  const tiny = fake('div', {}, '', [
    fake('img', { class: 'avatar', src: 'avatar.png', width: '16', height: '16' }),
    fake('h4', {}, '不应入选'),
  ]);
  const root = fake('div', {}, '', [head, apps, fake('div', { id: 'yhxxIndex' }, '', [media]), tiny]);
  return { title: '教学管理信息服务平台', querySelectorAll: (selector) => root.querySelectorAll(selector) };
}

describe('privacy detectors', () => {
  it('accepts the resident id checksum, the legacy id, and Luhn, and skips lookalikes', () => {
    expect(validId18(ID18)).toBe(true);
    expect(validId18(`${ID18.slice(0, 17)}0`)).toBe(false);
    expect(validId18('110101199013078515')).toBe(false);
    expect(validId15(ID15)).toBe(true);
    expect(validId15('110101900230851')).toBe(false);
    expect(luhn(CARD)).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);

    const noise = `2026-10-10 09:21:44 CS20261010092144 202610100921 110101199013078515 ${ID15} ${ID18} ${PHONE} ${CARD}`;
    const hits = findStructured(noise).map((hit) => `${hit.kind}:${hit.value}`);
    expect(hits).toContain(`idcard:${ID18}`);
    expect(hits).toContain(`idcard:${ID15}`);
    expect(hits).toContain(`phone:${PHONE}`);
    expect(hits).toContain(`card:${CARD}`);
    expect(hits.some((hit) => hit.includes('2026'))).toBe(false);
    expect(hits.some((hit) => hit.includes('CS2026'))).toBe(false);
    expect(hits.some((hit) => hit.includes('199013'))).toBe(false);
  });

  it('normalises nbsp and keeps section headings out of header candidates', () => {
    expect(stripRole('张三\u00A0\u00A0学生')).toBe('张三');
    expect(fold('张\u00A0三')).toBe('张三');
    expect(matchesAvatarSignal('cxXszp4')).toBe(true);
    expect(matchesAvatarSignal('photo_cxXszp4.html')).toBe(true);
    expect(matchesAvatarSignal('user_logo.jpg')).toBe(true);
    expect(matchesAvatarSignal('media-heading')).toBe(false);
    expect(matchesAvatarSignal('logo_jw_w.png')).toBe(false);
    expect(collectHeaderCandidates(headerDoc())).toEqual(['张三']);

    const root = home();
    const redactor = new Redactor({ root });
    redactor.setGlobalMode(true);
    const far = ['page: 教学管理信息服务平台  url: https://school.edu.cn/home', '[e1] button "退出"', 'h3 "我的应用"', 'p "介绍"', 'h4 "远处的人"'].join('\n');
    const masked = redactor.present(far, 'https://school.edu.cn/home');
    expect(masked).toContain('我的应用');
    expect(masked).toContain('远处的人');
    expect(masked).not.toContain('‹候选');
    redactor.noteHeaderCandidates(['张\u00A0三'], 'https://school.edu.cn/home');
    expect(redactor.present('张\u00A0三', 'https://school.edu.cn/home')).toBe('‹候选1›');
  });

  it('ignores a stale candidate file and does not store unconfirmed candidates', () => {
    const root = home();
    mkdirSync(privacyDir(root), { recursive: true });
    const path = privacyPath('school.edu.cn', root);
    writeFileSync(
      path,
      `${JSON.stringify({
        self: { account: ACCOUNT },
        rejections: [],
        allow: [],
        others: {},
        candidates: { 我的应用: { token: '‹候选1›', n: 1, value: '我的应用' } },
        aliases: {},
        retired: {},
        next: { 候选: 7, 手机: 2 },
        categories: {},
      })}\n`,
    );
    const text = [
      'page: 教学管理信息服务平台  url: https://school.edu.cn/home',
      '[e1] button "退出"',
      '[e2] button "功能菜单"',
      `h4 "${NAME} 学生"`,
      '我的应用',
    ].join('\n');
    const redactor = new Redactor({ root });
    redactor.setGlobalMode(true);
    const masked = redactor.present(text, URL);
    expect(masked).toContain('我的应用');
    expect(masked).toContain('功能菜单');
    expect(masked).toContain('‹候选1›');
    expect(masked).not.toContain(NAME);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { candidates: Record<string, unknown>; next: Record<string, number>; self: { account?: string } };
    expect(stored.candidates).toEqual({});
    expect(stored.next['候选']).toBeUndefined();
    expect(stored.next['手机']).toBe(2);
    expect(stored.self.account).toBe(ACCOUNT);
    expect(JSON.stringify(stored)).not.toContain('我的应用');
    expect(JSON.stringify(stored)).not.toContain(NAME);

    const restarted = new Redactor({ root });
    restarted.setGlobalMode(true);
    expect(restarted.present(text, URL)).toContain('‹候选1›');
    expect(restarted.present('我的应用', URL)).toBe('我的应用');
  });
});

describe('privacy redactor', () => {
  it('returns raw text by default and masks only after the mode is turned on', () => {
    const root = home();
    const redactor = new Redactor({ root });
    const snapshot = page();
    expect(redactor.modelRedaction(URL)).toBe(false);
    expect(redactor.present(snapshot, URL)).toBe(snapshot);
    expect(redactor.present(snapshot, URL)).not.toContain('(privacy:');

    redactor.setGlobalMode(true);
    const masked = redactor.present(snapshot, URL);
    expect(masked).not.toContain(NAME);
    expect(masked).not.toContain(PHONE);
    expect(masked).not.toContain(TEACHER);
    expect(masked).toContain('周八');
    expect(masked).toContain('我的应用');
    expect(masked).toContain('教学管理信息服务平台');
    expect(masked).toContain('‹候选1›');
    expect(masked).toContain('(privacy: ‹候选1› looks like the user\'s own info; ask the user and call privacy_confirm)');
    expect(redactor.present(snapshot, URL)).toBe(masked);
    const mailOnly = new Redactor({ root });
    mailOnly.setGlobalMode(true);
    const encodedMail = mailOnly.present(`page: home  url: ${URL}?mail=${encodeURIComponent(EMAIL)}`, URL);
    expect(encodedMail).not.toContain(EMAIL);
    expect(encodedMail).not.toContain(encodeURIComponent(EMAIL));
    expect(encodedMail).toContain('‹邮箱');
    const yaml = 'name: privacy-page-redacted\n    name: 退出\nnickname:\n    type: string\n';
    expect(redactor.present(yaml, URL)).toBe(yaml);
    expect(redactor.present('button "退出"', URL)).toContain('退出');
  });

  it('lets the environment and a per-identity flag override the global mode', () => {
    const root = home();
    const redactor = new Redactor({ root });
    redactor.setGlobalMode(true);
    redactor.setIdentityMode('school.edu.cn', false);
    expect(redactor.modelRedaction(URL)).toBe(false);
    expect(redactor.modelRedaction('https://other.edu.cn/a')).toBe(true);
    const previous = process.env.RELAYWRIGHT_PRIVACY;
    process.env.RELAYWRIGHT_PRIVACY = 'on';
    try {
      expect(redactor.modelRedaction(URL)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RELAYWRIGHT_PRIVACY;
      else process.env.RELAYWRIGHT_PRIVACY = previous;
    }
  });

  it('keeps other-people numbers for an identity and never reuses them', () => {
    const root = home();
    const first = new Redactor({ root });
    first.setGlobalMode(true);
    const one = first.mask(`tel ${PHONE}`, URL);
    const two = first.mask('tel 13900139000', URL);
    expect(one).toContain('‹手机1›');
    expect(two).toContain('‹手机2›');

    const second = new Redactor({ root });
    second.setGlobalMode(true);
    expect(second.mask(PHONE, URL)).toContain('‹手机1›');
    expect(second.mask('13700137000', URL)).toContain('‹手机3›');
    expect(second.reveal('‹手机1›', 'act', URL)).toBe(PHONE);

    const session = new Redactor({ root });
    session.setGlobalMode(true);
    expect(session.mask(PHONE, 'about:blank')).toContain('‹手机1›');
    const again = new Redactor({ root });
    again.setGlobalMode(true);
    expect(again.mask('13900139000', 'about:blank')).toContain('‹手机1›');
    expect(readdirSync(privacyDir(root)).some((name) => name.includes('about'))).toBe(false);
  });

  it('matches fullwidth, spaced, and URL-encoded variants of the same value', () => {
    const redactor = new Redactor({ root: home() });
    redactor.setGlobalMode(true);
    const masked = redactor.mask(`${PHONE} ${PHONE_FULL} ${PHONE_SPACED}`, URL);
    expect(masked).toBe('‹手机1› ‹手机1› ‹手机1›');
    expect(redactor.mask(`who=${NAME_ENCODED} and who=${NAME_ENCODED_LOWER} and 张 三`, URL)).not.toContain(NAME);
  });

  it('confirms and rejects candidates without echoing the value back through the token', () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const redactor = new Redactor({
      root: home(),
      audit: (event, fields) => events.push({ event, fields }),
    });
    redactor.setGlobalMode(true);
    const masked = redactor.mask(page(), URL);
    expect(masked).toContain('‹候选1›');
    const confirmed = redactor.confirm('‹候选1›', 'name', URL);
    expect(confirmed).toEqual({ token: '‹我.姓名›', as: 'name' });
    expect(JSON.stringify(confirmed)).not.toContain(NAME);
    expect(redactor.mask(page(), URL)).toContain('‹我.姓名›');
    expect(redactor.mask(page(), URL)).not.toContain('‹候选1›');
    expect(redactor.reveal('‹候选1›', 'act', URL)).toBe(NAME);
    expect(events.some((event) => event.event === 'privacy_reveal' && event.fields.token === '‹候选1›')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(NAME);

    const off = new Redactor({
      root: home(),
      audit: (event, fields) => events.push({ event, fields }),
    });
    off.addSelf('phone', PHONE, { identity: 'school.edu.cn' });
    events.length = 0;
    expect(off.modelRedaction(URL)).toBe(false);
    expect(off.reveal('‹我.手机›', 'type', URL)).toBe(PHONE);
    expect(events).toEqual([]);
    expect(off.list(URL).self[0]).toEqual({ token: '‹我.手机›', kind: 'phone', masked: '*********00' });

    const candidate = new Redactor({ root: home() });
    candidate.setGlobalMode(true);
    candidate.mask('h4 "李四 学生"\n[e1] button "退出"\npage: t  url: https://school.edu.cn/', URL);
    candidate.reject('‹候选1›', URL);
    expect(candidate.mask('h4 "李四 学生"\n[e1] button "退出"\npage: t  url: https://school.edu.cn/', URL)).toContain(OTHER);
  });

  it('rewrites a skill in default mode and refuses a locator that is only personal data', () => {
    const root = home();
    const redactor = new Redactor({ root });
    expect(redactor.modelRedaction(URL)).toBe(false);
    redactor.addSelf('account', ACCOUNT, { url: URL });
    const snapshot = page();
    redactor.absorb(snapshot, URL);
    const cleaned = redactor.deidentify(skillWith(), URL);
    const yaml = stringifySkill(cleaned.skill);
    const checks = JSON.stringify(cleaned.skill.steps.filter((step) => step.expect));
    const dir = join(root, 'skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'skill.yaml'), yaml);
    writeFileSync(join(dir, 'checks.json'), checks);
    const saved = readFileSync(join(dir, 'skill.yaml'), 'utf8') + readFileSync(join(dir, 'checks.json'), 'utf8');
    for (const seed of SEEDS) expect(saved, seed).not.toContain(seed);
    expect(saved).toContain('‹我.账号›');
    expect(saved).toContain('{{teacher}}');
    expect(saved).toContain('{{phone1}}');
    expect(saved).not.toContain('#row-');
    expect(saved).toContain('2025-2026');
    expect(formatDeidentified(cleaned.report)).not.toContain(PHONE);
    expect(cleaned.report.params.some((item) => item.name === 'teacher')).toBe(true);

    const blocked: Skill = {
      ...skillWith(),
      steps: [{ id: 's2-click-user', click: { target: { role: 'button', name: '', css: `#user-${PHONE}` } } }],
    };
    expect(() => redactor.deidentify(blocked, URL)).toThrow(/s2-click-user/);
    try {
      redactor.deidentify(blocked, URL);
    } catch (err) {
      expect(err instanceof Error ? err.message : '').not.toContain(PHONE);
    }
  });

  it('fails a skill run with a step error when a self token has no value', () => {
    const redactor = new Redactor({ root: home() });
    const skill: Skill = {
      name: 'needs-self',
      description: '需要本人姓名',
      version: 1,
      start_url: 'https://school.edu.cn/?name=‹我.姓名›',
      params: {},
      steps: [{ id: 's1-goto', goto: { url: 'https://school.edu.cn/?name=‹我.姓名›' } }],
    };
    expect(() => redactor.prepareRun(skill, {})).toThrow(PrivacyGap);
    try {
      redactor.prepareRun(skill, {});
    } catch (err) {
      expect(err).toBeInstanceOf(PrivacyGap);
      expect(err instanceof Error ? err.message : '').toContain('‹我.姓名›');
      expect(err instanceof Error ? err.message : '').not.toContain(NAME);
    }
    redactor.addSelf('name', NAME, { url: URL });
    const prepared = redactor.prepareRun(skill, { params: { who: '‹我.姓名›' } });
    expect(prepared.skill.start_url).toContain(NAME);
    expect(prepared.input.params?.who).toBe(NAME);
  });
});
