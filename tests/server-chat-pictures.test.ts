// Pictures in chats (server/chatPictures.ts, server/chat.ts, server/messages.ts, docs/world.md §24): the public chat room, chats between friends, private
// groups and public groups. A message carries ONE small picture the server checks itself; pictures are slow to send, temporary, kept only for the people
// who may read the message, and a reported one is kept for the owner until the report is closed. The owner can switch pictures off for everybody.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_PIC_KEEP_MS,
  CHAT_PIC_MAX_BYTES,
  CHAT_PIC_MAX_SIDE,
  CHAT_PIC_TOTAL_MAX_BYTES,
  PICTURE_BODY,
  PIC_GAP_MS,
  PIC_PER_HOUR,
  PIC_PUBLIC_WAIT_MS,
} from '../server/chatPictures';
import { MIGRATIONS, migrate } from '../server/schema';
import { Db } from '../server/sqlite';
import { LONG, ageAccounts, dataUrl, db, idOf, jpeg, liveRig, png, requestId, type Running } from './helpers/chatlive';

const { boot, call, signUp } = liveRig('picchat');

const chatSend = (r: Running, cookie: string | undefined, body: Record<string, unknown>) => call(r, '/api/chat/send', { method: 'POST', cookie, body });
const pmPost = (r: Running, cookie: string | undefined, path: string, body: unknown = {}) => call(r, `/api/messages/${path}`, { method: 'POST', cookie, body });
const adminPost = (r: Running, cookie: string, path: string, body: Record<string, unknown> = {}) => call(r, `/api/admin/${path}`, { method: 'POST', cookie, body: { requestId: requestId(), ...body } });
const ask = (r: Running, cookie: string, path: string, name: string) => call(r, `/api/friends/${path}`, { method: 'POST', cookie, body: { username: name } });
async function befriend(r: Running, a: string, aName: string, b: string, bName: string): Promise<void> {
  expect((await ask(r, a, 'request', bName)).status).toBe(200);
  expect((await ask(r, b, 'accept', aName)).status).toBe(200);
}
const GOOD = jpeg(320, 200, 2000);
const pic = (bytes: Uint8Array = GOOD, mime = 'image/jpeg'): string => dataUrl(mime, bytes);
const rows = (r: Running, table: string): number => db(r).get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
const chatList = async (r: Running, cookie: string) => (await call(r, '/api/chat', { cookie })).json.messages as any[];
const threadOf = async (r: Running, cookie: string, id: number) => (await call(r, `/api/messages/thread/${id}`, { cookie })).json.messages as any[];
const prune = (r: Running): number => r.app.services.chatPictures.prune();

/** Alice, Bob, Carol, Dave, the owner (boss) and a moderator (mia), all old enough to write text; the clock is then moved so pictures to everybody are allowed too. */
async function world(r: Running, pictureAge = true) {
  const [alice, bob, carol, dave, boss, mia] = [await signUp(r, 'alice'), await signUp(r, 'bob'), await signUp(r, 'carol'), await signUp(r, 'dave'), await signUp(r, 'boss'), await signUp(r, 'mia')];
  ageAccounts(r);
  expect((await adminPost(r, boss, 'moderator', { username: 'mia', on: true })).status).toBe(200);
  if (pictureAge) r.clock.advanceSeconds(PIC_PUBLIC_WAIT_MS / 1000);
  return { alice, bob, carol, dave, boss, mia };
}
/** Sends in the public chat and then lets the picture pause pass. */
async function shout(r: Running, cookie: string, body: Record<string, unknown>) {
  const res = await chatSend(r, cookie, body);
  r.clock.advanceSeconds(PIC_GAP_MS / 1000 + 1);
  return res;
}

