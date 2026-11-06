// COMMENT-20 … COMMENT-26 — the comment screens: the small decisions they make (pure helpers) and source-level checks that the browser only asks and shows: it never makes up
// a rule the server owns, shows every comment as plain text, talks to the server only through api.ts, and every class it uses is styled.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agoText, answersText, canLikeComment, canModerateComment, canReportComment, COMMENT_REFRESH_MS, commentsText, joinPages, withLike } from '../src/shared/commentsUtil';
import type { CommentItem } from '../src/shared/types';

const read = (...parts: string[]): string => readFileSync(resolve(process.cwd(), ...parts), 'utf8');
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SCREENS = ['CommentsPanel.tsx', 'RecentComments.tsx'].map((f) => `src/shared/${f}`);

const item = (id: number, replies: number[] = []): CommentItem => ({
  id,
  username: `u${id}`,
  displayName: `U${id}`,
  role: 'player',
  text: `comment ${id}`,
  createdMs: id,
  likes: 0,
  liked: false,
  mine: false,
  replies: replies.map((r) => ({ id: r, username: 'x', displayName: 'X', role: 'player', text: `answer ${r}`, createdMs: r, likes: 0, liked: false, mine: false })),
});

describe('Comment screens: small decisions', () => {
  it('COMMENT-20: how long ago a comment was written, and the counts in words', () => {
    const now = 10_000_000_000;
    expect(agoText(now, now)).toBe('just now');
    expect(agoText(now, now - 44_000)).toBe('just now');
    expect(agoText(now, now + 5_000)).toBe('just now'); // a clock a little behind the server's never shows a negative time
    expect(agoText(now, now - 60_000)).toBe('1 min ago');
    expect(agoText(now, now - 5 * 60_000)).toBe('5 min ago');
    expect(agoText(now, now - 59 * 60_000)).toBe('59 min ago');
    expect(agoText(now, now - 60 * 60_000)).toBe('1 h ago');
    expect(agoText(now, now - 5 * 3_600_000)).toBe('5 h ago');
    expect(agoText(now, now - 47 * 3_600_000)).toBe('47 h ago');
    expect(agoText(now, now - 72 * 3_600_000)).toBe('3 days ago');
    expect(answersText(1)).toBe('1 answer');
    expect(answersText(3)).toBe('3 answers');
    expect(commentsText(0)).toBe('0 comments');
    expect(commentsText(1)).toBe('1 comment');
    expect(commentsText(12)).toBe('12 comments');
    expect(COMMENT_REFRESH_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('COMMENT-21: the buttons shown on a comment follow the server\'s rules: like others only, report others (not the owner), moderate only what the role may', () => {
    const signedOut = { signedIn: false, role: 'player' as const };
    const player = { signedIn: true, role: 'player' as const };
    const mod = { signedIn: true, role: 'moderator' as const };
    const owner = { signedIn: true, role: 'owner' as const };
    const line = (role: 'player' | 'moderator' | 'owner', mine = false) => ({ role, mine });
    // Like: a signed-in player, never on his own comment.
    expect(canLikeComment(line('player'), signedOut)).toBe(false);
    expect(canLikeComment(line('player'), player)).toBe(true);
    expect(canLikeComment(line('player', true), player)).toBe(false);
    // Report: players report players and moderators; never their own, never the owner's. Staff act on players instead of reporting them; a moderator can report another moderator.
    expect(canReportComment(line('player'), signedOut)).toBe(false);
    expect(canReportComment(line('player'), player)).toBe(true);
    expect(canReportComment(line('moderator'), player)).toBe(true);
    expect(canReportComment(line('owner'), player)).toBe(false);
    expect(canReportComment(line('player', true), player)).toBe(false);
    expect(canReportComment(line('player'), mod)).toBe(false);
    expect(canReportComment(line('moderator'), mod)).toBe(true);
    expect(canReportComment(line('owner'), mod)).toBe(false);
    expect(canReportComment(line('player'), owner)).toBe(false);
    expect(canReportComment(line('moderator'), owner)).toBe(false);
    // Moderate: a moderator works on ordinary players only, the owner on everybody else, a player on nobody.
    expect(canModerateComment(line('player'), player)).toBe(false);
    expect(canModerateComment(line('player'), signedOut)).toBe(false);
    expect(canModerateComment(line('player'), mod)).toBe(true);
    expect(canModerateComment(line('moderator'), mod)).toBe(false);
    expect(canModerateComment(line('owner'), mod)).toBe(false);
    expect(canModerateComment(line('player', true), mod)).toBe(false);
    expect(canModerateComment(line('moderator'), owner)).toBe(true);
    expect(canModerateComment(line('player'), owner)).toBe(true);
    expect(canModerateComment(line('owner', true), owner)).toBe(false);
  });

  it('COMMENT-22: older pages are added under the newest page without repeating or leaving a comment out of order; a like only changes that comment', () => {
    expect(joinPages([item(9), item(8)], [item(5), item(4)]).map((c) => c.id)).toEqual([9, 8, 5, 4]);
    // The newest page moved on: older comments the newest page now shows are not shown twice.
    expect(joinPages([item(9), item(8), item(7)], [item(8), item(7), item(5)]).map((c) => c.id)).toEqual([9, 8, 7, 5]);
    expect(joinPages([], [item(3)]).map((c) => c.id)).toEqual([3]);
    expect(joinPages([item(2)], []).map((c) => c.id)).toEqual([2]);
    const liked = withLike(item(4, [6]), true, 3);
    expect([liked.liked, liked.likes, liked.replies.map((r) => r.id)]).toEqual([true, 3, [6]]);
  });
});

describe('Comment screens: the browser only asks and shows', () => {
  it('COMMENT-23: a comment is shown as plain text (never as HTML), nothing is stored in the browser, and only api.ts talks to the server', () => {
    for (const file of [...SCREENS, 'src/shared/commentsUtil.ts']) {
      const text = code(read(file));
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|\beval\(/);
      expect(text, file).not.toMatch(/localStorage|sessionStorage/);
      expect(text, file).not.toMatch(/\bfetch\(/);
      expect(text, file).not.toMatch(/Math\.random|from '\.\.\/server/);
    }
    // The text box shows what the server will keep: its limit comes from the server's answer.
    const panel = code(read('src/shared/CommentsPanel.tsx'));
    expect(panel).toMatch(/view\?\.limits\.maxLength/);
    // A comment's words are placed as text children, links are never made.
    expect(panel).not.toMatch(/<a\b|href=/);
    expect(code(read('src/shared/RecentComments.tsx'))).not.toMatch(/<a\b|href=/);
  });

  it('COMMENT-24: the panel sits under the chart of every company page, the recent list on the Market and Memecoins tabs, and the reports on the admin Chat tab; the routes match the server', () => {
    const company = read('src/shared/CompanyView.tsx');
    expect(company).toMatch(/<CommentsPanel ticker=\{detail\.ticker\} \/>/);
    expect(company.indexOf('<CommentsPanel')).toBeGreaterThan(company.indexOf('chart-card'));
    expect(company.indexOf('<CommentsPanel')).toBeLessThan(company.indexOf('about-card'));
    const app = read('src/shared/SharedApp.tsx');
    expect(app).toMatch(/<RecentComments onOpen=\{openCompany\} \/>/);
    expect(app.indexOf('<RecentComments')).toBeGreaterThan(app.indexOf('<MarketScreen'));
    const admin = read('src/shared/AdminChat.tsx');
    for (const word of ['api.adminComments()', 'api.adminCommentDelete', 'api.adminCommentDismiss', 'Reported comments']) expect(admin).toContain(word);
    expect(read('src/shared/AdminLog.tsx')).toMatch(/case 'comment_delete':[\s\S]*case 'comment_dismiss':/);
    const api = read('src/shared/api.ts');
    for (const path of ['/api/comments/${enc(ticker)}', '/api/comments/recent', '/api/comments/post', '/api/comments/like', '/api/comments/report', '/api/comments/delete', '/api/admin/comments', '/api/admin/comments/delete', '/api/admin/comments/dismiss']) expect(api).toContain(path);
    // Muting the writer and banning him from the chat use the chat tools (they stop comments too).
    expect(read('src/shared/CommentsPanel.tsx')).toMatch(/api\.adminChatMute[\s\S]*api\.adminChatBan/);
  });

  it('COMMENT-26: the Recent comments list shows a Delete button to the owner only, asks once, sends the owner route with a fresh request id, then reads the list again', () => {
    const list = code(read('src/shared/RecentComments.tsx'));
    expect(list).toMatch(/const isOwner = user\?\.role === 'owner';/);
    // Both the button and the question are behind the owner check; a moderator or a player sees neither.
    expect(list).toMatch(/\{isOwner && asking !== c\.id && \(/);
    expect(list).toMatch(/\{isOwner && asking === c\.id && \(/);
    expect(list).not.toMatch(/moderator/);
    expect(list).toContain('Delete this comment?');
    expect(list).toContain('Yes, delete it');
    expect(list).toMatch(/api\.adminCommentDelete\(\{ requestId: newRequestId\(\), commentId: id \}\)/);
    // After the request (done, refused, or "that comment is gone") the list is read again; the answer of the server is shown as it is.
    expect(list).toMatch(/finally \{[\s\S]{0,120}await load\(\);/);
    expect(list).toMatch(/problemText\(e\)/);
    for (const id of ['recent-delete-${c.id}', 'recent-delete-yes-${c.id}', 'recent-delete-no-${c.id}', 'recent-comments-note']) expect(list).toContain(id);
    // Nothing is removed from the list by the screen itself.
    expect(list).not.toMatch(/setItems\(\(?[a-z]*\)? ?=>/);
    expect(list).not.toMatch(/\.filter\(/);
  });

  it('COMMENT-25: every class the comment screens use has a rule in styles.css, and the company page has a grid place for the panel on the wide and the narrow layout', () => {
    const css = read('src/styles.css');
    const used = new Set<string>();
    for (const file of [...SCREENS, 'src/shared/AdminChat.tsx']) {
      const text = read(file);
      for (const m of text.matchAll(/className=(?:"([^"]+)"|'([^']+)')/g)) for (const c of ((m[1] ?? m[2]) as string).split(/\s+/)) used.add(c);
      for (const m of text.matchAll(/className=\{`([^`]+)`\}/g)) for (const c of (m[1] as string).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (c) used.add(c);
      for (const m of text.matchAll(/className=\{([^}`]*)\}/g)) for (const q of (m[1] as string).matchAll(/'([A-Za-z][A-Za-z0-9_ -]*)'/g)) for (const c of (q[1] as string).split(/\s+/)) if (c) used.add(c);
    }
    const missing = [...used].filter((c) => c && !new RegExp(`\\.${c.replace(/[-]/g, '\\-')}(?![a-zA-Z0-9_-])`).test(css));
    expect(missing).toEqual([]);
    expect(css).toMatch(/\.company-layout > \.comments-card \{\s*grid-area: comments;/);
    expect(css).toMatch(/'chart side'\s*'comments side'\s*'about side'/);
    // On a phone the trade panel comes before the comments.
    expect(css).toMatch(/'chart'\s*'side'\s*'comments'\s*'about'/);
  });
});
