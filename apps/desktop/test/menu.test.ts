import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenu, MENU_ROUTES } from '../src/main/menu.ts';
import { isMenuRoute } from '../src/shared/ipc.ts';

function actions() {
  const calls: string[] = [];
  return {
    calls,
    a: {
      navigate: (h: string) => calls.push(`nav ${h}`),
      back: () => calls.push('back'),
      forward: () => calls.push('forward'),
      showCoreLog: () => calls.push('log'),
      openDataDir: () => calls.push('data'),
    },
  };
}

function items(menu: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return menu.flatMap((m) => [m, ...(Array.isArray(m.submenu) ? items(m.submenu) : [])]);
}

function byLabel(menu: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const it = items(menu).find((m) => m.label === label);
  assert.ok(it, `menu item ${label}`);
  return it;
}

function click(item: MenuItemConstructorOptions): void {
  (item.click as () => void)();
}

test('macOS: the app menu is named bizzi, with About, Settings, Hide and Quit', () => {
  const { a } = actions();
  const menu = appMenu('darwin', a);
  assert.equal(menu[0]!.label, 'bizzi');
  const labels = items(menu).map((m) => m.label).filter(Boolean);
  for (const l of ['About bizzi', 'Settings…', 'Hide bizzi', 'Quit bizzi']) assert.ok(labels.includes(l), l);
  assert.ok(!items(menu).some((m) => /electron/i.test(String(m.label ?? ''))), 'no Electron in any label');
  assert.deepEqual(
    menu.map((m) => m.label ?? m.role),
    ['bizzi', 'File', 'editMenu', 'View', 'Go', 'windowMenu', 'help'],
  );
});

test('Windows / Linux: no app menu; Settings and Quit live in File, About in Help', () => {
  const { a } = actions();
  const menu = appMenu('linux', a);
  assert.equal(menu[0]!.label, 'File');
  const file = menu[0]!.submenu as MenuItemConstructorOptions[];
  assert.ok(file.some((m) => m.label === 'Settings…'));
  assert.ok(file.some((m) => m.role === 'quit' && m.label === 'Quit bizzi'));
  const help = menu.at(-1)!.submenu as MenuItemConstructorOptions[];
  assert.ok(help.some((m) => m.role === 'about' && m.label === 'About bizzi'));
});

test('items open their UI routes and actions; accelerators are unique', () => {
  const { a, calls } = actions();
  const menu = appMenu('darwin', a);
  click(byLabel(menu, 'New Prompt…'));
  click(byLabel(menu, 'Add Workspace…'));
  click(byLabel(menu, 'Pair a Device…'));
  click(byLabel(menu, 'Settings…'));
  click(byLabel(menu, 'Inbox'));
  click(byLabel(menu, 'Back'));
  click(byLabel(menu, 'Show Core Log'));
  click(byLabel(menu, 'Open Data Folder'));
  assert.deepEqual(calls, [
    `nav ${MENU_ROUTES.ask}`,
    `nav ${MENU_ROUTES.addWorkspace}`,
    `nav ${MENU_ROUTES.devices}`,
    `nav ${MENU_ROUTES.settings}`,
    `nav ${MENU_ROUTES.inbox}`,
    'back',
    'log',
    'data',
  ]);
  const accels = items(menu).flatMap((m) => (m.accelerator ? [String(m.accelerator)] : []));
  assert.equal(new Set(accels).size, accels.length, `duplicate accelerator in ${accels.join(', ')}`);
});

test('menu routes pass the preload check; anything else does not', () => {
  for (const r of Object.values(MENU_ROUTES)) assert.ok(isMenuRoute(r), r);
  for (const bad of ['https://x.example', 'javascript:alert(1)', '#/a b', '#x', '/inbox', 42, '#/' + 'a'.repeat(300)]) {
    assert.equal(isMenuRoute(bad), false, String(bad));
  }
});
