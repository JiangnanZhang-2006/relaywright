import { describe, expect, it } from 'vitest';
import { RefRegistry } from '../src/perception/registry.js';
import {
  DEFAULT_MAX_SNAPSHOT_LINES,
  renderSnapshot,
  type AdaptedSelect,
  type AxNode,
} from '../src/perception/snapshot.js';

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

  it('renders callouts without refs', () => {
    const text = renderSnapshot({
      title: 't',
      url: 'https://example.com/',
      nodes: [
        node({
          nodeId: 'root',
          role: { value: 'RootWebArea' },
          childIds: ['alert', 'status', 'dialog'],
        }),
        node({ nodeId: 'alert', role: { value: 'alert' }, name: { value: '已保存' } }),
        node({ nodeId: 'status', role: { value: 'status' }, name: { value: '首页' } }),
        node({ nodeId: 'dialog', role: { value: 'dialog' }, name: { value: '确认' } }),
      ],
    });
    expect(text).toBe(
      ['page: t  url: https://example.com/', 'alert "已保存"', 'status "首页"', 'dialog "确认"'].join('\n'),
    );
  });

  it('uses subtree text when a status has no accessible name', () => {
    const text = renderSnapshot({
      title: 't',
      url: 'https://example.com/',
      nodes: [
        node({ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['status'] }),
        node({ nodeId: 'status', role: { value: 'status' }, childIds: ['text'] }),
        node({ nodeId: 'text', role: { value: 'StaticText' }, name: { value: '查询已完成' } }),
      ],
    });
    expect(text).toContain('status "查询已完成"');
  });

  it('summarizes tables and still refs interactive cells inside the rendered rows', () => {
    const text = renderSnapshot({
      title: '课表',
      url: 'https://example.com/kb',
      maxRows: 1,
      nodes: [
        node({ nodeId: 'table', role: { value: 'table' }, name: { value: '个人课表' }, childIds: ['h', 'r1', 'r2'] }),
        node({ nodeId: 'h', role: { value: 'row' }, childIds: ['c1', 'c2'] }),
        node({ nodeId: 'c1', role: { value: 'columnheader' }, name: { value: '节次' } }),
        node({ nodeId: 'c2', role: { value: 'columnheader' }, name: { value: '星期一' } }),
        node({ nodeId: 'r1', role: { value: 'row' }, childIds: ['a', 'b'] }),
        node({ nodeId: 'a', role: { value: 'cell' }, name: { value: '1-2节' } }),
        node({
          nodeId: 'b',
          role: { value: 'cell' },
          name: { value: '高等数学A(一) 1-16周 理科楼101' },
          childIds: ['go'],
        }),
        node({ nodeId: 'go', role: { value: 'button' }, name: { value: '详情' }, backendDOMNodeId: 7 }),
        node({ nodeId: 'r2', role: { value: 'row' }, childIds: ['d', 'hidden-btn'] }),
        node({ nodeId: 'd', role: { value: 'cell' }, name: { value: '3-4节' } }),
        node({ nodeId: 'hidden-btn', role: { value: 'button' }, name: { value: '不要出现' }, backendDOMNodeId: 8 }),
      ],
    });
    expect(text).toBe(
      [
        'page: 课表  url: https://example.com/kb',
        'table "个人课表" rows=2 cols: 节次 | 星期一',
        '  | 1-2节 | 高等数学A(一) 1-16周 理科楼101 |',
        '[e1] button "详情"',
      ].join('\n'),
    );
    expect(text).not.toContain('不要出现');
    expect(text).not.toContain('3-4节');
  });

  it('renders clickable non-semantic elements and skips ones that contain a control', () => {
    const text = renderSnapshot({
      title: 'nav',
      url: 'https://example.com/',
      clickableBackendNodeIds: new Set([5, 6]),
      nodes: [
        node({ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['home', 'wrap'] }),
        node({ nodeId: 'home', role: { value: 'generic' }, backendDOMNodeId: 5, childIds: ['home-text'] }),
        node({ nodeId: 'home-text', role: { value: 'StaticText' }, name: { value: '首页' } }),
        node({ nodeId: 'wrap', role: { value: 'generic' }, backendDOMNodeId: 6, childIds: ['inner'] }),
        node({ nodeId: 'inner', role: { value: 'button' }, name: { value: '查询' }, backendDOMNodeId: 9 }),
      ],
    });
    expect(text).toBe(
      ['page: nav  url: https://example.com/', '[e1] clickable "首页"', '[e2] button "查询"'].join('\n'),
    );
  });

  it('renders an adapted combobox on the widget and hides its internal links', () => {
    const adapted: AdaptedSelect = {
      selectBackendNodeId: 10,
      widgetBackendNodeId: 11,
      subtreeBackendNodeIds: [11, 12],
      label: '学年',
      selectedText: '2026-2027',
      options: [
        { value: '', text: '---请选择---' },
        { value: '2026', text: '2026-2027' },
        { value: '2025', text: '2025-2026' },
      ],
    };
    const text = renderSnapshot({
      title: 't',
      url: 'https://example.com/',
      adaptedSelects: [adapted],
      nodes: [
        node({ nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['select', 'widget', 'query'] }),
        node({
          nodeId: 'select',
          role: { value: 'combobox' },
          name: { value: '学年' },
          backendDOMNodeId: 10,
          childIds: ['opt'],
        }),
        node({ nodeId: 'opt', role: { value: 'option' }, name: { value: '2025-2026' }, backendDOMNodeId: 14 }),
        node({ nodeId: 'widget', role: { value: 'generic' }, backendDOMNodeId: 11, childIds: ['link'] }),
        node({ nodeId: 'link', role: { value: 'link' }, name: { value: '2026-2027' }, backendDOMNodeId: 12 }),
        node({ nodeId: 'query', role: { value: 'button' }, name: { value: '查询' }, backendDOMNodeId: 13 }),
      ],
    });
    expect(text).toBe(
      [
        'page: t  url: https://example.com/',
        '[e1] combobox "学年" = "2026-2027" (options: 2026-2027, 2025-2026)',
        '[e2] button "查询"',
      ].join('\n'),
    );
    expect(text).not.toContain('link');
    expect(text).not.toContain('请选择');
  });

  it('keeps refs stable for the same backend node and shares them with frames', () => {
    const registry = new RefRegistry();
    const input = {
      title: 't',
      url: 'https://example.com/',
      nodes: [node({ nodeId: 'b', role: { value: 'button' }, name: { value: '查询' }, backendDOMNodeId: 1 })],
      frames: [
        {
          label: 'notice',
          nodes: [
            node({
              nodeId: 'frame-root',
              role: { value: 'RootWebArea' },
              childIds: ['h', 'a'],
            }),
            node({
              nodeId: 'h',
              role: { value: 'heading' },
              name: { value: '选课通知' },
              properties: [{ name: 'level', value: { type: 'integer', value: 2 } }],
            }),
            node({ nodeId: 'a', role: { value: 'link' }, name: { value: '查看详情' }, backendDOMNodeId: 2 }),
          ],
        },
        { label: 'https://other.example/ad', outOfProcess: true },
      ],
      registry,
    };
    const first = renderSnapshot(input);
    const second = renderSnapshot(input);
    expect(first).toBe(second);
    expect(first).toBe(
      [
        'page: t  url: https://example.com/',
        '[e1] button "查询"',
        '--- frame "notice"',
        'h2 "选课通知"',
        '[e2] link "查看详情"',
        '--- frame "https://other.example/ad" (out-of-process, not inspected)',
      ].join('\n'),
    );
  });
});
