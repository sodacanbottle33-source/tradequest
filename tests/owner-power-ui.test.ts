// Source-level checks for the owner's new screens (like admin-ui.test.ts and moderation-ui.test.ts): the Banned tab in the owner's Players list and the
// moderators' list, the "Change username" card, the "Delete message" button on a reported private message, and the words in the admin log. The screens
// only send requests; the server decides and checks everything again.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Owner screens: Banned tab, change username, delete a reported message', () => {
  it('OWNUI-1: the owner\'s Players page has a Players tab and a Banned tab; a ban sends the player to the Banned tab and clears the selection', () => {
    const page = code(src('shared', 'AdminPlayers.tsx'));
    expect(page).toMatch(/data-testid="admin-view-players"/);
    expect(page).toMatch(/data-testid="admin-view-banned"/);
    expect(page).toMatch(/useState<'players' \| 'banned'>\('players'\)/); // opens on the normal list
    expect(page).toContain('bannedPlayers'); // the list comes from the server's second list
    expect(page).toMatch(/view === 'banned' \? [\s\S]{0,40}bannedPlayers/);
    expect(page).toMatch(/Banned tab/); // the ban message says where he went
    // Changing tabs drops the selected player and any open "are you sure" box.
    expect(page).toMatch(/setView\('banned'\); setSelected\(null\); setConfirm\(null\);/);
    expect(page).toMatch(/setView\('players'\); setSelected\(null\); setConfirm\(null\);/);
    // Nothing on the page decides who is banned: the lists come from the server's state.
    expect(page).not.toMatch(/\.filter\([^)]*banned/);
  });

  it('OWNUI-2: the moderators\' page has the same two tabs, asks the server for the right list, and reloads when the tab or the search changes', () => {
    const page = code(src('shared', 'ModScreen.tsx'));
    expect(page).toMatch(/data-testid="mod-view-players"/);
    expect(page).toMatch(/data-testid="mod-view-banned"/);
    expect(page).toMatch(/api\.modPlayers\(queryRef\.current, viewRef\.current === 'banned'\)/);
    expect(page).toMatch(/\[query, view, load\]/);
    expect(page).toMatch(/Nobody is banned\./);
    expect(page).toMatch(/are on the Banned tab now/);
    const api = code(src('shared', 'api.ts'));
    expect(api).toMatch(/modPlayers: \(q = '', banned = false\)/);
    expect(api).toMatch(/banned \? 'banned=1' : ''/);
  });

  it('OWNUI-3: the "Change username" card is the owner\'s, needs a second press to confirm, never offers the owner\'s own row, and only sends a request', () => {
    const page = code(src('shared', 'AdminPlayers.tsx'));
    for (const id of ['admin-rename', 'admin-rename-start', 'admin-rename-confirm-box', 'admin-rename-confirm', 'admin-rename-cancel']) expect(page).toContain(`data-testid="${id}"`);
    expect(page).toMatch(/api\.adminRename\(\{ requestId: confirm\.id, username: player\.username, newUsername: newName\.trim\(\) \}\)/);
    expect(page).toMatch(/confirm\?\.type !== 'rename'/); // the request is sent only after "Change username…" was pressed
    expect(page).toMatch(/\/\^\[A-Za-z0-9_\]\{3,20\}\$\//); // the same shape the server accepts, only to switch the button on and off
    expect(page).toMatch(/isOwnerRow && <p className="hint">The owner&apos;s username is set on the server/);
    expect(page).toMatch(/It costs them nothing/);
    // The card does not rename anything by itself or touch the list.
    expect(page).not.toMatch(/username:\s*newName/);
    const api = code(src('shared', 'api.ts'));
    expect(api).toMatch(/adminRename: [\s\S]{0,200}'POST', '\/api\/admin\/rename'/);
    // Moderators never get that card.
    expect(code(src('shared', 'ModScreen.tsx'))).not.toMatch(/adminRename|Change username/);
  });

  it('OWNUI-4: a reported private message has a "Delete message" button that asks first and then calls the owner-only route; the hint says the owner reads only reports', () => {
    const page = code(src('shared', 'AdminChat.tsx'));
    expect(page).toMatch(/useState<number \| null>\(null\)/);
    for (const id of ['admin-private-delete-${r.messageId}', 'admin-private-delete-yes-${r.messageId}', 'admin-private-delete-no-${r.messageId}']) expect(page).toContain(id);
    expect(page).toContain('Delete message');
    expect(page).toContain('Yes, delete it');
    expect(page).toMatch(/api\.adminPrivateDelete\(\{ requestId: newRequestId\(\), messageId: r\.messageId \}\)/);
    expect(page).toMatch(/Message deleted for everybody in the chat\./);
    const api = code(src('shared', 'api.ts'));
    expect(api).toMatch(/adminPrivateDelete: [\s\S]{0,200}'\/api\/admin\/private-reports\/delete'/);
    // The moderators' page has no way to open the private reports at all.
    expect(code(src('shared', 'ModScreen.tsx'))).not.toMatch(/adminPrivateDelete|private-reports/);
  });

  it('OWNUI-5: the admin log says what happened in plain words for a deleted message and a changed username', () => {
    const log = code(src('shared', 'AdminLog.tsx'));
    expect(log).toMatch(/case 'pm_delete':\s*return `deleted a reported private message by \$\{String\(d\.author\)\}/);
    expect(log).toMatch(/case 'user_rename':\s*return `changed the username \$\{e\.target\} to \$\{String\(d\.to\)\}`/);
  });
});