describe('who may look and what a picture may be', () => {
  it('PICCHAT-1: every picture route needs a signed-in player; the switch and the reported-picture view are for the owner', async () => {
    const r = await boot();
    const { alice, mia } = await world(r);
    const wrong: string[] = [];
    for (const [method, path, cookie, want] of [
      ['GET', '/api/chat/picture/1', undefined, 401],
      ['GET', '/api/messages/picture/1', undefined, 401],
      ['POST', '/api/admin/chat/pictures', undefined, 401],
      ['POST', '/api/admin/chat/pictures', alice, 403],
      ['POST', '/api/admin/chat/pictures', mia, 403],
      ['GET', '/api/admin/private-reports/picture/1', alice, 403],
      ['GET', '/api/admin/private-reports/picture/1', mia, 403],
    ] as [string, string, string | undefined, number][]) {
      const res = await call(r, path, { method, cookie, body: method === 'POST' ? { requestId: requestId(), on: false } : undefined });
      if (res.status !== want) wrong.push(`${method} ${path} -> ${res.status}, wanted ${want}`);
    }
    expect(wrong).toEqual([]);
  }, LONG);

  it('PICCHAT-2: a picture alone or with a caption is shown in the room, served with safe headers exactly as sent, and only real small pictures are taken', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    const alone = await shout(r, alice, { picture: pic() });
    expect(alone.status).toBe(200);
    expect(alone.json.message).toMatchObject({ username: 'alice', text: '', picture: 'ok' });
    const caption = await shout(r, alice, { text: 'my cat', picture: pic(png(100, 100, 300), 'image/png') });
    expect(caption.json.message).toMatchObject({ text: 'my cat', picture: 'ok' });
    const seen = await chatList(r, bob);
    expect(seen.map((m) => [m.text, m.picture])).toEqual([['', 'ok'], ['my cat', 'ok']]);
    expect(db(r).get<{ body: string }>('SELECT body FROM chat_messages WHERE id = ?', alone.json.message.id)?.body).toBe(PICTURE_BODY);
    // The bytes come back exactly as they went in, and nothing in them can run.
    const got = await call(r, `/api/chat/picture/${alone.json.message.id}`, { cookie: bob });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(got.bytes).equals(Buffer.from(GOOD))).toBe(true);
    expect((await call(r, '/api/chat/picture/987654', { cookie: bob })).status).toBe(404);
    expect((await call(r, `/api/chat/picture/${seen[0].id - 0}`, { cookie: bob })).status).toBe(200);
    // A message without a picture says so.
    const plain = await shout(r, alice, { text: 'just words' });
    expect(plain.json.message.picture).toBeNull();
    expect((await call(r, `/api/chat/picture/${plain.json.message.id}`, { cookie: bob })).json.error.code).toBe('no_such_message');
    expect(rows(r, 'chat_message_pictures')).toBe(2);
  }, LONG);

  it('PICCHAT-3: anything that is not a real JPEG, PNG or WebP of the right size is refused and nothing is saved', async () => {
    const r = await boot();
    const { alice } = await world(r);
    const tries: [string, unknown, number, string][] = [
      ['a number', 5, 400, 'bad_request'],
      ['not a data address', 'hello', 400, 'bad_image'],
      ['a gif', dataUrl('image/gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])), 400, 'bad_image'],
      ['an svg', dataUrl('image/svg+xml', new TextEncoder().encode('<svg onload="alert(1)"/>')), 400, 'bad_image'],
      ['text that says it is a jpeg', dataUrl('image/jpeg', new TextEncoder().encode('this is not a picture at all')), 400, 'bad_image'],
      ['a png called a jpeg', dataUrl('image/jpeg', png(10, 10)), 400, 'bad_image'],
      ['a picture with no size', dataUrl('image/png', png(0, 0)), 400, 'bad_image'],
      ['bad base64 letters', 'data:image/jpeg;base64,@@@@', 400, 'bad_image'],
      ['empty bytes', 'data:image/jpeg;base64,', 400, 'bad_image'],
      ['too many bytes', dataUrl('image/jpeg', jpeg(100, 100, CHAT_PIC_MAX_BYTES)), 413, 'too_large'],
      ['too wide', dataUrl('image/jpeg', jpeg(CHAT_PIC_MAX_SIDE + 1, 100)), 413, 'too_large'],
      ['too high', dataUrl('image/png', png(100, CHAT_PIC_MAX_SIDE + 1)), 413, 'too_large'],
    ];
    for (const [what, picture, status, code] of tries) {
      const res = await chatSend(r, alice, { picture });
      expect([what, res.status, res.json.error?.code]).toEqual([what, status, code]);
      r.clock.advanceSeconds(2);
    }
    // The largest allowed is fine: exactly CHAT_PIC_MAX_BYTES and CHAT_PIC_MAX_SIDE.
    const biggest = await shout(r, alice, { picture: dataUrl('image/jpeg', jpeg(CHAT_PIC_MAX_SIDE, CHAT_PIC_MAX_SIDE, CHAT_PIC_MAX_BYTES - 29)) });
    expect(biggest.status).toBe(200);
    // Only the one picture was saved; a failed try leaves no message behind.
    expect(rows(r, 'chat_message_pictures')).toBe(1);
    expect(rows(r, 'chat_messages')).toBe(1);
    // A message with neither text nor a picture is still empty.
    expect((await chatSend(r, alice, { text: '   ' })).json.error.code).toBe('empty');
    expect((await chatSend(r, alice, {})).status).toBe(400);
    // (Last, because the server closes the connection after it.) A request much bigger than any picture is refused before it is read.
    const huge = await call(r, '/api/chat/send', { method: 'POST', cookie: alice, raw: JSON.stringify({ picture: 'data:image/jpeg;base64,' + 'A'.repeat(200_000) }) });
    expect(huge.status).toBe(413);
  }, LONG);
});

