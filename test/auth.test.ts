import { describe, it, expect } from 'vitest';
import {
	__identityOf as identityOf,
	parseScopedInstanceId,
	parseServiceTokenOwners,
	scopedInstanceId,
} from '../src/lib/auth';

describe('identityOf', () => {
	it('resolves an interactive login to its lowercased email', () => {
		expect(identityOf({ email: 'Me@Example.com' })).toEqual({ userId: 'usr:me@example.com', isService: false });
	});

	it('keeps an unlinked service token in its own namespace', () => {
		expect(identityOf({ common_name: 'tok.access', sub: '' })).toEqual({
			userId: 'svc:tok.access',
			isService: true,
		});
	});

	/**
	 * The point of SERVICE_TOKEN_OWNERS: the Android app (service token) and
	 * the browser (email login) of the same person must resolve to the SAME
	 * userId, or they hold disjoint conversation lists.
	 */
	it('folds a linked service token into its owner’s email identity', () => {
		const links = parseServiceTokenOwners('{"tok.access": "Me@Example.com"}');
		const phone = identityOf({ common_name: 'tok.access', sub: '' }, links);
		const browser = identityOf({ email: 'me@example.com' });
		expect(phone?.userId).toBe(browser?.userId);
		expect(phone?.isService).toBe(true);
	});

	it('does not let an unlisted token borrow a link', () => {
		const links = parseServiceTokenOwners('{"tok.access": "me@example.com"}');
		expect(identityOf({ common_name: 'other.access' }, links)?.userId).toBe('svc:other.access');
	});
});

describe('parseServiceTokenOwners', () => {
	it.each([undefined, '', '   ', 'not json', '[]', '"x"', 'null'])('links nothing for %j', (raw) => {
		expect(parseServiceTokenOwners(raw).size).toBe(0);
	});

	it('drops entries that are not emails', () => {
		const links = parseServiceTokenOwners('{"a": "x@y.z", "b": 5, "c": "nope", " ": "q@r.s"}');
		expect([...links.entries()]).toEqual([['a', 'x@y.z']]);
	});
});

describe('parseScopedInstanceId', () => {
	it('inverts scopedInstanceId', () => {
		const p = { userId: 'usr:a@b.c', owner: 'f'.repeat(32), isService: false };
		expect(parseScopedInstanceId(scopedInstanceId(p, 'conv-1'))).toEqual({
			owner: 'f'.repeat(32),
			conversationId: 'conv-1',
		});
	});

	it.each(['', 'noseparator', '~leading', 'trailing~'])('rejects %j', (name) => {
		expect(parseScopedInstanceId(name)).toBeNull();
	});
});
