import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_SNAPSHOT_LINES,
  renderSnapshot,
  type AxNode,
} from '../src/session/snapshot.js';

function node(partial: AxNode): AxNode {
  return partial;
}

const tree: AxNode[] = [
  node({
    nodeId: 'root',
    role: { type: 'role', value: 'RootWebArea' },
    name: { type: 'string', value: '个人课表查询' },
    childIds: ['wrap', 'heading', 'secret', 'noise', 'confirm', 'visible', 'hidden-button'],
  }),
  node({
    nodeId: 'wrap',
    ignored: true,
    role: { type: 'role', value: 'generic' },
    childIds: ['year', 'query'],
  }),
  node({
    nodeId: 'year',
    role: { type: 'role', value: 'combobox' },
    name: { type: 'string', value: '学年' },
    value: { type: 'string', value: '2026-2027' },
  }),
  node({
    nodeId: 'query',
    role: { type: 'role', value: 'button' },
    name: { type: 'string', value: '查询' },
  }),
  node({
    nodeId: 'heading',
    role: { type: 'role', value: 'heading' },
    name: { type: 'string', value: '该学年学期尚无您的课表！' },
    properties: [{ name: 'level', value: { type: 'integer', value: 3 } }],
  }),
  node({
    nodeId: 'secret',
    role: { type: 'role', value: 'textbox' },
    name: { type: 'string', value: '密码' },
    value: { type: 'string', value: 's3cret' },
    properties: [{ name: 'protected', value: { type: 'boolean', value: true } }],
  }),
  node({
    nodeId: 'noise',
    role: { type: 'role', value: 'generic' },
    name: { type: 'string', value: '不要出现的说明' },
  }),
  node({
    nodeId: 'confirm',
    role: { type: 'role', value: 'textbox' },
    name: { type: 'string', value: '确认密码' },
    value: { type: 'string', value: 'hunter2' },
    backendDOMNodeId: 42,
  }),
  node({
    nodeId: 'visible',
    role: { type: 'role', value: 'textbox' },
    name: { type: 'string', value: '用户名' },
    value: { type: 'string', value: 'alice' },
    properties: [{ name: 'protected', value: { type: 'boolean', value: false } }],
  }),
  node({
    nodeId: 'hidden-button',
    ignored: true,
    role: { type: 'role', value: 'button' },
    name: { type: 'string', value: '不要显示' },
  }),
];

describe('renderSnapshot', () => {
  it('renders interactive controls and headings, skipping ignored and empty nodes', () => {
    const text = renderSnapshot({
      title: '个人课表查询',
      url: 'https://jwxt.example.edu.cn/table',
      nodes: tree,
      passwordBackendNodeIds: new Set([42]),
    });

    expect(text).toBe(
      [
        'page: 个人课表查询  url: https://jwxt.example.edu.cn/table',
        '[e1] combobox "学年" = "2026-2027"',
        '[e2] button "查询"',
        'h3 "该学年学期尚无您的课表！"',
        '[e3] textbox "密码" = "[redacted]"',
        '[e4] textbox "确认密码" = "[redacted]"',
        '[e5] textbox "用户名" = "alice"',
      ].join('\n'),
    );
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('不要显示');
    expect(text).not.toContain('不要出现的说明');
  });

  it('redacts password values from the protected property and from DOM backend ids', () => {
    const text = renderSnapshot({
      title: 'login',
      url: 'https://example.edu/login',
      nodes: [
        node({
          nodeId: 'pw',
          role: { value: 'textbox' },
          name: { value: '密码' },
          value: { value: 's3cret' },
          properties: [{ name: 'protected', value: { type: 'boolean', value: true } }],
        }),
      ],
    });
    expect(text).toContain('[e1] textbox "密码" = "[redacted]"');
    expect(text).not.toContain('s3cret');
  });

  it('caps output and reports how many lines were omitted', () => {
    const nodes: AxNode[] = [
      node({
        nodeId: 'root',
        role: { value: 'RootWebArea' },
        childIds: ['b1', 'b2', 'b3', 'b4'],
      }),
      node({ nodeId: 'b1', role: { value: 'button' }, name: { value: '一' } }),
      node({ nodeId: 'b2', role: { value: 'button' }, name: { value: '二' } }),
      node({ nodeId: 'b3', role: { value: 'button' }, name: { value: '三' } }),
      node({ nodeId: 'b4', role: { value: 'button' }, name: { value: '四' } }),
    ];
    const text = renderSnapshot({
      title: 't',
      url: 'https://example.com/',
      nodes,
      maxLines: 2,
    });
    expect(text).toBe(
      ['page: t  url: https://example.com/', '[e1] button "一"', '[e2] button "二"', '… 2 more'].join('\n'),
    );
  });

  it('uses a 300 line cap by default', () => {
    expect(DEFAULT_MAX_SNAPSHOT_LINES).toBe(300);
  });
});