describe('who may send, and how fast', () => {
  it('PICCHAT-4: a new account may send a picture to friends and in private groups before the first hour, but to everybody only after it; the owner at once', async () => {
    const r = await boot();
    const { alice, bob, boss } = await world(r, false);
    await befriend(r, alice, 'alice', bob, 'bob');
    // Text to everybody works after five minutes; a picture does not yet.
    expect((await chatSend(r, alice, { text: 'hello room' })).status).toBe(200);
    r.clock.advanceSeconds(3);
    const early = await chatSend(r, alice, { picture: pic() });
    expect([early.status, early.json.error.code]).toEqual([403, 'too_new']);
    expect(early.json.error.message).toMatch(/after 60 minutes/);
    // A friend and a private group are fine already.
    const direct = await pmPost(r, alice, 'send', { username: 'bob', picture: pic() });
    expect(direct.status).toBe(200);
    r.clock.advanceSeconds(PIC_GAP_MS / 1000 + 1);
    const group = (await pmPost(r, alice, 'group/create', { title: 'club', usernames: ['bob'] })).json.conversation;
    expect((await pmPost(r, bob, 'respond', { conversationId: group.id, answer: 'accept' })).status).toBe(200);
    expect((await pmPost(r, alice, 'send', { conversationId: group.id, picture: pic() })).status).toBe(200);
    r.clock.advanceSeconds(PIC_GAP_MS / 1000 + 1);
    // A public group is for everybody, so it waits as the room does.
    const open = (await pmPost(r, alice, 'group/create', { title: 'open', usernames: [], visibility: 'public' })).json.conversation;
    const wait = await pmPost(r, alice, 'send', { conversationId: open.id, picture: pic() });
    expect([wait.status, wait.json.error.code]).toEqual([403, 'too_new']);
    // The owner does not wait.
    expect((await chatSend(r, boss, { picture: pic() })).status).toBe(200);
    // After the hour all places are open.
    r.clock.advanceSeconds(PIC_PUBLIC_WAIT_MS / 1000);
    expect((await chatSend(r, alice, { picture: pic() })).status).toBe(200);
    r.clock.advanceSeconds(PIC_GAP_MS / 1000 + 1);
    expect((await pmPost(r, alice, 'send', { conversationId: open.id, picture: pic() })).status).toBe(200);
  }, LONG);

  it('PICCHAT-5: there are 15 seconds between pictures and 20 in an hour for a player (the owner may send more); text is not slowed by it', async () => {
    const r = await boot();
    const { alice, boss } = await world(r);
    expect((await chatSend(r, alice, { picture: pic() })).status).toBe(200);
    r.clock.advanceSeconds(3);
    const quick = await chatSend(r, alice, { picture: pic() });
    expect([quick.status, quick.json.error.code]).toEqual([429, 'too_fast']);
    expect(quick.json.error.message).toMatch(/Wait \d+ seconds before sending another picture/);
    // Text is only held by the ordinary pause.
    expect((await chatSend(r, alice, { text: 'words are fine' })).status).toBe(200);
    r.clock.advanceSeconds(PIC_GAP_MS / 1000);
    let sent = 1;
    let last = 200;
    while (sent < PIC_PER_HOUR + 1 && last === 200) {
      r.clock.advanceSeconds(2);
      const res = await chatSend(r, alice, { picture: pic() });
      last = res.status;
      if (last === 200) sent += 1;
      else {
        expect([res.status, res.json.error.code]).toEqual([429, 'picture_limit']);
      }
      r.clock.advanceSeconds(PIC_GAP_MS / 1000);
    }
    expect(sent).toBe(PIC_PER_HOUR);
    expect(last).toBe(429);
    // The hour passes and she can send again.
    r.clock.advanceSeconds(3600);
    expect((await chatSend(r, alice, { picture: pic() })).status).toBe(200);
    // The owner has no hourly limit (only the pause).
    for (let i = 0; i < PIC_PER_HOUR + 2; i += 1) {
      expect((await shout(r, boss, { picture: pic() })).status).toBe(200);
    }
  }, LONG);

  it('PICCHAT-6: the owner switches pictures off for everybody (text keeps working) and on again; it is logged once, shown in the admin view and kept over a restart', async () => {
    const r = await boot();
    const { alice, bob, boss, mia } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    expect((await call(r, '/api/admin/chat', { cookie: boss })).json.picturesOn).toBe(true);
    const id = requestId();
    const off = await call(r, '/api/admin/chat/pictures', { method: 'POST', cookie: boss, body: { requestId: id, on: false } });
    expect([off.status, off.json.picturesOn, off.json.duplicate]).toEqual([200, false, false]);
    const again = await call(r, '/api/admin/chat/pictures', { method: 'POST', cookie: boss, body: { requestId: id, on: false } });
    expect([again.status, again.json.duplicate]).toEqual([200, true]);
    expect(db(r).all<{ action: string; target: string }>("SELECT action, target FROM admin_log WHERE action = 'chat_pictures'")).toEqual([{ action: 'chat_pictures', target: 'off' }]);
    expect((await call(r, '/api/admin/chat', { cookie: mia })).json.picturesOn).toBe(false);
    for (const res of [await chatSend(r, alice, { picture: pic() }), await pmPost(r, alice, 'send', { username: 'bob', picture: pic() }), await chatSend(r, boss, { picture: pic() })]) {
      expect([res.status, res.json.error.code]).toEqual([403, 'pictures_off']);
    }
    expect((await chatSend(r, alice, { text: 'text still works' })).status).toBe(200);
    expect((await pmPost(r, alice, 'send', { username: 'bob', text: 'and here too' })).status).toBe(200);
    expect((await call(r, '/api/admin/chat/pictures', { method: 'POST', cookie: boss, body: { requestId: requestId(), on: 'no' } })).status).toBe(400);
    // The setting lives in the database, so a restart keeps it.
    expect(r.app.services.chatPictures.enabled()).toBe(false);
    expect((await adminPost(r, boss, 'chat/pictures', { on: true })).json.picturesOn).toBe(true);
    r.clock.advanceSeconds(20);
    expect((await chatSend(r, alice, { picture: pic() })).status).toBe(200);
    // Pictures sent before the switch stay readable while it is off.
    await adminPost(r, boss, 'chat/pictures', { on: false });
    expect((await call(r, `/api/chat/picture/${(await chatList(r, alice))[1].id}`, { cookie: bob })).status).toBe(200);
  }, LONG);
});

describe('chats between players', () => {
  it('PICCHAT-7: friends send each other pictures; a message request (not friends yet) is text only; the picture is for the two of them only', async () => {
    const r = await boot();
    const { alice, bob, carol } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const sent = await pmPost(r, alice, 'send', { username: 'bob', text: 'look', picture: pic() });
    expect(sent.status).toBe(200);
    expect(sent.json.message).toMatchObject({ text: 'look', picture: 'ok' });
    const id = sent.json.message.id;
    const conv = sent.json.conversationId;
    expect((await threadOf(r, bob, conv)).map((m) => [m.text, m.picture])).toEqual([['look', 'ok']]);
    const got = await call(r, `/api/messages/picture/${id}`, { cookie: bob });
    expect([got.status, got.headers.get('content-type'), got.headers.get('x-content-type-options')]).toEqual([200, 'image/jpeg', 'nosniff']);
    expect(Buffer.from(got.bytes).equals(Buffer.from(GOOD))).toBe(true);
    // Not carol, not someone signed out.
    expect((await call(r, `/api/messages/picture/${id}`, { cookie: carol })).status).toBe(404);
    expect((await call(r, `/api/messages/picture/${id}`)).status).toBe(401);
    // A picture alone has the placeholder in the database and no text for the page.
    r.clock.advanceSeconds(PIC_GAP_MS / 1000 + 1);
    const alone = await pmPost(r, bob, 'send', { conversationId: conv, picture: pic(png(64, 64, 100), 'image/png') });
    expect(alone.json.message).toMatchObject({ text: '', picture: 'ok' });
    expect(db(r).get<{ body: string }>('SELECT body FROM private_messages WHERE id = ?', alone.json.message.id)?.body).toBe(PICTURE_BODY);
    // Strangers: the first message is a request and must be text.
    const request = await pmPost(r, alice, 'send', { username: 'carol', picture: pic() });
    expect([request.status, request.json.error.code]).toEqual([403, 'friends_only']);
    expect(rows(r, 'private_message_pictures')).toBe(2);
    // After carol says yes to the request they can talk, but pictures wait for friendship.
    expect((await pmPost(r, alice, 'send', { username: 'carol', text: 'hi carol' })).status).toBe(200);
    r.clock.advanceSeconds(3);
    const cid = db(r).get<{ id: number }>("SELECT id FROM conversations WHERE kind = 'direct' AND request IS NOT NULL")?.id as number;
    expect((await pmPost(r, carol, 'respond', { conversationId: cid, answer: 'accept' })).status).toBe(200);
    for (const [who, cookie] of [['alice', alice], ['carol', carol]] as const) {
      const res = await pmPost(r, cookie, 'send', { conversationId: cid, picture: pic() });
      expect([who, res.status, res.json.error.code]).toEqual([who, 403, 'friends_only']);
      r.clock.advanceSeconds(3);
    }
    await befriend(r, alice, 'alice', carol, 'carol');
    expect((await pmPost(r, carol, 'send', { conversationId: cid, picture: pic() })).status).toBe(200);
  }, LONG);

  it('PICCHAT-8: in a private group every member sees pictures from the day he joined; in a public group the same; leaving, blocking or being removed ends it', async () => {
    const r = await boot();
    const { alice, bob, carol, dave } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    const group = (await pmPost(r, alice, 'group/create', { title: 'club', usernames: ['bob', 'carol'] })).json.conversation;
    for (const cookie of [bob, carol]) expect((await pmPost(r, cookie, 'respond', { conversationId: group.id, answer: 'accept' })).status).toBe(200);
    const early = await pmPost(r, alice, 'send', { conversationId: group.id, picture: pic() });
    r.clock.advanceSeconds(PIC_GAP_MS / 1000 + 1);
    for (const cookie of [alice, bob, carol]) expect((await call(r, `/api/messages/picture/${early.json.message.id}`, { cookie })).status).toBe(200);
    expect((await call(r, `/api/messages/picture/${early.json.message.id}`, { cookie: dave })).status).toBe(404);
    // Carol blocks alice: carol no longer sees alice's pictures.
    expect((await pmPost(r, carol, 'block', { username: 'alice' })).status).toBe(200);
    expect((await call(r, `/api/messages/picture/${early.json.message.id}`, { cookie: carol })).status).toBe(404);
    expect((await call(r, `/api/messages/picture/${early.json.message.id}`, { cookie: bob })).status).toBe(200);
    expect((await pmPost(r, bob, 'group/leave', { conversationId: group.id })).status).toBe(200);
    expect((await call(r, `/api/messages/picture/${early.json.message.id}`, { cookie: bob })).status).toBe(404);
    // A public group: someone who joins later does not see what was shown before.
    const open = (await pmPost(r, alice, 'group/create', { title: 'open', usernames: [], visibility: 'public' })).json.conversation;
    const shown = await pmPost(r, alice, 'send', { conversationId: open.id, picture: pic() });
    expect(shown.status).toBe(200);
    expect((await pmPost(r, dave, 'group/join', { conversationId: open.id })).status).toBe(200);
    expect((await call(r, `/api/messages/picture/${shown.json.message.id}`, { cookie: dave })).status).toBe(404);
    r.clock.advanceSeconds(PIC_GAP_MS / 1000 + 1);
    const later = await pmPost(r, alice, 'send', { conversationId: open.id, picture: pic() });
    expect((await call(r, `/api/messages/picture/${later.json.message.id}`, { cookie: dave })).status).toBe(200);
    // The maker takes dave out: the pictures are not his any more.
    expect((await pmPost(r, alice, 'group/remove', { conversationId: open.id, username: 'dave' })).status).toBe(200);
    expect((await call(r, `/api/messages/picture/${later.json.message.id}`, { cookie: dave })).status).toBe(404);
  }, LONG);
});

describe('pictures are temporary', () => {
  it('PICCHAT-9: after 7 days the bytes are gone, the message stays with "picture expired", the address says gone, and what was written is kept', async () => {
    const r = await boot();
    const { alice, bob } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const room = await shout(r, alice, { text: 'old cat', picture: pic() });
    const direct = await pmPost(r, alice, 'send', { username: 'bob', text: 'old dog', picture: pic() });
    r.clock.advanceSeconds(PIC_GAP_MS / 1000 + 1);
    // Six days later nothing has changed.
    r.clock.advanceSeconds((CHAT_PIC_KEEP_MS / 1000) - 86_400);
    expect(prune(r)).toBe(0);
    r.clock.advanceSeconds(86_400);
    // Sending a picture cleans up old ones by itself; a clean-up right after has nothing left to do.
    const fresh = await shout(r, alice, { picture: pic(png(30, 30, 50), 'image/png') });
    expect(prune(r)).toBe(0);
    const msgs = await chatList(r, bob);
    expect(msgs.map((m) => [m.text, m.picture])).toEqual([['old cat', 'expired'], ['', 'ok']]);
    expect((await threadOf(r, bob, direct.json.conversationId)).map((m) => [m.text, m.picture])).toEqual([['old dog', 'expired']]);
    for (const url of [`/api/chat/picture/${room.json.message.id}`, `/api/messages/picture/${direct.json.message.id}`]) {
      const res = await call(r, url, { cookie: bob });
      expect([res.status, res.json.error.code]).toEqual([404, 'no_such_message']);
    }
    expect((await call(r, `/api/chat/picture/${fresh.json.message.id}`, { cookie: bob })).status).toBe(200);
    // The rows stay (so the page can say "expired"), the bytes are empty.
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_message_pictures WHERE data IS NULL')?.n).toBe(1);
    expect(r.app.services.chatPictures.usedBytes()).toBe(png(30, 30, 50).length);
  }, LONG);

  it('PICCHAT-10: all pictures together are kept up to 20 MB; when there are more the oldest go first, except a reported picture of the room', async () => {
    const r = await boot();
    const { alice, bob, boss } = await world(r);
    const me = idOf(r, 'alice');
    const now = r.clock.now();
    const blob = Buffer.alloc(128 * 1024, 7);
    const count = Math.floor(CHAT_PIC_TOTAL_MAX_BYTES / blob.length) + 10;
    const ids: number[] = [];
    db(r).tx(() => {
      for (let i = 0; i < count; i += 1) {
        const id = db(r).run('INSERT INTO chat_messages(user_id, body, created_ms) VALUES (?, ?, ?)', me, PICTURE_BODY, now - (count - i) * 1000).lastInsertRowid;
        db(r).run("INSERT INTO chat_message_pictures(message_id, mime, data, created_ms) VALUES (?, 'image/jpeg', ?, ?)", id, blob, now - (count - i) * 1000);
        ids.push(id);
      }
    });
    expect(r.app.services.chatPictures.usedBytes()).toBeGreaterThan(CHAT_PIC_TOTAL_MAX_BYTES);
    // Bob reports the oldest one: it is not touched; the next oldest are emptied instead.
    expect((await call(r, '/api/chat/report', { method: 'POST', cookie: bob, body: { messageId: ids[0] } })).status).toBe(200);
    expect(prune(r)).toBe(10);
    expect(r.app.services.chatPictures.usedBytes()).toBeLessThanOrEqual(CHAT_PIC_TOTAL_MAX_BYTES);
    const empty = db(r).all<{ message_id: number }>('SELECT message_id FROM chat_message_pictures WHERE data IS NULL ORDER BY message_id').map((x) => x.message_id);
    expect(empty).toEqual(ids.slice(1, 11));
    expect(db(r).get<{ n: number }>('SELECT length(data) AS n FROM chat_message_pictures WHERE message_id = ?', ids[0] as number)?.n).toBe(blob.length);
    expect(boss).toBeTruthy();
    expect(alice).toBeTruthy();
  }, LONG);
});

describe('deleting and reporting', () => {
  it('PICCHAT-11: deleting your own picture message empties it at once; the owner and a moderator deleting someone else\'s does too', async () => {
    const r = await boot();
    const { alice, bob, boss, mia } = await world(r);
    const mine = await shout(r, alice, { picture: pic() });
    expect((await call(r, '/api/chat/delete', { method: 'POST', cookie: alice, body: { messageId: mine.json.message.id } })).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_message_pictures WHERE data IS NOT NULL')?.n).toBe(0);
    expect((await call(r, `/api/chat/picture/${mine.json.message.id}`, { cookie: bob })).status).toBe(404);
    const theirs = await shout(r, bob, { text: 'for the moderator', picture: pic() });
    expect((await adminPost(r, mia, 'chat/delete', { messageId: theirs.json.message.id })).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_message_pictures WHERE data IS NOT NULL')?.n).toBe(0);
    const third = await shout(r, bob, { picture: pic() });
    expect((await adminPost(r, boss, 'chat/delete', { messageId: third.json.message.id })).status).toBe(200);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_message_pictures WHERE data IS NOT NULL')?.n).toBe(0);
    expect(rows(r, 'chat_message_pictures')).toBe(3);
  }, LONG);

  it('PICCHAT-12: a reported picture of the room stays for the owner and the moderators even if the writer deletes it; closing the report empties it', async () => {
    const r = await boot();
    const { alice, bob, carol, boss, mia } = await world(r);
    const sent = await shout(r, alice, { text: 'rude', picture: pic() });
    const id = sent.json.message.id;
    expect((await call(r, '/api/chat/report', { method: 'POST', cookie: bob, body: { messageId: id } })).status).toBe(200);
    // The owner's list shows that the report is about a picture.
    const listed = (await call(r, '/api/admin/chat', { cookie: boss })).json;
    expect(listed.reports).toMatchObject([{ messageId: id, text: 'rude', picture: 'ok' }]);
    // The writer deletes his message: players can no longer open it, the staff still can.
    expect((await call(r, '/api/chat/delete', { method: 'POST', cookie: alice, body: { messageId: id } })).status).toBe(200);
    expect((await call(r, `/api/chat/picture/${id}`, { cookie: carol })).status).toBe(404);
    expect((await call(r, `/api/chat/picture/${id}`, { cookie: alice })).status).toBe(404);
    for (const cookie of [boss, mia]) expect((await call(r, `/api/chat/picture/${id}`, { cookie })).status).toBe(200);
    // It also stays through the clean-up, even after a week.
    r.clock.advanceSeconds(CHAT_PIC_KEEP_MS / 1000 + 5);
    expect(prune(r)).toBe(0);
    expect((await call(r, `/api/chat/picture/${id}`, { cookie: boss })).status).toBe(200);
    // The owner closes the report: the bytes go and the next clean-up has nothing to do.
    expect((await adminPost(r, boss, 'chat/dismiss', { messageId: id })).status).toBe(200);
    expect(prune(r)).toBe(1);
    expect((await call(r, `/api/chat/picture/${id}`, { cookie: boss })).status).toBe(404);
  }, LONG);

  it('PICCHAT-13: the picture of a player the owner banned from the game is not shown to players any more', async () => {
    const r = await boot();
    const { alice, bob, boss } = await world(r);
    const sent = await shout(r, alice, { picture: pic() });
    expect((await call(r, `/api/chat/picture/${sent.json.message.id}`, { cookie: bob })).status).toBe(200);
    expect((await adminPost(r, boss, 'ban', { username: 'alice', reason: 'rude', hours: 24 })).status).toBe(200);
    expect((await call(r, `/api/chat/picture/${sent.json.message.id}`, { cookie: bob })).status).toBe(404);
    expect((await chatList(r, bob)).some((m) => m.username === 'alice')).toBe(false);
  }, LONG);

  it('PICCHAT-14: a reported private picture is copied into the report for the owner only; deleting the message does not take the copy; closing the report does', async () => {
    const r = await boot();
    const { alice, bob, carol, boss, mia } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    const sent = await pmPost(r, alice, 'send', { username: 'bob', text: 'bad picture', picture: pic() });
    const id = sent.json.message.id;
    // Before any report the owner and the moderator cannot see it, nor can a bystander.
    for (const cookie of [boss, mia, carol]) expect((await call(r, `/api/messages/picture/${id}`, { cookie })).status).toBe(404);
    expect((await call(r, `/api/admin/private-reports/picture/${id}`, { cookie: boss })).status).toBe(404);
    expect((await pmPost(r, bob, 'report', { messageId: id })).status).toBe(200);
    expect((await pmPost(r, alice, 'delete', { messageId: id })).status).toBe(200);
    // Nobody in the chat can open it now; the report still has its own copy.
    for (const cookie of [alice, bob]) expect((await call(r, `/api/messages/picture/${id}`, { cookie })).status).toBe(404);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM private_message_pictures WHERE data IS NOT NULL')?.n).toBe(0);
    const view = (await call(r, '/api/admin/private-reports', { cookie: boss })).json.reports;
    expect(view).toMatchObject([{ messageId: id, picture: true, lines: [{ username: 'alice', text: 'bad picture', reported: true, picture: true }] }]);
    const copy = await call(r, `/api/admin/private-reports/picture/${id}`, { cookie: boss });
    expect([copy.status, copy.headers.get('content-type'), copy.headers.get('x-content-type-options')]).toEqual([200, 'image/jpeg', 'nosniff']);
    expect(Buffer.from(copy.bytes).equals(Buffer.from(GOOD))).toBe(true);
    for (const cookie of [alice, bob, carol, mia]) expect((await call(r, `/api/admin/private-reports/picture/${id}`, { cookie })).status).toBe(403);
    // It also outlives the clean-up of old pictures.
    r.clock.advanceSeconds(CHAT_PIC_KEEP_MS / 1000 + 5);
    prune(r);
    expect((await call(r, `/api/admin/private-reports/picture/${id}`, { cookie: boss })).status).toBe(200);
    // Closing the report removes the copy.
    expect((await adminPost(r, boss, 'private-reports/dismiss', { messageId: id })).status).toBe(200);
    expect((await call(r, `/api/admin/private-reports/picture/${id}`, { cookie: boss })).status).toBe(404);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM private_reports WHERE picture IS NOT NULL')?.n).toBe(0);
  }, LONG);

  it('PICCHAT-15: a picture that had expired before it was reported has no copy; reporting it twice makes one copy; a text report shows no picture', async () => {
    const r = await boot();
    const { alice, bob, carol, boss } = await world(r);
    await befriend(r, alice, 'alice', bob, 'bob');
    await befriend(r, alice, 'alice', carol, 'carol');
    const group = (await pmPost(r, alice, 'group/create', { title: 'club', usernames: ['bob', 'carol'] })).json.conversation;
    for (const cookie of [bob, carol]) await pmPost(r, cookie, 'respond', { conversationId: group.id, answer: 'accept' });
    const old = await pmPost(r, alice, 'send', { conversationId: group.id, picture: pic() });
    r.clock.advanceSeconds(CHAT_PIC_KEEP_MS / 1000 + 5);
    prune(r);
    const text = await pmPost(r, alice, 'send', { conversationId: group.id, text: 'plain words' });
    r.clock.advanceSeconds(2);
    const fresh = await pmPost(r, alice, 'send', { conversationId: group.id, picture: pic(png(20, 20, 40), 'image/png') });
    r.clock.advanceSeconds(3);
    expect((await pmPost(r, bob, 'report', { messageId: old.json.message.id })).status).toBe(200);
    expect((await pmPost(r, bob, 'report', { messageId: text.json.message.id })).status).toBe(200);
    expect((await pmPost(r, bob, 'report', { messageId: fresh.json.message.id })).status).toBe(200);
    expect((await pmPost(r, carol, 'report', { messageId: fresh.json.message.id })).status).toBe(200);
    const reports = (await call(r, '/api/admin/private-reports', { cookie: boss })).json.reports as any[];
    const by = (messageId: number) => reports.find((x) => x.messageId === messageId);
    expect([by(old.json.message.id).picture, by(text.json.message.id).picture, by(fresh.json.message.id).picture]).toEqual([false, false, true]);
    expect(by(fresh.json.message.id).reporters).toBe(2);
    expect(db(r).get<{ n: number }>('SELECT COUNT(*) AS n FROM private_reports WHERE picture IS NOT NULL')?.n).toBe(1);
    expect((await call(r, `/api/admin/private-reports/picture/${old.json.message.id}`, { cookie: boss })).status).toBe(404);
    expect(Buffer.from((await call(r, `/api/admin/private-reports/picture/${fresh.json.message.id}`, { cookie: boss })).bytes).equals(Buffer.from(png(20, 20, 40)))).toBe(true);
  }, LONG);
});

describe('what an old database keeps', () => {
  it('PICCHAT-16: version 26 adds empty picture tables; a picture over 128 KB is refused by the table; deleting a message deletes its picture row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-pic-mig-'));
    const d = new Db(join(dir, 'old.sqlite'));
    try {
      d.tx(() => {
        for (const m of MIGRATIONS.filter((x) => x.version <= 25)) {
          d.exec(m.sql);
          d.exec(`PRAGMA user_version = ${m.version}`);
        }
      });
      d.run("INSERT INTO users(username, display_name, pw_hash, role, created_ms) VALUES ('a', 'a', 'x', 'player', 1)");
      d.run("INSERT INTO chat_messages(user_id, body, created_ms) VALUES (1, 'old message', 5)");
      d.run("INSERT INTO conversations(kind, title, created_by, created_ms, last_ms) VALUES ('group', 'g', 1, 5, 5)");
      d.run("INSERT INTO private_messages(conversation_id, user_id, body, created_ms) VALUES (1, 1, 'old words', 5)");
      d.run("INSERT INTO private_reports(message_id, conversation_id, reporter_id, author_id, created_ms, context_json) VALUES (1, 1, 1, 1, 6, '[]')");
      expect(migrate(d)).toEqual([26, 27, 28, 29]);
      for (const t of ['chat_message_pictures', 'private_message_pictures']) expect(d.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n).toBe(0);
      expect(d.get<{ body: string }>('SELECT body FROM chat_messages WHERE id = 1')?.body).toBe('old message');
      expect(d.get<{ picture: unknown }>('SELECT picture FROM private_reports WHERE message_id = 1')?.picture).toBeNull();
      d.run("INSERT INTO chat_message_pictures(message_id, mime, data, created_ms) VALUES (1, 'image/jpeg', ?, 7)", Buffer.alloc(131_072));
      expect(() => d.run("INSERT INTO private_message_pictures(message_id, mime, data, created_ms) VALUES (1, 'image/jpeg', ?, 7)", Buffer.alloc(131_073))).toThrow();
      expect(() => d.run("INSERT INTO private_message_pictures(message_id, mime, data, created_ms) VALUES (1, 'image/gif', ?, 7)", Buffer.alloc(10))).toThrow();
      expect(() => d.run("INSERT INTO chat_message_pictures(message_id, mime, data, created_ms) VALUES (99, 'image/jpeg', ?, 7)", Buffer.alloc(10))).toThrow();
      d.run('DELETE FROM chat_messages WHERE id = 1');
      expect(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_message_pictures')?.n).toBe(0);
      expect(migrate(d)).toEqual([]);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, LONG);
});
